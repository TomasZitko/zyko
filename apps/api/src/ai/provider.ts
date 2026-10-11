/**
 * Provider-neutral chat model abstraction. Conversations are persisted in this format;
 * adapters translate to each vendor's wire format.
 */
export type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean }
  /** Opaque provider-native content kept for exact replay (e.g. thinking blocks). Never shown to users. */
  | { type: "raw"; provider: string; model: string; content: unknown };

export interface ChatMessage { role: "user" | "assistant"; content: Block[] }
export interface ToolSpec { name: string; description: string; inputSchema: Record<string, unknown> }

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxTokens: number;
  signal?: AbortSignal;
}
export interface ChatResult {
  content: Block[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal";
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

export interface ChatProvider {
  id: string;
  model: string;
  stream(req: ChatRequest, onText: (delta: string) => void): Promise<ChatResult>;
}

export class ProviderError extends Error {
  constructor(message: string, public retryable: boolean, public status?: number) {
    super(message);
  }
}

/** Retries retryable failures with exponential backoff — only while no output has been streamed. */
export async function withRetry(provider: ChatProvider, req: ChatRequest, onText: (d: string) => void, attempts = 3): Promise<ChatResult> {
  let streamed = false;
  for (let i = 0; ; i++) {
    try {
      return await provider.stream(req, (d) => { streamed = true; onText(d); });
    } catch (e) {
      const retryable = e instanceof ProviderError ? e.retryable : true;
      if (!retryable || streamed || i >= attempts - 1 || req.signal?.aborted) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
}
