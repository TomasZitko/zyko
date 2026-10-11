import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, errorText } from "../lib/api";
import { useApi } from "../lib/hooks";
import { useSession } from "../lib/session";
import { ErrorBox, Field, Loading, Section, fmtBytes, fmtDate } from "../components/ui";

export default function Settings() {
  const { orgId, refresh } = useSession();
  const [sp] = useSearchParams();
  const org = useApi<any>(orgId ? `/api/orgs/${orgId}` : null);
  const members = useApi<{ members: any[]; invites: any[] }>(orgId ? `/api/orgs/${orgId}/members` : null);
  const clients = useApi<{ clients: any[] }>(orgId ? `/api/orgs/${orgId}/clients` : null);
  const integ = useApi<{ available: any[]; connections: any[] }>(orgId ? `/api/orgs/${orgId}/integrations` : null);
  const [err, setErr] = useState<string | null>(null);
  const [invite, setInvite] = useState({ email: "", role: "editor" });
  const [client, setClient] = useState("");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const act = async (fn: () => Promise<any>, after?: () => void) => { setErr(null); try { const r = await fn(); after?.(); return r; } catch (e) { setErr(errorText(e)); } };
  if (!org.data) return org.error ? <ErrorBox error={org.error} /> : <Loading />;
  const o = org.data;
  const isOwner = o.role === "owner", isAdmin = isOwner || o.role === "admin";
  return (
    <div className="stack" style={{ maxWidth: 900 }}>
      <h1>{o.org.name}</h1>
      {sp.get("billing") === "success" && <div className="alert ok">Subscription updated.</div>}
      <ErrorBox error={err} />
      <Section title="Plan & usage">
        <p>Current plan: <strong>{o.plan.name}</strong> ({o.subscription.status})</p>
        <ul className="small">
          <li>AI messages this month: {o.usage.aiMessages} / {o.entitlements.aiMessagesPerMonth}</li>
          <li>Storage: {fmtBytes(o.usage.storageBytes)} / {o.entitlements.maxStorageMb} MB</li>
          <li>Projects: up to {o.entitlements.maxProjects} · Members: up to {o.entitlements.maxMembers}</li>
        </ul>
        {isOwner && <div className="row">{(["pro", "agency"] as const).filter((p) => p !== o.plan.id).map((p) => (
          <button key={p} className="btn" onClick={() => act(async () => { const r = await api(`/api/billing/orgs/${orgId}/checkout`, { body: { planId: p } }); location.href = r.url; })}>Upgrade to {p}</button>
        ))}</div>}
      </Section>
      <Section title="Organization">
        <form className="row" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void act(() => api(`/api/orgs/${orgId}`, { method: "PATCH", body: { name: f.get("name"), kind: f.get("kind") } }), () => { org.reload(); refresh(); }); }}>
          <Field label="Name"><input name="name" defaultValue={o.org.name} disabled={!isAdmin} /></Field>
          <Field label="Mode"><select name="kind" defaultValue={o.org.kind} disabled={!isAdmin}><option value="personal">Personal</option><option value="agency">Agency</option></select></Field>
          {isAdmin && <button className="btn" style={{ alignSelf: "end" }}>Save</button>}
        </form>
      </Section>
      <Section title="Members">
        <table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th /></tr></thead><tbody>
          {members.data?.members.map((m) => (
            <tr key={m.userId}><td>{m.name}</td><td>{m.email}</td>
              <td>{isAdmin ? <select aria-label={`Role for ${m.email}`} value={m.role} onChange={(e) => act(() => api(`/api/orgs/${orgId}/members/${m.userId}`, { method: "PATCH", body: { role: e.target.value } }), members.reload)}>{["owner", "admin", "editor", "viewer"].map((r) => <option key={r}>{r}</option>)}</select> : m.role}</td>
              <td>{isAdmin && <button className="btn sm danger" onClick={() => act(() => api(`/api/orgs/${orgId}/members/${m.userId}`, { method: "DELETE" }), members.reload)}>Remove</button>}</td></tr>
          ))}
          {members.data?.invites.map((i) => <tr key={i.id}><td className="muted">Invited</td><td>{i.email}</td><td>{i.role}</td><td>{isAdmin && <button className="btn sm" onClick={() => act(() => api(`/api/orgs/${orgId}/invitations/${i.id}`, { method: "DELETE" }), members.reload)}>Revoke</button>}</td></tr>)}
        </tbody></table>
        {isAdmin && (
          <form className="row" onSubmit={(e) => { e.preventDefault(); void act(async () => { const r = await api(`/api/orgs/${orgId}/invitations`, { body: invite }); if (r.devToken) setInviteLink(`${location.origin}/invite?token=${r.devToken}`); }, () => { setInvite({ email: "", role: "editor" }); members.reload(); }); }}>
            <Field label="Invite by email"><input type="email" required value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} /></Field>
            <Field label="Role"><select value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>{["admin", "editor", "viewer"].map((r) => <option key={r}>{r}</option>)}</select></Field>
            <button className="btn" style={{ alignSelf: "end" }}>Send invite</button>
          </form>
        )}
        {inviteLink && <p className="small muted">Development: invite link <span className="mono">{inviteLink}</span></p>}
      </Section>
      {o.org.kind === "agency" && (
        <Section title="Clients">
          <ul>{clients.data?.clients.map((c) => <li key={c.id}>{c.name}</li>)}</ul>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void act(() => api(`/api/orgs/${orgId}/clients`, { body: { name: client } }), () => { setClient(""); clients.reload(); }); }}>
            <Field label="New client"><input value={client} onChange={(e) => setClient(e.target.value)} /></Field>
            <button className="btn" style={{ alignSelf: "end" }} disabled={!client}>Add client</button>
          </form>
        </Section>
      )}
      <Section title="Integrations">
        <p className="small muted">External service connections used by modules. Credentials are encrypted and never shown again.</p>
        <ul className="small">{integ.data?.connections.map((c) => <li key={c.id}>{c.label} ({c.kind}) · {c.status} · {fmtDate(c.createdAt)}</li>)}</ul>
        {isAdmin && integ.data?.available.map((p) => <IntegrationForm key={`${p.kind}:${p.id}`} p={p} onSubmit={(creds) => act(() => api(`/api/orgs/${orgId}/integrations`, { body: { kind: p.kind, providerId: p.id, credentials: creds } }), integ.reload)} />)}
      </Section>
    </div>
  );
}

function IntegrationForm({ p, onSubmit }: { p: any; onSubmit: (c: Record<string, string>) => void }) {
  const keys = Object.keys(p.credentialsSchema?.properties ?? {});
  const [v, setV] = useState<Record<string, string>>({});
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); onSubmit(v); }}>
      <strong className="small">{p.name}</strong>
      {keys.map((k) => <input key={k} aria-label={k} placeholder={k} type="password" autoComplete="off" value={v[k] ?? ""} onChange={(e) => setV({ ...v, [k]: e.target.value })} style={{ width: 200 }} />)}
      <button className="btn sm">Connect</button>
    </form>
  );
}
