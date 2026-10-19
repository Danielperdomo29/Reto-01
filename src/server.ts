import "dotenv/config";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { proveedorTools } from "./tools/proveedor.js";
import { ChatMessage, ToolDefinition } from "./llm/adapter.js";
import { UnifiedLLMAdapter } from "./llm/provider.js";

const directory = process.cwd();
const PORT = Number(process.env.PORT || 3000);
const MAX_ITERATIONS = Number(process.env.MAX_ITERATIONS_PER_TURN || 25);
const MAX_TOKENS_SESSION = Number(process.env.MAX_TOKENS_PER_SESSION || 60000);

const llmAdapter = new UnifiedLLMAdapter();

interface ToolCallTrace {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  ok: boolean;
}

interface SessionState {
  id: string;
  messages: ChatMessage[];
  toolCallHistory: ToolCallTrace[];
  awaitingConfirmationForCase: string | null;
  totalTokensUsed: number;
}

const sessions = new Map<string, SessionState>();

function loadSystemPrompt(): string {
  const promptPath = path.join(directory, "agent", "prompt.md");
  const knowledgePath = path.join(
    directory,
    "src",
    "knowledge",
    "registro-proveedor.md"
  );
  const prompt = fs.existsSync(promptPath)
    ? fs.readFileSync(promptPath, "utf8")
    : "";
  const knowledge = fs.existsSync(knowledgePath)
    ? fs.readFileSync(knowledgePath, "utf8")
    : "";
  return `${prompt}\n\n---\n\n${knowledge}`;
}

function buildToolDefinitions(): ToolDefinition[] {
  return Object.entries(proveedorTools).map(([name, tool]) => {
    const properties: Record<string, { type: string; description: string }> = {};
    const required: string[] = [];

    for (const [argName, zodSchema] of Object.entries(tool.args)) {
      const schemaAny = zodSchema as z.ZodTypeAny;
      const isOptional = schemaAny.isOptional();
      if (!isOptional) required.push(argName);

      let type = "string";
      const defType = (schemaAny._def as any)?.innerType?._def?.typeName || (schemaAny._def as any)?.typeName;
      if (defType === "ZodBoolean") type = "boolean";
      else if (defType === "ZodArray") type = "array";
      else if (defType === "ZodRecord" || defType === "ZodObject") type = "object";

      properties[argName] = {
        type,
        description: schemaAny.description || argName,
      };
    }

    return {
      name,
      description: tool.description,
      parameters: {
        type: "object",
        properties,
        required,
      },
    };
  });
}

function isUserMessageExplicitConfirmation(msg: string): boolean {
  const norm = msg.trim().toLowerCase();
  if (norm.includes("no env") || norm.includes("todavia no") || norm.includes("todavía no") || norm.includes("cancel")) {
    return false;
  }
  return /\b(si|sí|confirmo|confirmar|envia|envía|enviar|adelante|procede|apruebo|ok)\b/i.test(norm);
}

