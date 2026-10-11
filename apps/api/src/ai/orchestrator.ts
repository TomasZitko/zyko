import { asc, eq } from "drizzle-orm";
import { env } from "../env.js";
import { db, schema } from "../db/client.js";
import type { Role } from "../db/schema.js";
import { log, metrics, reportError } from "../lib/logger.js";
import { recordUsage } from "../services/entitlements.js";
import { listPages } from "../services/websites.js";
import { anthropicProvider } from "./anthropic.js";
import { mockProvider } from "./mock.js";
import { withRetry, type Block, type ChatMessage, type ChatProvider } from "./provider.js";
import { checkToolRole, toolByName, toolSpecs, type ToolContext } from "./tools.js";

let provider: ChatProvider | null = null;
export function getProvider(): ChatProvider {
  provider ??= env.AI_PROVIDER === "anthropic" ? anthropicProvider() : mockProvider;
  return provider;
}
export function setProvider(p: ChatProvider) {
  provider = p;
}

export type StreamEvent =
  | { type: "message_start"; messageId: string }
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; result: unknown; taskId: string }
  | { type: "approval_required"; taskId: string; name: string; input: unknown }
  | { type: "error"; message: string }
  | { type: "done"; usage: { inputTokens: number; outputTokens: number } };

const HISTORY_LIMIT = 60;

async function systemPrompt(project: typeof schema.projects.$inferSelect, website: typeof schema.websites.$inferSelect) {
  const brief = project.brief as Record<string, any>;
  const pages = await listPages(website.id);
  return [
    "You are the website assistant inside a website-building platform. You work on ONE project, using only the provided tools to read or change structured data.",
    "Rules: make changes through apply_page_changes with the page's current version; inspect before editing; never invent asset ids; publishing requires user approval.",
    "Design generation is handled by a separate engine via request_design_generation; if it is unavailable, say so rather than improvising a design.",
    "",
    `Project name: ${project.name}`,
    `Description: ${brief.description ?? "(none yet)"}`,
    `Brief: ${JSON.stringify(brief)}`,
    `Design system: ${website.designSystemId}@${website.designSystemVersion}`,
    `Pages: ${pages.map((p) => `${p.path} "${p.title}" (id ${p.id}, v${p.version})`).join("; ") || "(none)"}`,
  ].join("\n");
}

async function loadHistory(conversationId: string): Promise<ChatMessage[]> {
  const rows = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId)).orderBy(asc(schema.messages.createdAt));
  let msgs = rows.filter((r) => r.status === "complete").map((r) => ({ role: r.role, content: r.content as Block[] }));
  if (msgs.length > HISTORY_LIMIT) {
    // Cut at a user text turn so tool_use/tool_result pairs are never split.
    let start = msgs.length - HISTORY_LIMIT;
    while (start < msgs.length && !(msgs[start].role === "user" && msgs[start].content.some((b) => b.type === "text"))) start++;
    msgs = msgs.slice(start);
  }
  return msgs;
}

/**
 * Runs one user turn: persist user message → model ↔ tools loop → persist everything.
 * Sensitive tools become ai_tasks awaiting approval instead of executing.
 */
export async function runTurn(o: {
  conversation: typeof schema.conversations.$inferSelect;
  project: typeof schema.projects.$inferSelect;
  website: typeof schema.websites.$inferSelect;
  userId: string;
  role: Role;
  text: string;
  emit: (e: StreamEvent) => void | Promise<void>;
  signal?: AbortSignal;
}) {
  const p = getProvider();
  const totals = { inputTokens: 0, outputTokens: 0 };
  await db.insert(schema.messages).values({ orgId: o.project.orgId, conversationId: o.conversation.id, role: "user", content: [{ type: "text", text: o.text }], userId: o.userId });
  await recordUsage(o.project.orgId, o.userId, "ai.messages", 1, { conversationId: o.conversation.id });
  const started = Date.now();
  try {
    for (let round = 0; round < env.AI_MAX_TOOL_ROUNDS; round++) {
      const [website] = await db.select().from(schema.websites).where(eq(schema.websites.id, o.website.id));
      const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, o.project.id));
      const history = await loadHistory(o.conversation.id);
      const result = await withRetry(p, { system: await systemPrompt(project, website), messages: history, tools: toolSpecs(), maxTokens: 16000, signal: o.signal }, (d) => void o.emit({ type: "text", delta: d }));
      totals.inputTokens += result.usage.inputTokens;
      totals.outputTokens += result.usage.outputTokens;
      const [msg] = await db.insert(schema.messages).values({
        orgId: o.project.orgId, conversationId: o.conversation.id, role: "assistant", content: result.content, provider: p.id, model: result.model, usage: result.usage,
      }).returning({ id: schema.messages.id });
      await o.emit({ type: "message_start", messageId: msg.id });
      if (result.stopReason === "refusal") { await o.emit({ type: "error", message: "The model declined this request." }); break; }
      const calls = result.content.filter((b) => b.type === "tool_use") as Extract<Block, { type: "tool_use" }>[];
      if (result.stopReason !== "tool_use" || !calls.length) break;

      const results: Block[] = [];
      for (const call of calls) {
        await o.emit({ type: "tool_call", id: call.id, name: call.name, input: call.input });
        const r = await executeToolCall({ ...o, website, project }, call);
        results.push({ type: "tool_result", toolUseId: call.id, content: JSON.stringify(r.result).slice(0, 20000), isError: !r.ok });
        if (r.awaitingApproval) await o.emit({ type: "approval_required", taskId: r.taskId, name: call.name, input: call.input });
        else await o.emit({ type: "tool_result", id: call.id, name: call.name, ok: r.ok, result: r.result, taskId: r.taskId });
      }
      await db.insert(schema.messages).values({ orgId: o.project.orgId, conversationId: o.conversation.id, role: "user", content: results });
    }
  } catch (e) {
    reportError(e, { conversation: o.conversation.id });
    await db.insert(schema.messages).values({ orgId: o.project.orgId, conversationId: o.conversation.id, role: "assistant", status: "error", content: [{ type: "text", text: "The assistant ran into an error. Please try again." }] });
    await o.emit({ type: "error", message: (e as Error).message ?? "AI error" });
  } finally {
    await recordUsage(o.project.orgId, o.userId, "ai.input_tokens", totals.inputTokens);
    await recordUsage(o.project.orgId, o.userId, "ai.output_tokens", totals.outputTokens);
    await db.update(schema.conversations).set({ updatedAt: new Date() }).where(eq(schema.conversations.id, o.conversation.id));
    metrics.observe("zyko_ai_turn_ms", Date.now() - started);
  }
  await o.emit({ type: "done", usage: totals });
}

