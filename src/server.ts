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
const MAX_GLOBAL_TOKENS = Number(process.env.MAX_GLOBAL_TOKENS || 500000);
let globalTokensUsed = 0;

const ipRequestMap = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = ipRequestMap.get(ip);
  if (!entry || now > entry.resetAt) {
    ipRequestMap.set(ip, { count: 1, resetAt: now + 60000 });
    return true;
  }
  if (entry.count >= 30) return false;
  entry.count++;
  return true;
}

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
    const properties: Record<string, { type: string; description: string; items?: { type: string }; additionalProperties?: boolean }> = {};
    const required: string[] = [];

    for (const [argName, zodSchema] of Object.entries(tool.args)) {
      const schemaAny = zodSchema as z.ZodTypeAny;
      if (!schemaAny.isOptional()) required.push(argName);

      const typeName = schemaAny._def?.typeName;
      if (typeName === "ZodBoolean") {
        properties[argName] = { type: "boolean", description: schemaAny.description || argName };
      } else if (typeName === "ZodArray") {
        properties[argName] = {
          type: "array",
          items: { type: "string" },
          description: schemaAny.description || argName,
        };
      } else if (typeName === "ZodRecord" || typeName === "ZodObject") {
        properties[argName] = {
          type: "object",
          additionalProperties: true,
          description: schemaAny.description || argName,
        };
      } else {
        properties[argName] = { type: "string", description: schemaAny.description || argName };
      }
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

  if (globalTokensUsed > MAX_GLOBAL_TOKENS) {
    return {
      reply: `Se alcanzó el tope de seguridad presupuestal global (${MAX_GLOBAL_TOKENS} tokens). Comuníquese con el administrador.`,
      toolCalls: [],
      needsConfirmation: false,
    };
  }

  let iterations = 0;
  let finalReply = "";
  let needsConfirmation = false;

  try {
    while (iterations < MAX_ITERATIONS) {
      iterations++;

      const response = await llmAdapter.enviar(session.messages, toolDefs);
      const usedTokens = response.usage?.totalTokens || 0;
      session.totalTokensUsed += usedTokens;
      globalTokensUsed += usedTokens;

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
        const toolObj = (proveedorTools as Record<string, {
          description: string;
          args: Record<string, z.ZodTypeAny>;
          execute: (args: unknown, ctx: { directory: string; sessionId: string }) => Promise<string>;
        }>)[tc.name];

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

        // Guardia RN4 / CA3 Estricta:
        // No se permite enviar sin que previamente se haya armado y presentado el paquete,
        // Y el usuario confirme en un turno posterior explícito.
        if (tc.name === "proveedor_simular_envio") {
          const targetCase = String(tc.arguments.caso || "");
          const armedInSameTurn = turnToolCalls.some((t) => t.name === "proveedor_armar_paquete");
          const validPriorConfirmationState = session.awaitingConfirmationForCase === targetCase;

          if (armedInSameTurn || !validPriorConfirmationState || !userConfirmedThisTurn) {
            const blockedPayload = {
              ok: false,
              error:
                "RN4 / CA3: Violación de guardia de seguridad. Para simular el envío, el paquete debe haberse armado y presentado previamente para revisión del analista, y el usuario debe confirmar explícitamente en un turno independiente.",
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
        }

        const rawResultStr = await toolObj.execute(tc.arguments, {
          directory,
          sessionId: session.id,
        });

        let parsedResult: Record<string, unknown> = { ok: false };
        try {
          parsedResult = JSON.parse(rawResultStr) as Record<string, unknown>;
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
  } catch (turnErr: unknown) {
    const errorMsg = turnErr instanceof Error ? turnErr.message : String(turnErr);
    finalReply = `Aviso del agente: Ocurrió un incidente durante la comunicación con el modelo: ${errorMsg}. Las herramientas ejecutadas hasta el momento han sido preservadas en la auditoría.`;
    session.messages.push({ role: "assistant", content: finalReply });
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

  const clientIp = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "local";
  if (!checkRateLimit(clientIp)) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Límite de peticiones por minuto superado (Rate Limit)." }));
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
        ) as { sessionId?: string; message?: string };

        if (!message || !message.trim()) {
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
      } catch (err: unknown) {
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
