import { useState } from "react";
import { api, errorText } from "../lib/api";
import { useApi } from "../lib/hooks";
import { ErrorBox, Loading, Section, StatusBadge } from "../components/ui";

/** Module catalogue + schema-driven admin pages. Modules contribute declarations, never UI code. */
export default function Modules({ projectId }: { projectId: string }) {
  const m = useApi<{ modules: any[] }>(`/api/projects/${projectId}/modules`);
  const [err, setErr] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ url: string; secret: string } | null>(null);
  const act = async (fn: () => Promise<any>) => { setErr(null); try { const r = await fn(); await m.reload(); return r; } catch (e) { setErr(errorText(e)); } };
  if (!m.data) return m.error ? <ErrorBox error={m.error} /> : <Loading />;
  return (
    <div className="stack">
      <p className="small muted">Only test fixtures are registered at this stage. Business modules will be added through the module framework.</p>
      <ErrorBox error={err} />
      {secret && <div className="alert ok small">Webhook URL: <span className="mono">{location.origin}{secret.url}</span><br />Signing secret (shown once): <span className="mono">{secret.secret}</span></div>}
      {m.data.modules.map((mod) => (
        <Section key={mod.id} title={`${mod.name} · v${mod.version}`} actions={mod.installation ? <StatusBadge status={mod.installation.status} /> : null}>
          <p className="small">{mod.description}</p>
          <p className="small muted">Capabilities: {mod.capabilities.join(", ")}</p>
          {!mod.installation ? (
            <button className="btn primary" disabled={!mod.available} onClick={() => act(async () => { const r = await api(`/api/projects/${projectId}/modules`, { body: { moduleId: mod.id, config: {} } }); setSecret({ url: r.webhookUrl, secret: r.webhookSecret }); })}>
              {mod.available ? "Install" : "Not available on your plan"}
            </button>
          ) : (
            <>
              <div className="row">
                {mod.installation.upgradeAvailable && <button className="btn" onClick={() => act(() => api(`/api/module-installations/${mod.installation.id}/upgrade`, { body: {} }))}>Upgrade to {mod.version}</button>}
                <button className="btn danger" onClick={() => confirm("Uninstall and delete this module's data?") && act(() => api(`/api/module-installations/${mod.installation.id}`, { method: "DELETE" }))}>Uninstall</button>
              </div>
              {mod.adminPages.map((p: any) => <AdminPage key={p.id} page={p} inst={mod.installation} onSaved={m.reload} />)}
            </>
          )}
        </Section>
      ))}
    </div>
  );
}

function AdminPage({ page, inst, onSaved }: { page: any; inst: any; onSaved: () => void }) {
  if (page.view.kind === "settings") return <SettingsView inst={inst} onSaved={onSaved} title={page.title} />;
  return <RecordsView inst={inst} view={page.view} title={page.title} />;
}

function SettingsView({ inst, onSaved, title }: { inst: any; onSaved: () => void; title: string }) {
  const [json, setJson] = useState(JSON.stringify(inst.config, null, 2));
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setErr(null);
    try { await api(`/api/module-installations/${inst.id}`, { method: "PATCH", body: { config: JSON.parse(json) } }); onSaved(); } catch (e) { setErr(errorText(e)); }
  };
  return (
    <details><summary>{title}</summary>
      <div className="stack"><label className="sr-only" htmlFor={`cfg-${inst.id}`}>Configuration</label><textarea id={`cfg-${inst.id}`} className="mono" value={json} onChange={(e) => setJson(e.target.value)} /><ErrorBox error={err} /><button className="btn sm" onClick={save}>Save settings</button></div>
    </details>
  );
}

function RecordsView({ inst, view, title }: { inst: any; view: any; title: string }) {
  const r = useApi<{ records: any[] }>(`/api/module-installations/${inst.id}/records/${view.collection}`);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); await r.reload(); } catch (e) { setErr(errorText(e)); } };
  return (
    <details open><summary>{title}</summary>
      <table><thead><tr>{view.columns.map((c: any) => <th key={c.key}>{c.label}</th>)}<th /></tr></thead>
        <tbody>{r.data?.records.map((rec) => (
          <tr key={rec.id}>{view.columns.map((c: any) => <td key={c.key}>{String(rec.data[c.key] ?? "")}</td>)}
            <td>{view.allowDelete && <button className="btn sm danger" onClick={() => act(() => api(`/api/module-installations/${inst.id}/records/${view.collection}/${rec.id}`, { method: "DELETE" }))}>Delete</button>}</td></tr>
        ))}</tbody>
      </table>
      {view.allowCreate && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void act(() => api(`/api/module-installations/${inst.id}/records/${view.collection}`, { body: Object.fromEntries(Object.entries(draft).filter(([k]) => k !== "source")) })).then(() => setDraft({})); }}>
          {view.columns.filter((c: any) => c.key !== "source").map((c: any) => <input key={c.key} aria-label={c.label} placeholder={c.label} value={draft[c.key] ?? ""} onChange={(e) => setDraft({ ...draft, [c.key]: e.target.value })} style={{ width: 200 }} />)}
          <button className="btn sm">Add</button>
        </form>
      )}
      <ErrorBox error={err} />
    </details>
  );
}
