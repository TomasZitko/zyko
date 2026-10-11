import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAction } from "../lib/hooks";
import { ErrorBox } from "../components/ui";

/** Simulated checkout used only with BILLING_PROVIDER=test (refused in production). */
export default function TestCheckout() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const a = useAction(async () => { await api("/api/billing/webhook", { body: { token: sp.get("token") } }); nav("/app/settings?billing=success"); });
  return (
    <div className="card stack" style={{ maxWidth: 480 }}>
      <h1>Test checkout</h1>
      <p className="muted">Development billing provider. No payment is taken.</p>
      <ErrorBox error={a.error} />
      <div className="row"><button className="btn primary" onClick={() => a.run()} disabled={a.pending}>Confirm subscription</button><button className="btn" onClick={() => nav("/app/settings?billing=cancel")}>Cancel</button></div>
    </div>
  );
}
