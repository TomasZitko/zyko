// Registers every job handler (import side effects) and runs periodic maintenance.
import "./lib/platform.js";
import "./services/publishing.js";
import "./services/domains.js";
import "./services/modules.js";
import { sql } from "drizzle-orm";
import { db } from "./db/client.js";
import { sweepPendingDomains } from "./services/domains.js";
import { reportError } from "./lib/logger.js";

let timer: NodeJS.Timeout | null = null;
export function startScheduler() {
  const tick = async () => {
    try {
      await sweepPendingDomains();
      await db.execute(sql`delete from sessions where expires_at < now()`);
      await db.execute(sql`delete from jobs where status = 'succeeded' and finished_at < now() - interval '7 days'`);
      await db.execute(sql`delete from auth_tokens where expires_at < now() - interval '7 days'`);
    } catch (e) {
      reportError(e, { where: "scheduler" });
    }
  };
  timer = setInterval(tick, 10 * 60_000);
  void tick();
}
export const stopScheduler = () => timer && clearInterval(timer);
