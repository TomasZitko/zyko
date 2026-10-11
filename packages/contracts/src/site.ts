import { z } from "zod";
import { DesignTokenOverridesSchema } from "./tokens.js";

export const PagePathSchema = z.string().regex(/^\/([a-z0-9]+(?:-[a-z0-9]+)*(\/[a-z0-9]+(?:-[a-z0-9]+)*)*)?$/, "Lowercase path like /about or /services/web");

export const PageSeoSchema = z.object({
  title: z.string().max(70).optional(),
  description: z.string().max(170).optional(),
  noindex: z.boolean().optional(),
  canonical: z.string().url().optional(),
  ogImageAssetId: z.string().nullable().optional(),
}).strict();
export type PageSeo = z.infer<typeof PageSeoSchema>;

export const SiteSettingsSchema = z.object({
  name: z.string().min(1).max(120),
  locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).default("en"),
  tagline: z.string().max(200).optional(),
  seo: z.object({ titleTemplate: z.string().max(80).default("%s"), description: z.string().max(170).optional() }).default({ titleTemplate: "%s" }),
  nav: z.array(z.object({ label: z.string().max(60), path: z.string().max(200) })).max(20).default([]),
  tokenOverrides: DesignTokenOverridesSchema.optional(),
  analytics: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
}).strict();
export type SiteSettings = z.infer<typeof SiteSettingsSchema>;

/** Structured project information collected during onboarding and by the AI assistant. */
export const ProjectBriefSchema = z.object({
  businessName: z.string().max(200).optional(),
  industry: z.string().max(120).optional(),
  description: z.string().max(4000).optional(),
  audience: z.string().max(1000).optional(),
  goals: z.array(z.string().max(300)).max(20).optional(),
  services: z.array(z.string().max(200)).max(50).optional(),
  tone: z.string().max(200).optional(),
  location: z.string().max(200).optional(),
  contact: z.object({ email: z.string().max(200).optional(), phone: z.string().max(60).optional(), address: z.string().max(400).optional() }).optional(),
  notes: z.string().max(4000).optional(),
}).strict();
export type ProjectBrief = z.infer<typeof ProjectBriefSchema>;
