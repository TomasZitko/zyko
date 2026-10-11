import { useId, type ReactNode } from "react";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      {label}
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function ErrorBox({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return <div className="alert error" role="alert">{error}</div>;
}

export function Loading({ what = "Loading" }: { what?: string }) {
  return <p className="muted" role="status" aria-live="polite">{what}…</p>;
}

export function StatusBadge({ status }: { status: string }) {
  const cls = ["ready", "verified", "active", "succeeded"].includes(status) ? "ok" : ["failed", "rejected"].includes(status) ? "err" : "warn";
  return <span className={`badge ${cls}`}>{status}</span>;
}

export function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className="card stack" aria-labelledby={id}>
      <div className="row spread"><h2 id={id}>{title}</h2>{actions}</div>
      {children}
    </section>
  );
}

export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
export const fmtDate = (d: string | Date) => new Date(d).toLocaleString();
