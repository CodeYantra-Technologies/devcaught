/**
 * Self-hosted Better Auth for THIS app (server-only).
 *
 * Owner-approved Phase 1 changes are limited to the PostgreSQL adapter,
 * invitation policy, fresh session checks and abuse controls. To enable
 * local email/password, flip the flag in `./email-password` only.
 *
 * The app runs its own Better Auth at `/api/auth/*`, so the session cookie
 * stays on this app's own origin (owned cookie names + origin policy live in
 * `./auth-config`). No external identity broker and no OAuth federation.
 *
 * Dual-mode:
 *   - Off (`VITE_AUTH_ENABLED=false`, the shipped default): no method is
 *     active; `requireUserId` resolves a dev user with no database
 *     configured, and throws fail-closed once `DATABASE_URL` is set
 *     (see `verify.server.ts`).
 *   - On (`VITE_AUTH_ENABLED` not "false"): a method must be configured
 *     (today: email/password, disabled by default). Requested-but-
 *     unconfigured fails CLOSED with a configuration error — it never serves
 *     the dev user — and `BETTER_AUTH_SECRET` is REQUIRED in this state.
 *
 * With a method active: deployed apps set `BETTER_AUTH_URL` +
 * `BETTER_AUTH_SECRET` + `DATABASE_URL`, so sessions persist in Postgres;
 * authentication refuses to start without `DATABASE_URL`. Tests inject a
 * disposable database explicitly. The identity schema comes from
 * `migrations/auth/0001_auth.sql`, copied into `migrations/` when the app
 * turns sign-in on.
 *
 * NEVER import this from client code — it pulls in `pg` + server-only Better
 * Auth internals. The client uses `@/lib/auth/client`; components read the
 * user via `@/lib/auth/use-current-user`; server functions get a verified id
 * via `@/lib/auth/middleware`.
 */
import { betterAuth } from "better-auth";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { getCookie } from "@tanstack/react-start/server";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { invitationAuthPolicy, invitationPlugin } from "./invitation-policy.ts";
import { emailAndPasswordEnabled } from "./email-password";
import {
  AUTH_COOKIES,
  AUTH_MISCONFIGURED_MESSAGE,
  AUTH_MISSING_SECRET_MESSAGE,
  resolveAuthState,
  resolveBaseUrl,
  resolveTrustedOrigins,
} from "./auth-config";

// Phase 1: auth never opens the application PGLite fallback.

/**
 * Auth-off signing secret: process-stable on globalThis so HMR does not
 * invalidate PGLite-backed sessions mid-dev. It is ONLY used while no method
 * is configured (no session is ever issued in that state); real auth requires
 * BETTER_AUTH_SECRET (see below). Process restart clears both the secret and
 * PGLite together.
 */
const globalAuthRef = globalThis as typeof globalThis & {
  __devcaughtAuthPreviewSecret__?: string;
};
function previewAuthSecret(): string {
  globalAuthRef.__devcaughtAuthPreviewSecret__ ??= randomBytes(32).toString("hex");
  return globalAuthRef.__devcaughtAuthPreviewSecret__;
}

/** Read an env var, treating empty/whitespace as unset. */
const env = (key: string): string | undefined => {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
};

const { authRequested, authConfigured } = resolveAuthState({
  viteAuthEnabled: env("VITE_AUTH_ENABLED"),
  emailAndPasswordEnabled,
});

/** True when sign-in was requested (`VITE_AUTH_ENABLED` not "false"). */
export { authRequested };

/** True when a real sign-in method is active (real auth is enforced). */
export { authConfigured };

if (authRequested && !authConfigured) {
  console.error(`[auth] ${AUTH_MISCONFIGURED_MESSAGE}`);
}

// This app's own Better Auth origin. When deployed the deployer injects the
// public URL; otherwise the local `npm run dev` server (port 8080 contract).
const explicitBaseURL = env("BETTER_AUTH_URL");
const baseURL = resolveBaseUrl(explicitBaseURL);

// Origins Better Auth accepts on credentialed POSTs (email sign-up/sign-in,
// …). Missing entries surface as FORBIDDEN "Invalid origin". Browsers may send
// Origin as any of the loopback variants for the same dev server — trusting
// only `localhost` rejects `127.0.0.1` and breaks email/password with
// "Invalid origin". Local `npm run dev` (port 8080 contract).
const trustedOrigins: string[] = resolveTrustedOrigins(explicitBaseURL);

const databaseUrl = env("DATABASE_URL");

// One authoritative PostgreSQL auth database. Transactions must be explicitly
// enabled: Better Auth 1.6.30 does not enable them for a bare pg Pool.
if (!databaseUrl) throw new Error("[auth] PostgreSQL is required for authentication");
export const authDatabase = new Kysely<unknown>({
  dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl }) }),
});
const database = {
  db: authDatabase,
  type: "postgres" as const,
  transaction: true,
};

// Sessions signed with a process-local secret silently break on restart and
// across instances, so real auth REQUIRES an explicit BETTER_AUTH_SECRET. The
// fallback below serves only the auth-off mode, where no session is issued.
const betterAuthSecret = env("BETTER_AUTH_SECRET");
if (authConfigured && !betterAuthSecret) {
  throw new Error(AUTH_MISSING_SECRET_MESSAGE);
}

/** Session token cookie name — DevCaught-owned (see `auth-config.ts`). */
export const SESSION_TOKEN_COOKIE = AUTH_COOKIES.session_token.name;

export const auth = betterAuth({
  baseURL,
  secret: betterAuthSecret ?? previewAuthSecret(),
  database,

  // CSRF / origin check for credentialed auth POSTs (email sign-up/sign-in, …).
  // See `resolveTrustedOrigins` — covers the deployer URL plus the local
  // loopback variants, or clients get "Invalid origin".
  trustedOrigins,

  // Owner-approved Phase 1 extension: atomic invitation registration only,
  // fresh sessions and database-backed abuse limits. Built-in signup is disabled.
  ...invitationAuthPolicy,
  emailAndPassword: { ...invitationAuthPolicy.emailAndPassword, enabled: authConfigured },

  // `__Host-` prefixed cookies: the browser REFUSES any same-named cookie that
  // carries a `Domain` attribute, so a sibling app on the shared parent domain
  // cannot "toss" a `Domain=<parent>` session cookie onto this app.
  // `__Host-` requires Secure + Path=/ + no Domain; Better Auth otherwise uses
  // `__Secure-` (which permits Domain), so we drop its auto prefix
  // (`useSecureCookies: false`) and set Secure + the names ourselves.
  // (Browsers allow Secure cookies on `http://localhost`, so local dev works.)
  advanced: {
    useSecureCookies: false,
    defaultCookieAttributes: { secure: true, sameSite: "lax", path: "/" },
    cookies: AUTH_COOKIES,
    ipAddress: { ipAddressHeaders: [] },
  },

  plugins: [
    invitationPlugin(),
    // Bridges Better Auth's Set-Cookie into TanStack Start responses. MUST be
    // last so it runs after every other plugin's hooks.
    tanstackStartCookies(),
  ],
});

export function readSessionToken(): string | null {
  return getCookie(SESSION_TOKEN_COOKIE) ?? null;
}
