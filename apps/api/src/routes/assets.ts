import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { body, requireUser, router } from "../http.js";
import { db, schema } from "../db/client.js";
import { notFound, unprocessable } from "../lib/errors.js";
import { verifyResource } from "../lib/crypto.js";
import { storage } from "../lib/storage.js";
import { rateLimit } from "../lib/rate-limit.js";
import { requireProject } from "../services/access.js";
import { projectAssets, publicAsset, storeAsset } from "../services/assets.js";
import { env } from "../env.js";

export const assetRoutes = router();

assetRoutes.get("/projects/:projectId/assets", async (c) => {
  const u = requireUser(c);
  const { project } = await requireProject(u.id, c.req.param("projectId"));
  const rows = await projectAssets(project.id);
  return c.json({ assets: rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map((a) => publicAsset(a)) });
});

assetRoutes.post("/projects/:projectId/assets", rateLimit("upload", 60, 60_000), async (c) => {
  const u = requireUser(c);
  const { project } = await requireProject(u.id, c.req.param("projectId"), "editor");
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > (env.MAX_UPLOAD_MB + 1) * 1024 * 1024) throw unprocessable(`File exceeds ${env.MAX_UPLOAD_MB} MB`);
  const form = await c.req.parseBody();
  const file = form["file"];
  if (!(file instanceof File)) throw unprocessable("Expected multipart field 'file'");
  const data = Buffer.from(await file.arrayBuffer());
  const asset = await storeAsset({
    orgId: project.orgId, projectId: project.id, userId: u.id, filename: file.name, data,
    alt: typeof form["alt"] === "string" ? form["alt"] : undefined,
    tags: typeof form["tags"] === "string" ? form["tags"].split(",").map((t) => t.trim()).filter(Boolean) : [],
  });
  return c.json({ asset: publicAsset(asset) }, 201);
});

assetRoutes.patch("/assets/:id", async (c) => {
  const u = requireUser(c);
  const [a] = await db.select().from(schema.assets).where(and(eq(schema.assets.id, c.req.param("id")), isNull(schema.assets.deletedAt)));
  if (!a) throw notFound("Asset");
  await requireProject(u.id, a.projectId, "editor");
  const input = await body(c, z.object({ alt: z.string().max(300).optional(), tags: z.array(z.string().max(40)).max(20).optional(), metadata: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean()])).optional() }));
  const [up] = await db.update(schema.assets).set({ ...input, metadata: input.metadata ? { ...(a.metadata as object), ...input.metadata } : a.metadata }).where(eq(schema.assets.id, a.id)).returning();
  return c.json({ asset: publicAsset(up) });
});

assetRoutes.delete("/assets/:id", async (c) => {
  const u = requireUser(c);
  const [a] = await db.select().from(schema.assets).where(and(eq(schema.assets.id, c.req.param("id")), isNull(schema.assets.deletedAt)));
  if (!a) throw notFound("Asset");
  await requireProject(u.id, a.projectId, "editor");
  // Soft delete: published deployments keep their own copy; drafts referencing it render empty.
  await db.update(schema.assets).set({ deletedAt: new Date() }).where(eq(schema.assets.id, a.id));
  return c.json({ ok: true });
});

/** File access: either a valid session with project access, or a signed URL (editor canvas). */
assetRoutes.get("/assets/:id/raw", async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Asset");
  const [a] = await db.select().from(schema.assets).where(and(eq(schema.assets.id, id), isNull(schema.assets.deletedAt)));
  if (!a) throw notFound("Asset");
  const exp = Number(c.req.query("exp") ?? 0), sig = c.req.query("sig") ?? "";
  if (!(sig && verifyResource(`asset:${a.id}`, exp, sig))) {
    const u = requireUser(c);
    await requireProject(u.id, a.projectId);
  }
  const data = await storage.get(a.storageKey);
  if (!data) throw notFound("Asset file");
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": a.mime, "Content-Length": String(data.length), "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": a.kind === "document" ? `attachment; filename="${a.filename}"` : "inline",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  });
});
