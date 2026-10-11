import { useState } from "react";
import { api, errorText } from "../lib/api";
import { useApi } from "../lib/hooks";
import { ErrorBox, Loading, Section, fmtDate } from "../components/ui";

export default function Admin() {
  const o = useApi<any>("/api/admin/overview");
  const users = useApi<{ users: any[] }>("/api/admin/users");
  const flags = useApi<{ flags: any[] }>("/api/admin/flags");
  const [err, setErr] = useState<string | null>(null);
  const [flagKey, setFlagKey] = useState("");
  const act = async (fn: () => Promise<unknown>, after: () => void) => { try { await fn(); after(); } catch (e) { setErr(errorText(e)); } };
  if (o.error) return <ErrorBox error={o.error} />;
  if (!o.data) return <Loading />;
  return (
    <div className="stack">
      <h1>Platform admin</h1>
      <ErrorBox error={err} />
      <div className="grid">{Object.entries(o.data.counts).map(([k, v]) => <div key={k} className="card"><div className="muted small">{k}</div><div style={{ fontSize: 24, fontWeight: 600 }}>{String(v)}</div></div>)}</div>
      <Section title="Registry">
        <ul className="small">{o.data.registry.designSystems.map((d: any) => <li key={d.id}>Design system {d.id}@{d.version} ({d.status}, {d.components} components)</li>)}{o.data.registry.modules.map((m: any) => <li key={m.id}>Module {m.id}@{m.version}</li>)}</ul>
      </Section>
      <Section title="Jobs">
        <p className="small">{o.data.jobs.map((j: any) => `${j.status}: ${j.n}`).join(" · ") || "No jobs"}</p>
        {o.data.failedJobs.map((j: any) => <div key={j.id} className="row small"><span className="mono">{j.type}</span><span className="muted">{j.lastError}</span><button className="btn sm" onClick={() => act(() => api(`/api/admin/jobs/${j.id}/retry`, { body: {} }), o.reload)}>Retry</button></div>)}
      </Section>
      <Section title="Feature flags">
        <ul className="small">{flags.data?.flags.map((f) => <li key={f.key}>{f.key}: {f.enabledGlobally ? "on" : `orgs ${f.orgIds.length}, plans ${f.plans.join(",") || "-"}`}</li>)}</ul>
        <form className="row" onSubmit={(e) => { e.preventDefault(); void act(() => api(`/api/admin/flags/${encodeURIComponent(flagKey)}`, { method: "PUT", body: { enabledGlobally: true } }), () => { setFlagKey(""); flags.reload(); }); }}>
          <input aria-label="Flag key" placeholder="flag.key" value={flagKey} onChange={(e) => setFlagKey(e.target.value)} style={{ width: 240 }} /><button className="btn sm" disabled={!flagKey}>Enable globally</button>
        </form>
      </Section>
      <Section title="Users">
        <table><thead><tr><th>Email</th><th>Name</th><th>Created</th><th /></tr></thead><tbody>
          {users.data?.users.map((u) => <tr key={u.id}><td>{u.email}{u.isPlatformAdmin && " (admin)"}</td><td>{u.name}</td><td className="small">{fmtDate(u.createdAt)}</td>
            <td><button className="btn sm" onClick={() => act(() => api(`/api/admin/users/${u.id}/disable`, { body: { disabled: !u.disabledAt } }), users.reload)}>{u.disabledAt ? "Enable" : "Disable"}</button></td></tr>)}
        </tbody></table>
      </Section>
    </div>
  );
}
