import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAction, useApi } from "../lib/hooks";
import { useSession } from "../lib/session";
import { ErrorBox, Field, Loading, Section, fmtDate } from "../components/ui";

function CreateOrg() {
  const { refresh, setOrgId } = useSession();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"personal" | "agency">("personal");
  const a = useAction(async () => { const r = await api("/api/orgs", { body: { name, kind } }); setOrgId(r.org.id); await refresh(); });
  return (
    <form className="card stack" style={{ maxWidth: 480 }} onSubmit={(e) => { e.preventDefault(); void a.run(); }}>
      <h1>Set up your workspace</h1>
      <p className="muted">An organization holds your projects, team and billing.</p>
      <ErrorBox error={a.error} />
      <Field label="Organization name"><input required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Jane's Studio" /></Field>
      <fieldset className="stack" style={{ border: 0, padding: 0 }}>
        <legend className="small" style={{ fontWeight: 500 }}>Account type</legend>
        <label className="row"><input type="radio" name="kind" checked={kind === "personal"} onChange={() => setKind("personal")} /> Personal — my own websites</label>
        <label className="row"><input type="radio" name="kind" checked={kind === "agency"} onChange={() => setKind("agency")} /> Agency — websites for clients</label>
      </fieldset>
      <button className="btn primary" disabled={a.pending}>Create organization</button>
    </form>
  );
}

function NewProject({ orgId, onCreated }: { orgId: string; onCreated: (id: string) => void }) {
  const [f, setF] = useState({ name: "", description: "", industry: "" });
  const a = useAction(async () => {
    const r = await api(`/api/orgs/${orgId}/projects`, { body: { name: f.name, brief: { businessName: f.name, description: f.description || undefined, industry: f.industry || undefined } } });
    onCreated(r.project.id);
  });
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void a.run(); }}>
      <ErrorBox error={a.error} />
      <Field label="Project name"><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Industry"><input value={f.industry} onChange={(e) => setF({ ...f, industry: e.target.value })} /></Field>
      <Field label="What does the business do?"><textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <button className="btn primary" disabled={a.pending}>{a.pending ? "Creating…" : "Create project"}</button>
    </form>
  );
}

export default function Dashboard() {
  const { me, orgId } = useSession();
  const nav = useNavigate();
  const [showNew, setShowNew] = useState(false);
  const projects = useApi<{ projects: any[] }>(orgId ? `/api/orgs/${orgId}/projects` : null);
  if (!me) return <Loading />;
  if (!me.orgs.length) return <CreateOrg />;
  return (
    <div className="stack">
      <div className="row spread">
        <h1>Projects</h1>
        <button className="btn primary" onClick={() => setShowNew((v) => !v)} aria-expanded={showNew}>New project</button>
      </div>
      {showNew && orgId && <Section title="New project"><NewProject orgId={orgId} onCreated={(id) => nav(`/app/p/${id}`)} /></Section>}
      <ErrorBox error={projects.error} />
      {projects.loading && !projects.data ? <Loading /> : projects.data?.projects.length === 0 ? (
        <div className="card muted">No projects yet. Create your first one.</div>
      ) : (
        <div className="grid">
          {projects.data?.projects.map((p) => (
            <Link key={p.id} to={`/app/p/${p.id}`} className="card stack" style={{ textDecoration: "none", color: "inherit" }}>
              <strong>{p.name}</strong>
              <span className="small muted">{p.website?.liveDeploymentId ? "Published" : "Not published"} · updated {fmtDate(p.updatedAt)}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
