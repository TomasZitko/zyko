/**
 * Subscription plans and entitlements. Plans are code-defined; per-org overrides live in the DB.
 * Prices are placeholders pending a pricing decision; they are not shown as final anywhere.
 */
export interface Entitlements {
  maxProjects: number;
  maxStorageMb: number;
  aiMessagesPerMonth: number;
  maxMembers: number;
  customDomains: boolean;
  agencyClients: boolean;
  /** Module ids (or "*") that may be installed. */
  modules: string[];
  deploymentsPerDay: number;
}

export interface Plan {
  id: "free" | "pro" | "agency";
  name: string;
  priceMonthlyCents: number;
  entitlements: Entitlements;
}

export const PLANS: Record<Plan["id"], Plan> = {
  free: {
    id: "free", name: "Free", priceMonthlyCents: 0,
    entitlements: { maxProjects: 2, maxStorageMb: 200, aiMessagesPerMonth: 100, maxMembers: 1, customDomains: false, agencyClients: false, modules: ["fixture.*"], deploymentsPerDay: 30 },
  },
  pro: {
    id: "pro", name: "Pro", priceMonthlyCents: 0,
    entitlements: { maxProjects: 10, maxStorageMb: 5000, aiMessagesPerMonth: 2000, maxMembers: 5, customDomains: true, agencyClients: false, modules: ["*"], deploymentsPerDay: 200 },
  },
  agency: {
    id: "agency", name: "Agency", priceMonthlyCents: 0,
    entitlements: { maxProjects: 200, maxStorageMb: 50000, aiMessagesPerMonth: 20000, maxMembers: 50, customDomains: true, agencyClients: true, modules: ["*"], deploymentsPerDay: 2000 },
  },
};

export function moduleAllowed(e: Entitlements, moduleId: string): boolean {
  return e.modules.some((p) => p === "*" || p === moduleId || (p.endsWith(".*") && moduleId.startsWith(p.slice(0, -1))));
}
