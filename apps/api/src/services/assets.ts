import { and, eq, inArray, isNull } from "drizzle-orm";
import type { ResolvedAsset } from "@zyko/contracts";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { unprocessable } from "../lib/errors.js";
import { sha256, signResource } from "../lib/crypto.js";
import { storage } from "../lib/storage.js";
import { assertStorageAvailable } from "./entitlements.js";

/**
 * Secure upload processing: type is detected from magic bytes (the client's Content-Type and
 * extension are ignored), only an allow-list of formats is accepted, SVG/HTML are rejected
 * (script vectors), filenames are sanitized, and files are stored under opaque keys.
 */
const TYPES: { mime: string; ext: string; kind: "image" | "video" | "document"; test: (b: Buffer) => boolean }[] = [
  { mime: "image/png", ext: "png", kind: "image", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/jpeg", ext: "jpg", kind: "image", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/gif", ext: "gif", kind: "image", test: (b) => b.subarray(0, 6).toString("ascii") === "GIF89a" || b.subarray(0, 6).toString("ascii") === "GIF87a" },
  { mime: "image/webp", ext: "webp", kind: "image", test: (b) => b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP" },
  { mime: "image/avif", ext: "avif", kind: "image", test: (b) => b.subarray(4, 12).toString("ascii") === "ftypavif" },
  { mime: "video/mp4", ext: "mp4", kind: "video", test: (b) => b.subarray(4, 8).toString("ascii") === "ftyp" && !b.subarray(8, 12).toString("ascii").startsWith("avi") },
  { mime: "application/pdf", ext: "pdf", kind: "document", test: (b) => b.subarray(0, 5).toString("ascii") === "%PDF-" },
];

export function sniff(buf: Buffer) {
  return TYPES.find((t) => t.test(buf)) ?? null;
}

export function imageSize(b: Buffer, mime: string): { width: number; height: number } | null {
  try {
    if (mime === "image/png") return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (mime === "image/gif") return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (mime === "image/webp") {
      const chunk = b.subarray(12, 16).toString("ascii");
      if (chunk === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      if (chunk === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (chunk === "VP8L") { const v = b.readUInt32LE(21); return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }; }
    }
    if (mime === "image/jpeg") {
      let i = 2;
      while (i < b.length) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1];
        const len = b.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        i += 2 + len;
      }
    }
  } catch { /* fallthrough */ }
  return null;
}

export const sanitizeFilename = (n: string) => n.normalize("NFKC").replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "file";

export async function storeAsset(o: { orgId: string; projectId: string; userId: string; filename: string; data: Buffer; alt?: string; tags?: string[] }) {
  if (o.data.length === 0) throw unprocessable("Empty file");
  if (o.data.length > env.MAX_UPLOAD_MB * 1024 * 1024) throw unprocessable(`File exceeds ${env.MAX_UPLOAD_MB} MB`);
  const t = sniff(o.data);
  if (!t) throw unprocessable("Unsupported or unrecognized file type. Allowed: PNG, JPEG, GIF, WebP, AVIF, MP4, PDF.");
  await assertStorageAvailable(o.orgId, o.data.length);
  const id = crypto.randomUUID();
  const key = `assets/${o.orgId}/${id}.${t.ext}`;
  const dims = t.kind === "image" ? imageSize(o.data, t.mime) : null;
  if (dims && (dims.width > 20000 || dims.height > 20000)) throw unprocessable("Image dimensions too large");
  await storage.put(key, o.data, t.mime);
  const [row] = await db.insert(schema.assets).values({
    id, orgId: o.orgId, projectId: o.projectId, storageKey: key, filename: sanitizeFilename(o.filename), mime: t.mime, kind: t.kind,
    size: o.data.length, sha256: sha256(o.data), width: dims?.width ?? null, height: dims?.height ?? null, alt: o.alt?.slice(0, 300) ?? null,
    tags: (o.tags ?? []).map((x) => x.slice(0, 40)).slice(0, 20), createdBy: o.userId,
    metadata: { originalName: o.filename.slice(0, 200) },
  }).returning();
  return row;
}

export type AssetRow = typeof schema.assets.$inferSelect;

export function publicAsset(a: AssetRow, apiBase = "") {
  const { exp, sig } = signResource(`asset:${a.id}`);
  return {
    id: a.id, filename: a.filename, mime: a.mime, kind: a.kind, size: a.size, width: a.width, height: a.height, alt: a.alt, tags: a.tags,
    createdAt: a.createdAt, url: `${apiBase}/api/assets/${a.id}/raw?exp=${exp}&sig=${sig}`,
  };
}

export async function projectAssets(projectId: string, ids?: string[]) {
  const where = [eq(schema.assets.projectId, projectId), isNull(schema.assets.deletedAt)];
  if (ids) {
    const valid = ids.filter((i) => /^[0-9a-f-]{36}$/i.test(i));
    if (!valid.length) return [];
    where.push(inArray(schema.assets.id, valid));
  }
  return db.select().from(schema.assets).where(and(...where));
}

export const toResolved = (a: AssetRow, url: string): ResolvedAsset => ({ id: a.id, url, alt: a.alt ?? "", width: a.width, height: a.height, mime: a.mime });
