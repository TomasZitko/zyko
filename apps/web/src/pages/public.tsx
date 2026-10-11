import { Link, Outlet } from "react-router-dom";
import { useSession } from "../lib/session";
import { useApi } from "../lib/hooks";
import { Loading } from "../components/ui";

/** Public marketing shell. Copy and visuals are placeholders pending brand direction. */
export function PublicLayout({ notFound }: { notFound?: boolean }) {
  const { me } = useSession();
  return (
    <div className="public">
      <header>
        <Link to="/" className="brand">Zyko</Link>
        <nav className="row" aria-label="Main">
          <Link className="btn ghost" to="/pricing">Pricing</Link>
          {me?.user ? <Link className="btn primary" to="/app">Dashboard</Link> : <><Link className="btn ghost" to="/login">Log in</Link><Link className="btn primary" to="/signup">Sign up</Link></>}
        </nav>
      </header>
      <main>{notFound ? <div className="card"><h1>Page not found</h1><Link to="/">Go home</Link></div> : <Outlet />}</main>
      <footer className="muted small"><span>© Zyko</span><span>Development build</span></footer>
    </div>
  );
}

export function Home() {
  return (
    <div className="stack" style={{ maxWidth: 640, margin: "48px auto" }}>
      <p className="badge">Placeholder marketing page</p>
      <h1 style={{ fontSize: 36 }}>Build and run websites with an AI assistant.</h1>
      <p className="muted">Marketing content and brand identity are pending. This page exists so routing, SEO metadata and conversion flows can be wired and tested.</p>
      <div className="row"><Link className="btn primary" to="/signup">Create an account</Link><Link className="btn" to="/pricing">See plans</Link></div>
    </div>
  );
}

export function Pricing() {
  const { data } = useApi<{ plans: { id: string; name: string; entitlements: Record<string, any> }[] }>("/api/billing/plans");
  if (!data) return <Loading />;
  return (
    <div className="stack">
      <h1>Plans</h1>
      <p className="muted">Prices are not final. Limits shown are the enforced entitlements.</p>
      <div className="grid">
        {data.plans.map((p) => (
          <div key={p.id} className="card stack">
            <h2>{p.name}</h2>
            <ul className="small">
              <li>{p.entitlements.maxProjects} projects</li>
              <li>{p.entitlements.aiMessagesPerMonth} AI messages / month</li>
              <li>{p.entitlements.maxStorageMb} MB storage</li>
              <li>{p.entitlements.maxMembers} team member(s)</li>
              <li>Custom domains: {p.entitlements.customDomains ? "yes" : "no"}</li>
              <li>Agency clients: {p.entitlements.agencyClients ? "yes" : "no"}</li>
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