async function runAgentTurn(session: SessionState, userMessage: string) {
  const toolDefs = buildToolDefinitions();
  const userConfirmedThisTurn = isUserMessageExplicitConfirmation(userMessage);
  const turnToolCalls: ToolCallTrace[] = [];

  session.messages.push({ role: "user", content: userMessage });

  if (session.totalTokensUsed > MAX_TOKENS_SESSION) {
    return {
      reply: `Se alcanzó el límite de tokens configurado para esta sesión (${MAX_TOKENS_SESSION}). Inicia una nueva sesión para continuar.`,
      toolCalls: [],
      needsConfirmation: false,
    };
  }

  let iterations = 0;
  let finalReply = "";
  let needsConfirmation = false;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await llmAdapter.enviar(session.messages, toolDefs);
    session.totalTokensUsed += response.usage?.totalTokens || 0;

    if (!response.toolCalls || response.toolCalls.length === 0) {
      finalReply = response.content;
      session.messages.push({ role: "assistant", content: finalReply });
      break;
    }

    session.messages.push({
      role: "assistant",
      content: response.content || "",
      toolCalls: response.toolCalls,
    });

    for (const tc of response.toolCalls) {
      const toolObj = (proveedorTools as Record<string, any>)[tc.name];
      if (!toolObj) {
        const errPayload = { ok: false, error: `Herramienta desconocida: ${tc.name}` };
        session.messages.push({
          role: "tool",
          toolCallId: tc.id,
          toolName: tc.name,
          content: JSON.stringify(errPayload),
        });
        continue;
      }

      // Guardia RN4 / CA3: Si el modelo intenta llamar proveedor_simular_envio sin que el humano haya confirmado en este turno
      if (tc.name === "proveedor_simular_envio" && !userConfirmedThisTurn) {
        const blockedPayload = {
          ok: false,
          error:
            "RN4: No se puede ejecutar proveedor_simular_envio sin confirmación explícita del usuario en el turno actual.",
        };
        turnToolCalls.push({
          name: tc.name,
          args: tc.arguments,
          result: blockedPayload,
          ok: false,
        });
        session.messages.push({
          role: "tool",
          toolCallId: tc.id,
          toolName: tc.name,
          content: JSON.stringify(blockedPayload),
        });
        needsConfirmation = true;
        continue;
      }

      const rawResultStr = await toolObj.execute(tc.arguments, {
        directory,
        sessionId: session.id,
      });
      let parsedResult: any = { ok: false };
      try {
        parsedResult = JSON.parse(rawResultStr);
      } catch {
        parsedResult = { ok: false, error: rawResultStr };
      }

      if (tc.name === "proveedor_armar_paquete" && parsedResult.ok) {
        session.awaitingConfirmationForCase = String(tc.arguments.caso || "");
        needsConfirmation = true;
      }
      if (tc.name === "proveedor_simular_envio" && parsedResult.ok) {
        session.awaitingConfirmationForCase = null;
        needsConfirmation = false;
      }

      const trace: ToolCallTrace = {
        name: tc.name,
        args: tc.arguments,
        result: parsedResult,
        ok: Boolean(parsedResult.ok),
      };
      turnToolCalls.push(trace);
      session.toolCallHistory.push(trace);

      session.messages.push({
        role: "tool",
        toolCallId: tc.id,
        toolName: tc.name,
        content: rawResultStr,
      });
    }
  }

  if (iterations >= MAX_ITERATIONS && !finalReply) {
    finalReply = `Se alcanzó el tope máximo de ${MAX_ITERATIONS} iteraciones por turno (CA1). Hasta el momento se ejecutaron ${turnToolCalls.length} llamadas a herramientas.`;
    session.messages.push({ role: "assistant", content: finalReply });
  }

  if (
    finalReply.includes("?") &&
    (finalReply.toLowerCase().includes("confirmas") ||
      finalReply.toLowerCase().includes("enviar") ||
      finalReply.toLowerCase().includes("envío"))
  ) {
    needsConfirmation = true;
  }

  return {
    reply: finalReply,
    toolCalls: turnToolCalls,
    needsConfirmation,
  };
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  // GET /api/health (Sección 6.4: sin exponer claves)
  if (req.method === "GET" && url.pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        provider: llmAdapter.providerName,
        model: llmAdapter.modelName,
      })
    );
    return;
  }

  // GET /api/sessions/:id
  if (req.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
    const id = url.pathname.replace("/api/sessions/", "");
    const session = sessions.get(id);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        data: session || { id, messages: [], toolCallHistory: [] },
      })
    );
    return;
  }

  // POST /api/chat
  if (req.method === "POST" && url.pathname === "/api/chat") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { sessionId = "default-session", message = "" } = JSON.parse(
          body || "{}"
        );
        if (!message.trim()) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "El mensaje está vacío." }));
          return;
        }

        let session = sessions.get(sessionId);
        if (!session) {
          session = {
            id: sessionId,
            messages: [{ role: "system", content: loadSystemPrompt() }],
            toolCallHistory: [],
            awaitingConfirmationForCase: null,
            totalTokensUsed: 0,
          };
          sessions.set(sessionId, session);
        }

        const result = await runAgentTurn(session, message);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (err) {
        // CA5: Error claro en el chat sin tumbar la sesión
        const errorMsg =
          err instanceof Error ? err.message : "Error inesperado en el servidor";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            reply: `No fue posible completar la consulta con el proveedor LLM: ${errorMsg}`,
            toolCalls: [],
            needsConfirmation: false,
          })
        );
      }
    });
    return;
  }

  // Servir Frontend (web/index.html)
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const htmlPath = path.join(directory, "web", "index.html");
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(htmlPath, "utf8"));
      return;
    }
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "Ruta no encontrada" }));
});

server.listen(PORT, () => {
  console.log(
    `Servidor Agente Registro Proveedor activo en http://localhost:${PORT} [${llmAdapter.providerName} / ${llmAdapter.modelName}]`
  );
});
