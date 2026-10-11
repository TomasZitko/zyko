import { useEffect, useState, lazy } from "react";
import { NavLink, Route, Routes, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAction, useApi } from "../lib/hooks";
import { ErrorBox, Field, Loading, Section, fmtBytes, fmtDate } from "../components/ui";

const Editor = lazy(() => import("./editor"));
const Assistant = lazy(() => import("./assistant"));
const Publish = lazy(() => import("./publish"));
const Modules = lazy(() => import("./modules"));

export default function ProjectLayout() {
  const { projectId } = useParams();
  const p = useApi<{ project: any; role: string }>(`/api/projects/${projectId}`);
  if (p.error) return <ErrorBox error={p.error} />;
  if (!p.data) return <Loading />;
  const base = `/app/p/${projectId}`;
  const tabs = [["", "Overview"], ["editor", "Editor"], ["assistant", "Assistant"], ["assets", "Assets"], ["publish", "Publish"], ["analytics", "Analytics"], ["modules", "Modules"]];
  return (
    <div>
      <div className="row spread"><h1>{p.data.project.name}</h1><span className="badge">{p.data.role}</span></div>
      <nav className="tabs" aria-label="Project">
        {tabs.map(([path, label]) => <NavLink key={path} to={path ? `${base}/${path}` : base} end>{label}</NavLink>)}
      </nav>
      <Routes>
        <Route index element={<Overview project={p.data.project} reload={p.reload} />} />
        <Route path="editor" element={<Editor projectId={projectId!} />} />
        <Route path="assistant" element={<Assistant projectId={projectId!} />} />
        <Route path="assets" element={<Assets projectId={projectId!} />} />
        <Route path="publish" element={<Publish projectId={projectId!} />} />
        <Route path="analytics" element={<Analytics projectId={projectId!} />} />
        <Route path="modules" element={<Modules projectId={projectId!} />} />
      </Routes>
    </div>
  );
}

const BRIEF_FIELDS: [string, string, "input" | "textarea"][] = [
  ["businessName", "Business name", "input"], ["industry", "Industry", "input"], ["location", "Location", "input"],
  ["description", "Description", "textarea"], ["audience", "Target audience", "textarea"], ["tone", "Tone of voice", "input"], ["notes", "Notes", "textarea"],
];

function Overview({ project, reload }: { project: any; reload: () => void }) {
  const [brief, setBrief] = useState<Record<string, any>>(project.brief ?? {});
  const [services, setServices] = useState<string>((project.brief?.services ?? []).join(", "));
  const [site, setSite] = useState({ name: project.website.settings.name, tagline: project.website.settings.tagline ?? "", description: project.website.settings.seo?.description ?? "" });
  const [saved, setSaved] = useState(false);
  const save = useAction(async () => {
    const clean = Object.fromEntries(Object.entries(brief).filter(([, v]) => v !== "" && v !== undefined));
    await api(`/api/projects/${project.id}`, { method: "PATCH", body: { brief: { ...clean, services: services.split(",").map((s) => s.trim()).filter(Boolean) } } });
    await api(`/api/projects/${project.id}/website`, { method: "PATCH", body: { name: site.name, tagline: site.tagline || undefined, seo: { titleTemplate: project.website.settings.seo?.titleTemplate ?? "%s", description: site.description || undefined } } });
    setSaved(true);
    reload();
  });
  useEffect(() => { if (saved) { const t = setTimeout(() => setSaved(false), 2500); return () => clearTimeout(t); } }, [saved]);
  return (
    <form className="stack" style={{ maxWidth: 760 }} onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
      <Section title="Website">
        <p className="small muted">Address: <a href={project.website.url} target="_blank" rel="noreferrer">{project.website.url}</a> {project.website.liveDeploymentId ? "" : "(not published yet)"}</p>
        <Field label="Site name"><input required value={site.name} onChange={(e) => setSite({ ...site, name: e.target.value })} /></Field>
        <Field label="Tagline"><input value={site.tagline} onChange={(e) => setSite({ ...site, tagline: e.target.value })} /></Field>
        <Field label="Default meta description" hint="Used when a page has no description (max 170 characters)"><textarea maxLength={170} value={site.description} onChange={(e) => setSite({ ...site, description: e.target.value })} /></Field>
      </Section>
      <Section title="Project brief">
        <p className="small muted">Structured information the assistant and future design engine use as context.</p>
        {BRIEF_FIELDS.map(([k, label, kind]) => (
          <Field key={k} label={label}>
            {kind === "textarea" ? <textarea name={k} value={brief[k] ?? ""} onChange={(e) => setBrief({ ...brief, [k]: e.target.value })} /> : <input name={k} value={brief[k] ?? ""} onChange={(e) => setBrief({ ...brief, [k]: e.target.value })} />}
          </Field>
        ))}
        <Field label="Services" hint="Comma-separated"><input name="services" value={services} onChange={(e) => setServices(e.target.value)} /></Field>
      </Section>
      <ErrorBox error={save.error} />
      <div className="row"><button className="btn primary" disabled={save.pending}>Save</button>{saved && <span className="badge ok" role="status">Saved</span>}</div>
    </form>
  );
}

