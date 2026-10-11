import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useApi } from "../lib/hooks";
import { useSession } from "../lib/session";

export function AppLayout() {
  const { me, orgId, setOrgId, refresh } = useSession();
  const nav = useNavigate();
  const notes = useApi<{ unread: number }>("/api/notifications");
  const logout = async () => { await api("/api/auth/logout", { body: {} }); await refresh(); nav("/"); };
  return (
    <div className="app">
      <aside className="sidebar">
        <NavLink to="/app" className="brand">Zyko</NavLink>
        {me && me.orgs.length > 0 && (
          <label className="field small">Organization
            <select value={orgId ?? ""} onChange={(e) => { setOrgId(e.target.value); nav("/app"); }}>
              {me.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}{o.kind === "agency" ? " (agency)" : ""}</option>)}
            </select>
          </label>
        )}
        <nav aria-label="App">
          <NavLink to="/app" end>Projects</NavLink>
          <NavLink to="/app/settings">Organization</NavLink>
          <NavLink to="/app/notifications">Notifications{notes.data?.unread ? ` (${notes.data.unread})` : ""}</NavLink>
          {me?.user?.isPlatformAdmin && <NavLink to="/app/admin">Platform admin</NavLink>}
        </nav>
        <div style={{ marginTop: "auto" }} className="stack small">
          <span className="muted">{me?.user?.email}</span>
          <button className="btn sm" onClick={logout}>Log out</button>
        </div>
      </aside>
      <main className="content" id="main">
        {me?.user && !me.user.emailVerified && (
          <div className="alert warn small" style={{ marginBottom: 16 }}>
            Please verify your email address. <button className="btn sm ghost" onClick={() => api("/api/auth/resend-verification", { body: {} })}>Resend link</button>
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}
