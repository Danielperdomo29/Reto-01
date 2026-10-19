import {
  ChatMessage,
  LLMAdapter,
  LLMResponse,
  ToolCallRequest,
  ToolDefinition,
} from "./adapter.js";

interface OpenRouterToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string | Record<string, unknown>;
  };
}

interface OpenRouterChoice {
  message?: {
    role: string;
    content: string | null;
    tool_calls?: OpenRouterToolCall[];
  };
}

interface OpenRouterResponse {
  choices?: OpenRouterChoice[];
  usage?: {
    total_tokens?: number;
  };
  error?: {
    message?: string;
    code?: number;
  };
}

interface GeminiCandidate {
  content?: {
    parts?: Array<{
      text?: string;
      functionCall?: {
        name: string;
        args?: Record<string, unknown>;
      };
    }>;
  };
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    totalTokenCount?: number;
  };
  error?: {
    message?: string;
    code?: number;
  };
}

export class UnifiedLLMAdapter implements LLMAdapter {
  public readonly providerName: string;
  public modelName: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor() {
    const preferred = (process.env.LLM_PROVIDER || "").toLowerCase();
    if (preferred === "openrouter" || process.env.OPENROUTER_API_KEY) {
      this.providerName = "openrouter";
      this.modelName =
        process.env.OPENROUTER_MODEL || "nvidia/nemotron-3-super-120b-a12b:free";
      this.apiKey = process.env.OPENROUTER_API_KEY || "";
    } else if (
      preferred === "openai" ||
      (!process.env.GEMINI_API_KEY && process.env.OPENAI_API_KEY)
    ) {
      this.providerName = "openai";
      this.modelName = process.env.OPENAI_MODEL || "gpt-4o-mini";
      this.apiKey = process.env.OPENAI_API_KEY || "";
    } else {
      this.providerName = "gemini";
      this.modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash";
      this.apiKey = process.env.GEMINI_API_KEY || "";
    }
    this.timeoutMs = Number(process.env.LLM_TIMEOUT_MS || 90000);
  }

  async enviar(
    mensajes: ChatMessage[],
    herramientas: ToolDefinition[]
  ): Promise<LLMResponse> {
    if (!this.apiKey) {
      throw new Error(
        `No se encontró API Key configurada para el proveedor '${this.providerName}'. Configura OPENROUTER_API_KEY, GEMINI_API_KEY u OPENAI_API_KEY en tu archivo .env.`
      );
    }

    if (this.providerName === "openrouter" || this.providerName === "openai") {
      return this.enviarOpenAICompatible(mensajes, herramientas);
    }
    return this.enviarGemini(mensajes, herramientas);
  }

  private async ejecutarRequestOpenAI(
    endpoint: string,
    headers: Record<string, string>,
    model: string,
    oaMessages: Array<Record<string, unknown>>,
    herramientas: ToolDefinition[]
  ): Promise<LLMResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          temperature: 0.1,
          messages: oaMessages,
          tools: herramientas.map((h) => ({
            type: "function",
            function: {
              name: h.name,
              description: h.description,
              parameters: h.parameters,
            },
          })),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        let parsedMessage = errText;
        try {
          const parsedJson = JSON.parse(errText) as { error?: { message?: string } };
          if (parsedJson.error?.message) parsedMessage = parsedJson.error.message;
        } catch {
          // conservar texto si no es json
        }

