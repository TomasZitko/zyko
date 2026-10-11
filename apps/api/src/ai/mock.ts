import type { Block, ChatProvider, ChatRequest, ChatResult } from "./provider.js";

/**
 * Deterministic development/test provider. It is NOT an AI: it proves the infrastructure
 * (streaming, persistence, context injection, tool calling, approvals) without network access.
 *   "/tool <name> <json>"  → emits a tool call
 *   after tool results     → summarizes them
 *   anything else          → echoes the project context it was given
 */
export const mockProvider: ChatProvider = {
  id: "mock",
  model: "mock-1",
  async stream(req: ChatRequest, onText): Promise<ChatResult> {
    const last = req.messages[req.messages.length - 1];
    const lastText = last.content.filter((b) => b.type === "text").map((b) => (b as any).text).join("\n").trim();
    const results = last.content.filter((b) => b.type === "tool_result") as Extract<Block, { type: "tool_result" }>[];
    const emit = async (text: string): Promise<Block[]> => {
      for (const chunk of text.match(/.{1,24}/gs) ?? []) {
        onText(chunk);
        await new Promise((r) => setTimeout(r, 1));
      }
      return [{ type: "text", text }];
    };
    const usage = { inputTokens: Math.ceil(JSON.stringify(req).length / 4), outputTokens: 0 };
    if (results.length) {
      const text = results.map((r) => `${r.isError ? "Failed" : "Done"}: ${r.content.slice(0, 300)}`).join("\n");
      const content = await emit(text);
      return { content, stopReason: "end_turn", usage: { ...usage, outputTokens: Math.ceil(text.length / 4) }, model: this.model };
    }
    const m = lastText.match(/^\/tool\s+([a-z_]+)\s*([\s\S]*)$/);
    if (m) {
      let input: unknown = {};
      try { input = m[2] ? JSON.parse(m[2]) : {}; } catch { input = { _raw: m[2] }; }
      const pre = await emit(`Calling ${m[1]}.`);
      return { content: [...pre, { type: "tool_use", id: `toolu_mock_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: m[1], input }], stopReason: "tool_use", usage, model: this.model };
    }
    const project = req.system.match(/^Project name: (.*)$/m)?.[1] ?? "unknown";
    const desc = req.system.match(/^Description: (.*)$/m)?.[1];
    const prior = req.messages.filter((x) => x.role === "user" && x.content.some((b) => b.type === "text")).length - 1;
    const text = `[mock provider] Project "${project}"${desc ? ` — ${desc}` : ""}. Earlier user messages in this conversation: ${prior}. You said: "${lastText.slice(0, 200)}"`;
    const content = await emit(text);
    return { content, stopReason: "end_turn", usage: { ...usage, outputTokens: Math.ceil(text.length / 4) }, model: this.model };
  },
};
