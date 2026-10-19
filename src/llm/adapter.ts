export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ToolCallRequest[];
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export interface LLMResponse {
  content: string;
  toolCalls: ToolCallRequest[];
  usage?: {
    totalTokens: number;
  };
}

export interface LLMAdapter {
  readonly providerName: string;
  readonly modelName: string;
  enviar(
    mensajes: ChatMessage[],
    herramientas: ToolDefinition[]
  ): Promise<LLMResponse>;
}
