/**
 * DevCaught-owned auth configuration — pure and dependency-free so it can be
 * unit-tested without booting the database or the Better Auth instance (see
 * `auth-config.test.ts`). `server.ts` / `verify.server.ts` consume this; keep
 * server-only machinery (pg, vite, tanstack) OUT of this module.
 */

/**
 * Resolve the auth mode from the deployment env + the method flags.
 *
 * - `authRequested`: sign-in was asked for (`VITE_AUTH_ENABLED` is not
 *   `"false"`; an unset or blank flag also means requested).
 * - `authConfigured`: a REAL sign-in method is active.
 *
 * Requested-but-unconfigured must fail CLOSED: `requireUserId` throws a
 * configuration error in that state and never serves the dev user. The only
 * way to get the dev user is an explicit `"false"`.
 */
export function resolveAuthState({
  viteAuthEnabled,
  emailAndPasswordEnabled: emailAndPassword,
}: {
  viteAuthEnabled: string | undefined;
  emailAndPasswordEnabled: boolean;
}): { authRequested: boolean; authConfigured: boolean } {
  const authDisabled = viteAuthEnabled === "false";
  const authRequested = !authDisabled;
  const authConfigured = authRequested && emailAndPassword;
  return { authRequested, authConfigured };
}

/**
 * DevCaught-owned cookie names. `__Host-` is load-bearing: browsers REFUSE any
 * same-named cookie carrying a `Domain` attribute, so a sibling app on a
 * shared parent domain cannot "toss" its session cookie onto this app.
 * `__Host-` requires Secure + Path=/ + no Domain (see `server.ts`).
 */
export const AUTH_COOKIES = {
  session_token: { name: "__Host-devcaught-auth.session_token" },
  session_data: { name: "__Host-devcaught-auth.session_data" },
  account_data: { name: "__Host-devcaught-auth.account_data" },
  dont_remember: { name: "__Host-devcaught-auth.dont_remember" },
} as const;

/** This app's own Better Auth origin: the deployer's URL, else local dev. */
export function resolveBaseUrl(explicitBaseURL: string | undefined): string {
  return explicitBaseURL ?? "http://localhost:8080";
}

/** Local `npm run dev` (port 8080 contract) origin variants. */
export const LOCAL_DEV_ORIGINS: readonly string[] = [
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "http://[::1]:8080",
];

/**
 * Origins Better Auth accepts on credentialed POSTs (sign-up/sign-in, etc.);
 * missing entries surface as FORBIDDEN "Invalid origin". STRICT by design:
 * the deployer's explicit origin plus the local dev loopback variants — no
 * wildcards, ever.
 */
export function resolveTrustedOrigins(explicitBaseURL: string | undefined): string[] {
  return explicitBaseURL
    ? [explicitBaseURL, ...LOCAL_DEV_ORIGINS]
    : [...LOCAL_DEV_ORIGINS];
}

/** The fail-closed message for requested-but-unconfigured auth. */
export const AUTH_MISCONFIGURED_MESSAGE =
  "Auth is enabled (VITE_AUTH_ENABLED is not \"false\") but no authentication " +
  "method is configured — refusing to fall back to the dev user. Enable a " +
  "method in ./email-password, or set VITE_AUTH_ENABLED=false.";

/** The fail-closed message for a missing secret with real auth enabled. */
export const AUTH_MISSING_SECRET_MESSAGE =
  "[auth] BETTER_AUTH_SECRET is required when authentication is enabled " +
  "(VITE_AUTH_ENABLED is not \"false\" and a method is configured). " +
  "Generate one with: openssl rand -base64 32";