function Assets({ projectId }: { projectId: string }) {
  const list = useApi<{ assets: any[] }>(`/api/projects/${projectId}/assets`);
  const upload = useAction(async (files: FileList) => {
    for (const f of Array.from(files)) {
      const fd = new FormData();
      fd.append("file", f);
      await api(`/api/projects/${projectId}/assets`, { body: fd });
    }
    await list.reload();
  });
  const remove = useAction(async (id: string) => { await api(`/api/assets/${id}`, { method: "DELETE" }); await list.reload(); });
  const setAlt = async (id: string, alt: string) => { await api(`/api/assets/${id}`, { method: "PATCH", body: { alt } }); };
  return (
    <div className="stack">
      <Section title="Upload" actions={upload.pending ? <span className="muted small">Uploading…</span> : null}>
        <input type="file" aria-label="Upload files" multiple accept="image/png,image/jpeg,image/gif,image/webp,image/avif,video/mp4,application/pdf" onChange={(e) => e.target.files && upload.run(e.target.files)} />
        <span className="small muted">PNG, JPEG, GIF, WebP, AVIF, MP4 or PDF. Files are type-checked on the server.</span>
        <ErrorBox error={upload.error ?? remove.error} />
      </Section>
      {!list.data ? <Loading /> : (
        <div className="grid">
          {list.data.assets.map((a) => (
            <div key={a.id} className="card stack">
              {a.kind === "image" ? <img src={a.url} alt={a.alt ?? ""} style={{ maxWidth: "100%", maxHeight: 160, objectFit: "contain" }} /> : <span className="badge">{a.mime}</span>}
              <span className="small">{a.filename} · {fmtBytes(a.size)}{a.width ? ` · ${a.width}×${a.height}` : ""}</span>
              <Field label="Alt text"><input defaultValue={a.alt ?? ""} onBlur={(e) => setAlt(a.id, e.target.value)} /></Field>
              <button className="btn sm danger" onClick={() => remove.run(a.id)}>Delete</button>
            </div>
          ))}
          {list.data.assets.length === 0 && <p className="muted">No assets yet.</p>}
        </div>
      )}
    </div>
  );
}

function Analytics({ projectId }: { projectId: string }) {
  const [days, setDays] = useState(30);
  const a = useApi<any>(`/api/projects/${projectId}/analytics?days=${days}`, [days]);
  if (!a.data) return a.error ? <ErrorBox error={a.error} /> : <Loading />;
  const max = Math.max(1, ...a.data.daily.map((d: any) => d.views));
  return (
    <div className="stack">
      <div className="row"><label className="row">Range <select value={days} onChange={(e) => setDays(+e.target.value)}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select></label></div>
      <div className="grid">
        <div className="card"><div className="muted small">Page views</div><div style={{ fontSize: 28, fontWeight: 600 }}>{a.data.totals.views}</div></div>
        <div className="card"><div className="muted small">Unique daily visitors</div><div style={{ fontSize: 28, fontWeight: 600 }}>{a.data.totals.visitors}</div></div>
      </div>
      <Section title="Daily views">
        {a.data.daily.length === 0 ? <p className="muted">No data yet. Views are recorded on the published site (cookie-less).</p> : (
          <table><tbody>{a.data.daily.map((d: any) => (
            <tr key={d.day}><td className="mono">{d.day}</td><td style={{ width: "70%" }}><div aria-hidden style={{ height: 10, width: `${(d.views / max) * 100}%`, background: "var(--accent)", borderRadius: 4 }} /></td><td>{d.views}</td></tr>
          ))}</tbody></table>
        )}
      </Section>
      <div className="grid">
        <Section title="Top pages"><table><tbody>{a.data.topPages.map((p: any) => <tr key={p.path}><td className="mono">{p.path}</td><td>{p.views}</td></tr>)}</tbody></table></Section>
        <Section title="Referrers"><table><tbody>{a.data.referrers.map((p: any) => <tr key={p.referrer}><td>{p.referrer}</td><td>{p.views}</td></tr>)}</tbody></table></Section>
        <Section title="Devices"><table><tbody>{a.data.devices.map((p: any) => <tr key={p.device ?? "unknown"}><td>{p.device ?? "unknown"}</td><td>{p.views}</td></tr>)}</tbody></table></Section>
      </div>
      <p className="small muted">Updated {fmtDate(new Date())}</p>
    </div>
  );
}
