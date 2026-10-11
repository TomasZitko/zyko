import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAction } from "../lib/hooks";
import { useSession } from "../lib/session";
import { ErrorBox, Field } from "../components/ui";

function useAfterAuth() {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const { refresh } = useSession();
  return async () => {
    await refresh();
    const next = sp.get("next");
    nav(next && next.startsWith("/") && !next.startsWith("//") ? next : "/app", { replace: true });
  };
}

export function Login() {
  const after = useAfterAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const a = useAction(async () => { await api("/api/auth/login", { body: { email, password } }); await after(); });
  const submit = (e: FormEvent) => { e.preventDefault(); void a.run(); };
  return (
    <form className="card stack auth-card" onSubmit={submit}>
      <h1>Log in</h1>
      <ErrorBox error={a.error} />
      <Field label="Email"><input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <Field label="Password"><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      <button className="btn primary" disabled={a.pending}>{a.pending ? "Signing in…" : "Log in"}</button>
      <div className="row spread small"><Link to="/forgot-password">Forgot password?</Link><Link to="/signup">Create account</Link></div>
    </form>
  );
}

export function Signup() {
  const after = useAfterAuth();
  const [f, setF] = useState({ name: "", email: "", password: "" });
  const a = useAction(async () => { await api("/api/auth/register", { body: f }); await after(); });
  return (
    <form className="card stack auth-card" onSubmit={(e) => { e.preventDefault(); void a.run(); }}>
      <h1>Create your account</h1>
      <ErrorBox error={a.error} />
      <Field label="Name"><input autoComplete="name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Email"><input type="email" autoComplete="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
      <Field label="Password" hint="At least 10 characters"><input type="password" autoComplete="new-password" minLength={10} required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
      <button className="btn primary" disabled={a.pending}>{a.pending ? "Creating…" : "Sign up"}</button>
      <p className="small muted">Already have an account? <Link to="/login">Log in</Link></p>
    </form>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const a = useAction(async () => { await api("/api/auth/forgot-password", { body: { email } }); setSent(true); });
  return (
    <form className="card stack auth-card" onSubmit={(e) => { e.preventDefault(); void a.run(); }}>
      <h1>Reset password</h1>
      <ErrorBox error={a.error} />
      {sent ? <div className="alert ok" role="status">If an account exists for that email, a reset link has been sent.</div> : <>
        <Field label="Email"><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <button className="btn primary" disabled={a.pending}>Send reset link</button>
      </>}
    </form>
  );
}

export function ResetPassword() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const [password, setPassword] = useState("");
  const a = useAction(async () => { await api("/api/auth/reset-password", { body: { token: sp.get("token"), password } }); nav("/login"); });
  return (
    <form className="card stack auth-card" onSubmit={(e) => { e.preventDefault(); void a.run(); }}>
      <h1>Choose a new password</h1>
      <ErrorBox error={a.error} />
      <Field label="New password"><input type="password" autoComplete="new-password" minLength={10} required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      <button className="btn primary" disabled={a.pending}>Save password</button>
    </form>
  );
}

export function VerifyEmail() {
  const [sp] = useSearchParams();
  const [state, setState] = useState<"pending" | "ok" | string>("pending");
  useEffect(() => { api("/api/auth/verify-email", { body: { token: sp.get("token") } }).then(() => setState("ok"), (e) => setState(e.message)); }, [sp]);
  return <div className="card auth-card">{state === "pending" ? "Verifying…" : state === "ok" ? <div className="alert ok">Email verified. <Link to="/app">Continue</Link></div> : <ErrorBox error={state} />}</div>;
}

export function AcceptInvite() {
  const [sp] = useSearchParams();
  const { me, refresh, setOrgId } = useSession();
  const nav = useNavigate();
  const a = useAction(async () => { const r = await api<{ orgId: string }>("/api/invitations/accept", { body: { token: sp.get("token") } }); await refresh(); setOrgId(r.orgId); nav("/app"); });
  if (!me?.user) return <div className="card auth-card stack"><h1>Join organization</h1><p>Log in or sign up with the invited email first.</p><Link className="btn primary" to={`/login?next=${encodeURIComponent(`/invite?token=${sp.get("token")}`)}`}>Log in</Link></div>;
  return <div className="card auth-card stack"><h1>Join organization</h1><ErrorBox error={a.error} /><button className="btn primary" onClick={() => a.run()} disabled={a.pending}>Accept invitation</button></div>;
}
