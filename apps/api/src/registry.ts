import { DesignRegistry, notConfiguredDesignEngine, type DesignEngine, type ModuleDefinition, type ProviderDefinition, PLATFORM_API_VERSION } from "@zyko/contracts";
import { fixtureDesignSystem } from "@zyko/design-fixtures";
import { fixtureModules, fixtureProviders } from "@zyko/module-fixtures";

/**
 * Composition root for pluggable systems. This is the ONE place to register:
 *  - design systems (docs/INTEGRATION-CONTRACTS.md §1-4)
 *  - functional modules (§6-8), their widgets (§9)
 *  - external provider adapters (§10)
 *  - the AI design-generation engine (§5)
 * Registration is code-level by design: no runtime upload of executable code.
 */
export const modules = new Map<string, ModuleDefinition<any>>();
export const providers = new Map<string, ProviderDefinition<any, any>>();

export function registerModule(m: ModuleDefinition<any>) {
  if (m.platformApi !== PLATFORM_API_VERSION) throw new Error(`Module ${m.id}: unsupported platformApi ${m.platformApi}`);
  if (!/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(m.id)) throw new Error(`Module id must be "vendor.name": ${m.id}`);
  if (!/^\d+\.\d+\.\d+$/.test(m.version)) throw new Error(`Module ${m.id}: invalid version`);
  for (const w of m.widgets ?? []) if (!w.type.startsWith(m.id.split(".")[1] + ".") && !w.type.startsWith(m.id.replace(".", "-") + ".")) throw new Error(`Module ${m.id}: widget type ${w.type} must be namespaced`);
  if ((m.widgets?.length ?? 0) > 0 && !m.capabilities.includes("site.widgets")) throw new Error(`Module ${m.id}: widgets require the site.widgets capability`);
  modules.set(m.id, m);
}
export function registerProvider(p: ProviderDefinition<any, any>) {
  providers.set(`${p.kind}:${p.id}`, p);
}

for (const m of fixtureModules) registerModule(m);
for (const p of fixtureProviders) registerProvider(p);

/** Component types contributed by modules → owning module id. */
export const widgetOwners = new Map<string, string>();
const widgets = [...modules.values()].flatMap((m) => (m.widgets ?? []).map((w) => (widgetOwners.set(w.type, m.id), w)));

export const designRegistry = new DesignRegistry();
designRegistry.register(fixtureDesignSystem, widgets);

/** Design system assigned to new websites until the owner registers a production system. */
export const DEFAULT_DESIGN_SYSTEM = { id: fixtureDesignSystem.id, version: fixtureDesignSystem.version };

let engine: DesignEngine = notConfiguredDesignEngine;
export const designEngine = () => engine;
export function registerDesignEngine(e: DesignEngine) {
  engine = e;
}
