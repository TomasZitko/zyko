import type { PageDocument } from "./document.js";
import type { ProjectBrief, SiteSettings } from "./site.js";
import type { DesignSystemManifest } from "./components.js";
import type { DesignRegistry } from "./registry.js";

/**
 * Integration contract for the (reserved) AI design-generation engine.
 * The platform ships only a NotConfigured engine; the owner-directed engine implements this interface.
 * Every output is validated against the design registry before it can touch project data,
 * and is applied as a draft revision (never auto-published).
 */
export interface RequirementsAnalysis {
  summary: string;
  pages: { path: string; title: string; purpose: string }[];
  missingInformation: string[];
}

export interface GenerationPlan {
  designSystem: { id: string; version: string };
  pages: { path: string; title: string; sections: { component: string; intent: string }[] }[];
  notes?: string;
}

export interface DesignEngineInput {
  project: { id: string; name: string; brief: ProjectBrief };
  site: { settings: SiteSettings; pages: { path: string; title: string }[] };
  designSystem: DesignSystemManifest;
  registry: DesignRegistry;
  references: { kind: string; url?: string | null; notes?: string | null; assetId?: string | null }[];
  assets: { id: string; filename: string; mime: string; alt: string | null; tags: string[] }[];
}

export interface DesignEngineOutput {
  pages: { path: string; title: string; document: PageDocument }[];
  settingsPatch?: Partial<SiteSettings>;
  explanation?: string;
}

export interface DesignEngine {
  id: string;
  version: string;
  available: boolean;
  analyzeRequirements(input: DesignEngineInput): Promise<RequirementsAnalysis>;
  createPlan(input: DesignEngineInput, analysis: RequirementsAnalysis): Promise<GenerationPlan>;
  generate(input: DesignEngineInput, plan: GenerationPlan): Promise<DesignEngineOutput>;
}

export class DesignEngineUnavailableError extends Error {
  constructor() {
    super("No design-generation engine is configured. This capability is reserved for the owner-directed design engine.");
    this.name = "DesignEngineUnavailableError";
  }
}

export const notConfiguredDesignEngine: DesignEngine = {
  id: "not-configured",
  version: "0.0.0",
  available: false,
  async analyzeRequirements() { throw new DesignEngineUnavailableError(); },
  async createPlan() { throw new DesignEngineUnavailableError(); },
  async generate() { throw new DesignEngineUnavailableError(); },
};