async function executeToolCall(
  o: { project: typeof schema.projects.$inferSelect; website: typeof schema.websites.$inferSelect; conversation: typeof schema.conversations.$inferSelect; userId: string; role: Role },
  call: { id: string; name: string; input: unknown },
): Promise<{ ok: boolean; result: unknown; taskId: string; awaitingApproval?: boolean }> {
  const t = toolByName.get(call.name);
  const base = { orgId: o.project.orgId, projectId: o.project.id, conversationId: o.conversation.id, tool: call.name, toolUseId: call.id, input: (call.input ?? {}) as object, requestedBy: o.userId };
  if (!t) {
    const [task] = await db.insert(schema.aiTasks).values({ ...base, status: "failed", error: "unknown tool" }).returning();
    return { ok: false, result: { error: `Unknown tool ${call.name}` }, taskId: task.id };
  }
  const parsed = t.input.safeParse(call.input ?? {});
  if (!parsed.success) {
    const [task] = await db.insert(schema.aiTasks).values({ ...base, status: "failed", error: "invalid input" }).returning();
    return { ok: false, result: { error: "Invalid tool input", issues: parsed.error.issues.slice(0, 10) }, taskId: task.id };
  }
  try {
    checkToolRole(t, o.role);
  } catch (e) {
    const [task] = await db.insert(schema.aiTasks).values({ ...base, status: "failed", error: "forbidden" }).returning();
    return { ok: false, result: { error: (e as Error).message }, taskId: task.id };
  }
  if (t.sensitive) {
    const [task] = await db.insert(schema.aiTasks).values({ ...base, input: parsed.data, status: "awaiting_approval" }).returning();
    return { ok: true, result: { status: "awaiting_user_approval", taskId: task.id, note: "The user must approve this action in the interface." }, taskId: task.id, awaitingApproval: true };
  }
  const [task] = await db.insert(schema.aiTasks).values({ ...base, input: parsed.data, status: "running" }).returning();
  return runTask(task, { userId: o.userId, role: o.role, project: o.project, website: o.website });
}

export async function runTask(task: typeof schema.aiTasks.$inferSelect, ctx: Omit<ToolContext, "aiTaskId">) {
  const t = toolByName.get(task.tool)!;
  try {
    const result = await t.run({ ...ctx, aiTaskId: task.id }, t.input.parse(task.input));
    await db.update(schema.aiTasks).set({ status: "succeeded", output: (result ?? null) as any, updatedAt: new Date() }).where(eq(schema.aiTasks.id, task.id));
    return { ok: true, result, taskId: task.id };
  } catch (e) {
    const message = (e as any)?.details ? `${(e as Error).message}: ${JSON.stringify((e as any).details).slice(0, 500)}` : (e as Error).message;
    await db.update(schema.aiTasks).set({ status: "failed", error: message, updatedAt: new Date() }).where(eq(schema.aiTasks.id, task.id));
    log.info("ai tool failed", { tool: task.tool, error: message });
    return { ok: false, result: { error: message }, taskId: task.id };
  }
}

/** User decision on a sensitive task. The outcome is appended to the conversation for the model's next turn. */
export async function decideTask(task: typeof schema.aiTasks.$inferSelect, decision: "approve" | "reject", ctx: Omit<ToolContext, "aiTaskId">) {
  let outcome: { ok: boolean; result: unknown };
  if (decision === "reject") {
    await db.update(schema.aiTasks).set({ status: "rejected", decidedBy: ctx.userId, updatedAt: new Date() }).where(eq(schema.aiTasks.id, task.id));
    outcome = { ok: false, result: { rejected: true } };
  } else {
    await db.update(schema.aiTasks).set({ status: "running", decidedBy: ctx.userId, updatedAt: new Date() }).where(eq(schema.aiTasks.id, task.id));
    outcome = await runTask(task, ctx);
  }
  if (task.conversationId) {
    await db.insert(schema.messages).values({
      orgId: task.orgId, conversationId: task.conversationId, role: "user", userId: ctx.userId,
      content: [{ type: "text", text: `[platform] The user ${decision === "approve" ? "approved" : "rejected"} ${task.tool} (task ${task.id}). Result: ${JSON.stringify(outcome.result).slice(0, 2000)}` }],
    });
  }
  return outcome;
}
