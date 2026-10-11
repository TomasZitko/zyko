/**
 * Client-side mirror of the API's design registry so the editor canvas renders with exactly the
 * same component code the publisher uses. Register new design systems here AND in apps/api/src/registry.ts.
 */
import { DesignRegistry } from "@zyko/contracts";
import { fixtureDesignSystem } from "@zyko/design-fixtures";
import { fixtureModules } from "@zyko/module-fixtures";

export const registry = new DesignRegistry();
registry.register(fixtureDesignSystem, fixtureModules.flatMap((m) => m.widgets ?? []));
