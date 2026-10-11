import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";

export interface Me {
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean; emailVerified: boolean } | null;
  orgs: { id: string; name: string; slug: string; kind: "personal" | "agency"; role: string }[];
}
interface SessionCtx {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
  orgId: string | null;
  setOrgId: (id: string) => void;
}
const Ctx = createContext<SessionCtx>(null as any);
const ORG_KEY = "zyko.org";

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [orgId, setOrgIdState] = useState<string | null>(() => { try { return localStorage.getItem(ORG_KEY); } catch { return null; } });
  const refresh = useCallback(async () => {
    try {
      const m = await api<Me>("/api/auth/me");
      setMe({ user: m.user, orgs: m.orgs ?? [] });
    } catch {
      setMe({ user: null, orgs: [] });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const setOrgId = (id: string) => {
    setOrgIdState(id);
    try { localStorage.setItem(ORG_KEY, id); } catch { /* ignore */ }
  };
  const effectiveOrg = me?.orgs.find((o) => o.id === orgId)?.id ?? me?.orgs[0]?.id ?? null;
  return <Ctx.Provider value={{ me, loading, refresh, orgId: effectiveOrg, setOrgId }}>{children}</Ctx.Provider>;
}
export const useSession = () => useContext(Ctx);
