import { useEffect, useState } from "react";
import { api, errorText } from "../lib/api";
import { useApi } from "../lib/hooks";
import { ErrorBox, Field, Loading, Section, StatusBadge, fmtDate } from "../components/ui";

export default function Publish({ projectId }: { projectId: string }) {
  const deps = useApi<{ liveUrl: string | null; siteUrl: string; deployments: any[] }>(`/api/projects/${projectId}/deployments`);
  const seo = useApi<{ issues: any[] }>(`/api/projects/${projectId}/seo`);
  const [err, setErr] = useState<string | null>(null);
  const busy = deps.data?.deployments.some((d) => d.status === "queued" || d.status === "building");
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => deps.reload(), 1000);
    return () => clearInterval(t);
  }, [busy, deps]);
  const deploy = async (kind: "preview" | "production") => {
    setErr(null);
    try { await api(`/api/projects/${projectId}/deployments`, { body: { kind } }); await deps.reload(); } catch (e) { setErr(errorText(e)); }
  };
  const rollback = async (id: string) => { try { await api(`/api/projects/${projectId}/deployments/${id}/rollback`, { body: {} }); await deps.reload(); } catch (e) { setErr(errorText(e)); } };
  if (!deps.data) return deps.error ? <ErrorBox error={deps.error} /> : <Loading />;
  const latestPreview = deps.data.deployments.find((d) => d.kind === "preview" && d.status === "ready");
  return (
    <div className="stack">
      <Section title="Publishing">
        <p>Live address: {deps.data.liveUrl ? <a href={deps.data.liveUrl} target="_blank" rel="noreferrer" data-testid="live-url">{deps.data.liveUrl}</a> : <span className="muted">not published ({deps.data.siteUrl})</span>}</p>
        <div className="row">
          <button className="btn" onClick={() => deploy("preview")} disabled={busy}>Build preview</button>
          <button className="btn primary" onClick={() => deploy("production")} disabled={busy}>Publish</button>
          {busy && <span className="muted small" role="status">Building…</span>}
          {latestPreview && <a href={latestPreview.url} target="_blank" rel="noreferrer" data-testid="preview-url">Open latest preview</a>}
        </div>
        <ErrorBox error={err} />
      </Section>
      {seo.data && seo.data.issues.length > 0 && (
        <Section title="Search readiness">
          <ul className="small">{seo.data.issues.map((i, k) => <li key={k}><span className={`badge ${i.level === "error" ? "err" : "warn"}`}>{i.level}</span> <span className="mono">{i.path}</span> {i.message}</li>)}</ul>
        </Section>
      )}
      <Section title="Deployments">
        <table>
          <thead><tr><th>When</th><th>Type</th><th>Status</th><th>Pages</th><th /></tr></thead>
          <tbody>
            {deps.data.deployments.map((d) => (
              <tr key={d.id}>
                <td className="small">{fmtDate(d.createdAt)}</td>
                <td>{d.kind}{d.isLive && <span className="badge ok" style={{ marginLeft: 6 }}>live</span>}</td>
                <td><StatusBadge status={d.status} />{d.error && <div className="small" style={{ color: "var(--danger)" }}>{d.error}</div>}</td>
                <td className="small">{d.pages.map((p: any) => `${p.path} v${p.version}`).join(", ")}</td>
                <td className="row">
                  {d.kind === "production" && d.status === "ready" && !d.isLive && <button className="btn sm" onClick={() => rollback(d.id)}>Restore this version</button>}
                  {d.url && <a className="btn sm" href={d.url} target="_blank" rel="noreferrer">Open</a>}
                  <details className="small"><summary>Log</summary><pre className="mono" style={{ whiteSpace: "pre-wrap" }}>{(d.log ?? []).join("\n")}</pre></details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Domains projectId={projectId} />
    </div>
  );
}

function Domains({ projectId }: { projectId: string }) {
  const d = useApi<{ domains: any[] }>(`/api/projects/${projectId}/domains`);
  const [host, setHost] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); await d.reload(); } catch (e) { setErr(errorText(e)); } };
  return (
    <Section title="Custom domains">
      <form className="row" onSubmit={(e) => { e.preventDefault(); void act(() => api(`/api/projects/${projectId}/domains`, { body: { hostname: host } })).then(() => setHost("")); }}>
        <Field label="Domain"><input value={host} onChange={(e) => setHost(e.target.value)} placeholder="www.example.com" /></Field>
        <button className="btn" style={{ alignSelf: "end" }} disabled={!host}>Add domain</button>
      </form>
      <ErrorBox error={err} />
      {d.data?.domains.map((dom) => (
        <div key={dom.id} className="card stack">
          <div className="row spread"><strong>{dom.hostname}</strong><StatusBadge status={dom.status} /></div>
          {dom.status !== "verified" && <>
            <p className="small">Add these DNS records at your DNS provider, then verify. HTTPS is provisioned automatically after verification.</p>
            <table className="small"><thead><tr><th>Type</th><th>Name</th><th>Value</th></tr></thead><tbody>{dom.dns.map((r: any) => <tr key={r.type}><td>{r.type}</td><td className="mono">{r.name}</td><td className="mono">{r.value}</td></tr>)}</tbody></table>
            {dom.lastError && <p className="small muted">Last check: {dom.lastError}</p>}
          </>}
          <div className="row">
            {dom.status !== "verified" && <button className="btn sm" onClick={() => act(() => api(`/api/projects/${projectId}/domains/${dom.id}/verify`, { body: {} }))}>Verify now</button>}
            <button className="btn sm danger" onClick={() => act(() => api(`/api/projects/${projectId}/domains/${dom.id}`, { method: "DELETE" }))}>Remove</button>
          </div>
        </div>
      ))}
    </Section>
  );
}
