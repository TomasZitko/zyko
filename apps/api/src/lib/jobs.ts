import { and, eq, sql } from "drizzle-orm";
import { hostname } from "node:os";
import { db, schema } from "../db/client.js";
import { log, metrics, reportError } from "./logger.js";

/**
 * Postgres-backed job queue (FOR UPDATE SKIP LOCKED). Survives restarts, supports retries with
 * exponential backoff, run_at scheduling and de-duplication keys. Run workers with `pnpm worker`
 * or inline in the API process (WORKER_INLINE=true) for development.
 */
type Handler = (payload: any, job: { id: string; attempts: number }) => Promise<void>;
const handlers = new Map<string, Handler>();
const workerId = `${hostname()}:${process.pid}`;

export function registerJob(type: string, handler: Handler) {
  handlers.set(type, handler);
}

export async function enqueue(type: string, payload: object, opts: { runAt?: Date; dedupeKey?: string; maxAttempts?: number } = {}) {
  const [row] = await db
    .insert(schema.jobs)
    .values({ type, payload, runAt: opts.runAt ?? new Date(), dedupeKey: opts.dedupeKey, maxAttempts: opts.maxAttempts ?? 5 })
    .onConflictDoNothing()
    .returning({ id: schema.jobs.id });
  if (row) wake();
  return row?.id ?? null;
}

async function claim() {
  const rows = await db.execute<{ id: string; type: string; payload: unknown; attempts: number; max_attempts: number }>(sql`
    update jobs set status='running', locked_at=now(), locked_by=${workerId}, attempts=attempts+1
    where id = (select id from jobs where status='queued' and run_at <= now() order by run_at limit 1 for update skip locked)
    returning id, type, payload, attempts, max_attempts`);
  return rows[0] ?? null;
}

export async function runOne(): Promise<boolean> {
  const job = await claim();
  if (!job) return false;
  const h = handlers.get(job.type);
  const started = Date.now();
  try {
    if (!h) throw new Error(`No handler for job type ${job.type}`);
    await h(job.payload, { id: job.id, attempts: job.attempts });
    await db.update(schema.jobs).set({ status: "succeeded", finishedAt: new Date(), lastError: null }).where(eq(schema.jobs.id, job.id));
    metrics.inc("zyko_jobs_total", { type: job.type, result: "ok" });
  } catch (err) {
    const final = job.attempts >= job.max_attempts;
    reportError(err, { job: job.id, type: job.type, attempt: job.attempts });
    const backoff = Math.min(3600, 2 ** job.attempts * 5);
    await db.update(schema.jobs).set({
      status: final ? "failed" : "queued",
      lastError: String((err as Error).message ?? err).slice(0, 2000),
      runAt: final ? undefined : new Date(Date.now() + backoff * 1000),
      finishedAt: final ? new Date() : null,
    }).where(eq(schema.jobs.id, job.id));
    metrics.inc("zyko_jobs_total", { type: job.type, result: final ? "failed" : "retry" });
  }
  metrics.observe("zyko_job_duration_ms", Date.now() - started);
  return true;
}

/** Drains all currently-runnable jobs (used by tests and the inline worker). */
export async function runUntilEmpty(max = 500) {
  let n = 0;
  while (n < max && (await runOne())) n++;
  return n;
}

let running = false;
let timer: NodeJS.Timeout | null = null;
let wakeResolver: (() => void) | null = null;
function wake() {
  wakeResolver?.();
}

export function startWorker(pollMs = 1000) {
  if (running) return;
  running = true;
  log.info("job worker started", { workerId });
  const loop = async () => {
    while (running) {
      try {
        const did = await runOne();
        if (did) continue;
      } catch (e) {
        reportError(e, { where: "worker loop" });
      }
      await new Promise<void>((r) => {
        wakeResolver = r;
        timer = setTimeout(r, pollMs);
      });
    }
  };
  // Recover jobs whose worker died mid-run.
  db.update(schema.jobs).set({ status: "queued" })
    .where(and(eq(schema.jobs.status, "running"), sql`locked_at < now() - interval '10 minutes'`))
    .catch((e) => reportError(e))
    .finally(() => void loop());
}
export function stopWorker() {
  running = false;
  if (timer) clearTimeout(timer);
  wake();
}
