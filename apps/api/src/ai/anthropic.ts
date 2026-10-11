import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env.js";
import { ProviderError, type Block, type ChatMessage, type ChatProvider, type ChatRequest, type ChatResult } from "./provider.js";

/**
 * Claude adapter (official SDK). Requires ANTHROPIC_API_KEY; not exercised in CI.
 * Assistant turns are replayed from the stored provider-native content when available so
 * thinking blocks are passed back unchanged.
 */
function toWire(messages: ChatMessage[], model: string): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    const raw = m.content.find((b) => b.type === "raw" && b.provider === "anthropic" && b.model === model) as Extract<Block, { type: "raw" }> | undefined;
    let content: any[];
    if (m.role === "assistant" && raw) content = raw.content as any[];
    else content = m.content.flatMap((b): any[] => {
      if (b.type === "text") return b.text ? [{ type: "text", text: b.text }] : [];
      if (b.type === "tool_use") return [{ type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} }];
      if (b.type === "tool_result") return [{ type: "tool_result", tool_use_id: b.toolUseId, content: b.content, is_error: b.isError ?? false }];
      return [];
    });
    if (!content.length) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) (prev.content as any[]).push(...content); // merge consecutive same-role turns
    else out.push({ role: m.role, content });
  }
  return out;
}

export function anthropicProvider(): ChatProvider {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0 });
  const model = env.AI_MODEL;
  return {
    id: "anthropic",
    model,
    async stream(req: ChatRequest, onText): Promise<ChatResult> {
      try {
        const stream = client.messages.stream({
          model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: toWire(req.messages, model),
          tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Tool.InputSchema })),
          output_config: { effort: "medium" },
        } as Anthropic.MessageStreamParams, { signal: req.signal });
        stream.on("text", (d) => onText(d));
        const msg = await stream.finalMessage();
        const content: Block[] = [];
        for (const b of msg.content) {
          if (b.type === "text") content.push({ type: "text", text: b.text });
          else if (b.type === "tool_use") content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
        }
        content.push({ type: "raw", provider: "anthropic", model, content: msg.content });
        const stop = msg.stop_reason === "tool_use" ? "tool_use" : msg.stop_reason === "max_tokens" ? "max_tokens" : (msg.stop_reason as string) === "refusal" ? "refusal" : "end_turn";
        return { content, stopReason: stop, usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens }, model: msg.model };
      } catch (e) {
        if (e instanceof Anthropic.RateLimitError) throw new ProviderError("AI provider rate limited", true, 429);
        if (e instanceof Anthropic.InternalServerError) throw new ProviderError("AI provider error", true, 500);
        if (e instanceof Anthropic.APIConnectionError) throw new ProviderError("AI provider unreachable", true);
        if (e instanceof Anthropic.APIError) throw new ProviderError(`AI provider rejected the request: ${e.message}`, false, e.status);
        throw e;
      }
    },
  };
}
