# Security model

## Controls in place (implemented and tested where noted)

| Area | Control | Where |
|---|---|---|
| Passwords | scrypt (N=16384, r=8, p=1, 64-byte key), NFKC-normalized; dummy hash on unknown users to equalize timing | `lib/crypto.ts`, `services/auth.ts` |
| Sessions | 256-bit random token in `HttpOnly; SameSite=Lax; Secure(prod)` cookie; only SHA-256 stored; sliding 30-day expiry; all sessions revoked on password reset or account disable | `services/auth.ts` ✅ tested |
| CSRF | SameSite=Lax + `Origin` must equal `APP_ORIGIN` on non-GET API requests; `Sec-Fetch-Site: cross-site` rejected | `app.ts` ✅ tested |
| Account recovery | Single-use, hashed, 1-hour reset tokens; no user enumeration | ✅ tested |
| Authorization | Server-side on every route via `requireOrg/requireProject/requirePage` (role ranks viewer<editor<admin<owner); cross-tenant → 404 | `services/access.ts` ✅ tested per resource |
| Tenant isolation | `org_id` on every tenant row; asset references validated against the owning project at write time; module contexts bound to one installation | ✅ tested |
| Input validation | zod on every body; strict component props (unknown keys rejected); URL fields block `javascript:`/protocol-relative; tokens restricted to safe CSS literals | contracts ✅ tested |
| Output encoding | Component renderers use the escaping `html` template; `unsafeRaw` only for platform-generated markup | `contracts/html.ts` ✅ tested |
| Uploads | Type from magic bytes (allow-list PNG/JPEG/GIF/WebP/AVIF/MP4/PDF); SVG/HTML rejected; size limit; dimension sanity; sanitized filenames; opaque storage keys; served with `nosniff` + `CSP: sandbox`; PDFs as attachments | `services/assets.ts` ✅ tested |
| Editor canvas | Sandboxed iframe (`allow-scripts` only, opaque origin) with CSP `default-src 'none'`; postMessage source checked | `apps/web/src/pages/editor.tsx`, `renderer/bridge.ts` |
| Published sites | Separate origin; static files only; CSP `default-src 'self'; script-src 'self'`; `nosniff`; `X-Frame-Options: SAMEORIGIN`; previews `noindex` + `no-store` with 130-bit unguessable host labels | `sites.ts` ✅ tested |
| TLS issuance | On-demand certificates only for verified domains / existing subdomains (`/__zyko/tls-ask`) | ✅ tested |
| Secrets at rest | AES-256-GCM (`APP_ENCRYPTION_KEY`) for integration credentials and module webhook secrets; never returned by the API | ✅ tested |
| Webhooks | Modules: HMAC-SHA256 per installation, constant-time compare; Stripe: signature + 5-minute tolerance; billing events idempotent by event id | ✅ tested |
| AI | Tools zod-validated and role-checked; sensitive tools need explicit approval (atomic claim prevents double execution); every tool call audited in `ai_tasks`; per-user and per-org rate limits; monthly entitlement | ✅ tested |
| Rate limiting | Login, register, password reset, uploads, deployments, AI, webhooks, analytics beacon | `lib/rate-limit.ts` |
| Headers | `hono/secure-headers` on the API | `app.ts` |
| Audit | `audit_events` for auth, membership, billing, modules, domains, deployments, admin actions | `lib/platform.ts` |
| Config safety | Production boot refuses default encryption key, test billing, missing provider keys | `env.ts` |
| Analytics privacy | No cookies; daily-rotating salted visitor hash; IPs never stored; DNT respected | `sites.ts` |

## Known gaps / next steps (tracked in ROADMAP)

- Postgres Row-Level Security as defence in depth (currently app-layer only).
- Distributed rate limiting (in-memory store is per process).
- Malware scanning and image re-encoding for uploads (e.g. via a worker using libvips) — current validation is type/size/dimension only.
- 2FA (TOTP/WebAuthn) and SSO for agencies.
- Email verification is not yet required for sensitive actions (banner only).
- Dependency audit/SAST in CI (`pnpm audit`, CodeQL) — not yet wired.
- Content-Security-Policy for the SaaS app itself (API sends secure headers; the SPA needs a CSP tuned for Vite output).

## Review checklist for changes

1. Does every new route call an access helper before touching tenant data?
2. Is every input parsed with zod? Are limits (length, count, size) set?
3. Could any user-controlled string reach HTML/CSS/URL without the contract helpers?
4. Does any new code execute or load code chosen at runtime? (Must not.)
5. Are secrets kept out of logs and API responses?
6. Is there a test proving another org gets 404?
