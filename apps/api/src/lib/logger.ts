import { env } from "../env.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 } as const;
type Level = Exclude<keyof typeof LEVELS, "silent">;
const min = LEVELS[env.LOG_LEVEL];

function write(level: Level, msg: string, data?: object) {
  if (LEVELS[level] < min) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...data });
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}

export const log = {
  debug: (m: string, d?: object) => write("debug", m, d),
  info: (m: string, d?: object) => write("info", m, d),
  warn: (m: string, d?: object) => write("warn", m, d),
  error: (m: string, d?: object) => write("error", m, d),
  child: (base: object) => ({
    debug: (m: string, d?: object) => write("debug", m, { ...base, ...d }),
    info: (m: string, d?: object) => write("info", m, { ...base, ...d }),
    warn: (m: string, d?: object) => write("warn", m, { ...base, ...d }),
    error: (m: string, d?: object) => write("error", m, { ...base, ...d }),
  }),
};

/** Error reporting hook. Wire Sentry (or similar) here; see docs/OPERATIONS.md. */
export function reportError(err: unknown, context: object = {}) {
  const e = err as Error;
  log.error(e?.message ?? String(err), { ...context, stack: e?.stack?.split("\n").slice(0, 6).join(" | ") });
}

/** Minimal in-process metrics, exposed in Prometheus text format at /metrics. */
const counters = new Map<string, number>();
const hist = new Map<string, number[]>();
export const metrics = {
  inc(name: string, labels: Record<string, string> = {}, by = 1) {
    const k = name + JSON.stringify(labels);
    counters.set(k, (counters.get(k) ?? 0) + by);
  },
  observe(name: string, ms: number) {
    const arr = hist.get(name) ?? [];
    arr.push(ms);
    if (arr.length > 2000) arr.shift();
    hist.set(name, arr);
  },
  render(): string {
    const lines: string[] = [];
    for (const [k, v] of counters) {
      const i = k.indexOf("{");
      const labels = JSON.parse(k.slice(i)) as Record<string, string>;
      const l = Object.entries(labels).map(([a, b]) => `${a}="${b}"`).join(",");
      lines.push(`${k.slice(0, i)}${l ? `{${l}}` : ""} ${v}`);
    }
    for (const [k, arr] of hist) {
      const s = [...arr].sort((a, b) => a - b);
      const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
      lines.push(`${k}{quantile="0.5"} ${q(0.5).toFixed(2)}`, `${k}{quantile="0.95"} ${q(0.95).toFixed(2)}`, `${k}_count ${s.length}`);
    }
    return lines.join("\n") + "\n";
  },
};
