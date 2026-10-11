import { z } from "zod";
import { and, asc, desc, eq } from "drizzle-orm";
import { streamSSE } from "hono/streaming";
import { body, requireUser, router } from "../http.js";
import { db, schema } from "../db/client.js";
import { conflict, notFound } from "../lib/errors.js";
import { checkRate } from "../lib/rate-limit.js";
import { requireProject, requireWebsiteForProject } from "../services/access.js";
import { assertAiMessageAllowed } from "../services/entitlements.js";
import { decideTask, runTurn, type StreamEvent } from "../ai/orchestrator.js";
import type { Block } from "../ai/provider.js";

export const aiRoutes = router();

const visible = (blocks: Block[]) => blocks.filter((b) => b.type !== "raw");

aiRoutes.get("/projects/:projectId/conversations", async (c) => {
  const u = requireUser(c);
  const { project } = await requireProject(u.id, c.req.param("projectId"));
  return c.json({ conversations: await db.select().from(schema.conversations).where(eq(schema.conversations.projectId, project.id)).orderBy(desc(schema.conversations.updatedAt)) });
});

aiRoutes.post("/projects/:projectId/conversations", async (c) => {
  const u = requireUser(c);
  const { project } = await requireProject(u.id, c.req.param("projectId"), "editor");
  const { title } = await body(c, z.object({ title: z.string().min(1).max(200).default("New conversation") }));
  const [conv] = await db.insert(schema.conversations).values({ orgId: project.orgId, projectId: project.id, title, createdBy: u.id }).returning();
  return c.json({ conversation: conv }, 201);
});

async function loadConversation(userId: string, id: string, min: "viewer" | "editor" = "viewer") {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Conversation");
  const [conv] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, id));
  if (!conv) throw notFound("Conversation");
  const access = await requireProject(userId, conv.projectId, min);
  return { conv, ...access };
}

aiRoutes.get("/conversations/:id", async (c) => {
  const u = requireUser(c);
  const { conv } = await loadConversation(u.id, c.req.param("id"));
  const msgs = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conv.id)).orderBy(asc(schema.messages.createdAt));
  const tasks = await db.select().from(schema.aiTasks).where(eq(schema.aiTasks.conversationId, conv.id)).orderBy(asc(schema.aiTasks.createdAt));
  return c.json({ conversation: conv, messages: msgs.map((m) => ({ ...m, content: visible(m.content as Block[]) })), tasks });
});

/** Sends a user message and streams the assistant's response as Server-Sent Events. */
aiRoutes.post("/conversations/:id/messages", async (c) => {
  const u = requireUser(c);
  const { conv, project, role } = await loadConversation(u.id, c.req.param("id"), "editor");
  const { text } = await body(c, z.object({ text: z.string().min(1).max(8000) }));
  checkRate(`ai:${u.id}`, 20, 60_000);
  checkRate(`ai-org:${project.orgId}`, 120, 60_000);
  await assertAiMessageAllowed(project.orgId);
  const website = await requireWebsiteForProject(project.id);
  return streamSSE(c, async (stream) => {
    const ac = new AbortController();
    stream.onAbort(() => ac.abort());
    await runTurn({
      conversation: conv, project, website, userId: u.id, role, text, signal: ac.signal,
      emit: async (e: StreamEvent) => { if (!ac.signal.aborted) await stream.writeSSE({ event: e.type, data: JSON.stringify(e) }); },
    });
  });
});

aiRoutes.get("/projects/:projectId/ai-tasks", async (c) => {
  const u = requireUser(c);
  const { project } = await requireProject(u.id, c.req.param("projectId"));
  const status = c.req.query("status");
  const where = status ? and(eq(schema.aiTasks.projectId, project.id), eq(schema.aiTasks.status, status as any)) : eq(schema.aiTasks.projectId, project.id);
  return c.json({ tasks: await db.select().from(schema.aiTasks).where(where).orderBy(desc(schema.aiTasks.createdAt)).limit(100) });
});

aiRoutes.post("/ai-tasks/:id/:decision{approve|reject}", async (c) => {
  const u = requireUser(c);
  const id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Task");
  const [task] = await db.select().from(schema.aiTasks).where(eq(schema.aiTasks.id, id));
  if (!task) throw notFound("Task");
  const { project, role } = await requireProject(u.id, task.projectId, "editor");
  if (task.status !== "awaiting_approval") throw conflict("This task is not awaiting approval");
  // Claim atomically so double-clicks cannot run it twice.
  const claimed = await db.update(schema.aiTasks).set({ status: "running" }).where(and(eq(schema.aiTasks.id, id), eq(schema.aiTasks.status, "awaiting_approval"))).returning();
  if (!claimed.length) throw conflict("This task was already decided");
  const website = await requireWebsiteForProject(project.id);
  const outcome = await decideTask(task, c.req.param("decision") as "approve" | "reject", { userId: u.id, role, project, website });
  const [updated] = await db.select().from(schema.aiTasks).where(eq(schema.aiTasks.id, id));
  return c.json({ task: updated, outcome });
});