        if (res.status === 401) {
          throw new Error(`Credenciales inválidas en el proveedor ${this.providerName}. Verifica la clave de API.`);
        }
        if (res.status === 404) {
          throw new Error(`MODEL_UNAVAILABLE: El modelo '${model}' no se encuentra disponible (${parsedMessage}).`);
        }
        if (res.status === 429) {
          throw new Error(`Límite de tasa alcanzado en ${this.providerName}. Espera unos segundos antes del siguiente turno.`);
        }
        throw new Error(`Error del proveedor ${this.providerName} (${res.status}): ${parsedMessage}`);
      }

      const data = (await res.json()) as OpenRouterResponse;
      const choice = data.choices?.[0]?.message;
      const toolCalls: ToolCallRequest[] = (choice?.tool_calls || []).map(
        (tc: OpenRouterToolCall) => ({
          id: tc.id,
          name: tc.function.name,
          arguments:
            typeof tc.function.arguments === "string"
              ? (JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>)
              : (tc.function.arguments as Record<string, unknown>) || {},
        })
      );

      return {
        content: choice?.content || "",
        toolCalls,
        usage: { totalTokens: data.usage?.total_tokens || 0 },
      };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(
          `Tiempo de espera agotado (${Math.round(this.timeoutMs / 1000)}s): El proveedor de IA tardó demasiado en responder.`
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async enviarOpenAICompatible(
    mensajes: ChatMessage[],
    herramientas: ToolDefinition[]
  ): Promise<LLMResponse> {
    const oaMessages: Array<Record<string, unknown>> = mensajes.map((m) => {
      if (m.role === "tool") {
        return {
          role: "tool",
          tool_call_id: m.toolCallId || "call_0",
          content: m.content,
        };
      }
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        };
      }
      return { role: m.role, content: m.content };
    });

    const endpoint =
      this.providerName === "openrouter"
        ? "https://openrouter.ai/api/v1/chat/completions"
        : "https://api.openai.com/v1/chat/completions";

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };

    if (this.providerName === "openrouter") {
      headers["HTTP-Referer"] = "https://periferia-itgroup.com";
      headers["X-Title"] = "Periferia Agente Registro Proveedor";
    }

    try {
      return await this.ejecutarRequestOpenAI(
        endpoint,
        headers,
        this.modelName,
        oaMessages,
        herramientas
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        this.providerName === "openrouter" &&
        msg.includes("MODEL_UNAVAILABLE") &&
        this.modelName !== "nvidia/nemotron-3-super-120b-a12b:free"
      ) {
        const fallback = "nvidia/nemotron-3-super-120b-a12b:free";
        console.warn(`[LLM] Modelo '${this.modelName}' no disponible. Reintentando con '${fallback}'...`);
        this.modelName = fallback;
        return await this.ejecutarRequestOpenAI(
          endpoint,
          headers,
          fallback,
          oaMessages,
          herramientas
        );
      }
      throw err;
    }
  }

  private async enviarGemini(
    mensajes: ChatMessage[],
    herramientas: ToolDefinition[]
  ): Promise<LLMResponse> {
    const systemMsg = mensajes.find((m) => m.role === "system");
    const contents: Array<Record<string, unknown>> = [];

    for (const m of mensajes) {
      if (m.role === "system") continue;
      if (m.role === "user") {
        contents.push({ role: "user", parts: [{ text: m.content }] });
      } else if (m.role === "assistant") {
        const parts: Array<Record<string, unknown>> = [];
        if (m.content) parts.push({ text: m.content });
        if (m.toolCalls && m.toolCalls.length > 0) {
          for (const tc of m.toolCalls) {
            parts.push({
              functionCall: { name: tc.name, args: tc.arguments },
            });
          }
        }
        if (parts.length > 0) contents.push({ role: "model", parts });
      } else if (m.role === "tool") {
        let parsedResp: unknown = m.content;
        try {
          parsedResp = JSON.parse(m.content);
        } catch {
          parsedResp = { raw: m.content };
        }
        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: m.toolName || "tool",
                response: parsedResp,
              },
            },
          ],
        });
      }
    }

    const body: Record<string, unknown> = {
      contents,
      generationConfig: { temperature: 0.1 },
    };

    if (systemMsg) {
      body.systemInstruction = { parts: [{ text: systemMsg.content }] };
    }

    if (herramientas.length > 0) {
      body.tools = [
        {
          functionDeclarations: herramientas.map((h) => ({
            name: h.name,
            description: h.description,
            parameters: h.parameters,
          })),
        },
      ];
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelName}:generateContent?key=${this.apiKey}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(
          `Error del proveedor Gemini (${res.status}): ${errText}`
        );
      }

      const data = (await res.json()) as GeminiResponse;
      const candidate = data.candidates?.[0];
      const parts = candidate?.content?.parts || [];

      let textContent = "";
      const toolCalls: ToolCallRequest[] = [];

      for (const part of parts) {
        if (part.text) textContent += part.text;
        if (part.functionCall) {
          toolCalls.push({
            id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name: part.functionCall.name,
            arguments: part.functionCall.args || {},
          });
        }
      }

      const totalTokens = data.usageMetadata?.totalTokenCount || 0;
      return { content: textContent, toolCalls, usage: { totalTokens } };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(
          `Tiempo de espera agotado (${Math.round(this.timeoutMs / 1000)}s): Gemini tardó demasiado en responder.`
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
