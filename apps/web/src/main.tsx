import { StrictMode, Suspense, lazy, Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./styles.css";
import { SessionProvider, useSession } from "./lib/session";
import { Loading } from "./components/ui";
import { PublicLayout, Home, Pricing } from "./pages/public";
import { Login, Signup, ForgotPassword, ResetPassword, VerifyEmail, AcceptInvite } from "./pages/auth";
import { AppLayout } from "./pages/shell";

const Dashboard = lazy(() => import("./pages/dashboard"));
const ProjectLayout = lazy(() => import("./pages/project"));
const Settings = lazy(() => import("./pages/settings"));
const Notifications = lazy(() => import("./pages/notifications"));
const Admin = lazy(() => import("./pages/admin"));
const TestCheckout = lazy(() => import("./pages/test-checkout"));

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error(error); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card" role="alert" style={{ margin: 24 }}>
        <h1>Something went wrong</h1>
        <p className="muted">{this.state.error.message}</p>
        <button className="btn" onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useSession();
  if (loading) return <Loading />;
  if (!me?.user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <>{children}</>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <SessionProvider>
        <BrowserRouter>
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route element={<PublicLayout />}>
                <Route index element={<Home />} />
                <Route path="pricing" element={<Pricing />} />
                <Route path="login" element={<Login />} />
                <Route path="signup" element={<Signup />} />
                <Route path="forgot-password" element={<ForgotPassword />} />
                <Route path="reset-password" element={<ResetPassword />} />
                <Route path="verify-email" element={<VerifyEmail />} />
                <Route path="invite" element={<AcceptInvite />} />
              </Route>
              <Route path="app" element={<RequireAuth><AppLayout /></RequireAuth>}>
                <Route index element={<Dashboard />} />
                <Route path="p/:projectId/*" element={<ProjectLayout />} />
                <Route path="settings" element={<Settings />} />
                <Route path="notifications" element={<Notifications />} />
                <Route path="admin" element={<Admin />} />
                <Route path="billing/test-checkout" element={<TestCheckout />} />
              </Route>
              <Route path="*" element={<PublicLayout notFound />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </SessionProvider>
    </ErrorBoundary>
  </StrictMode>,
);
