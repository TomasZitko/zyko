import { mkdir, readFile, rm, stat, writeFile, readdir, rename } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { env } from "../env.js";

/**
 * Object storage abstraction. Local filesystem driver for development and single-node deployments;
 * an S3-compatible driver implements the same interface (see docs/DEPLOYMENT.md).
 */
export interface Storage {
  put(key: string, data: Buffer | string, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,500}$/;
export function assertKey(key: string) {
  if (!KEY_RE.test(key) || key.includes("..") || key.includes("//")) throw new Error(`Invalid storage key: ${key}`);
}

export class LocalStorage implements Storage {
  private root: string;
  constructor(dir: string) {
    this.root = resolve(dir);
  }
  private path(key: string) {
    assertKey(key);
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new Error("Storage path escape");
    return p;
  }
  async put(key: string, data: Buffer | string) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, p); // atomic replace
  }
  async get(key: string) {
    try {
      return await readFile(this.path(key));
    } catch (e: any) {
      if (e.code === "ENOENT" || e.code === "EISDIR") return null;
      throw e;
    }
  }
  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
  async deletePrefix(prefix: string) {
    await rm(this.path(prefix.replace(/\/$/, "")), { recursive: true, force: true });
  }
  async exists(key: string) {
    try {
      return (await stat(this.path(key))).isFile();
    } catch {
      return false;
    }
  }
  async list(prefix: string): Promise<string[]> {
    const base = this.path(prefix.replace(/\/$/, ""));
    const out: string[] = [];
    const walk = async (d: string, rel: string) => {
      for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
        if (e.isDirectory()) await walk(join(d, e.name), `${rel}${e.name}/`);
        else out.push(`${rel}${e.name}`);
      }
    };
    await walk(base, "");
    return out;
  }
}

export const storage: Storage = new LocalStorage(env.STORAGE_DIR);
