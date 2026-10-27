import { getRequest } from "@tanstack/react-start/server";
import { verifiedSessionUser } from "./session-policy.ts";
import { AUTH_MISCONFIGURED_MESSAGE } from "./auth-config";
import { auth, authConfigured, authRequested } from "./server";

/**
 * Server-side session resolution (server-only).
 *
 * Because this app runs its OWN Better Auth at same-origin `/api/auth/*`, the
 * session cookie is sent with every request to this app — server functions AND
 * SSR loaders included. So we resolve the user straight from the request cookies
 * via `auth.api.getSession` (no client-minted JWT needed). Never trust a
 * client-supplied user id — only the result of this verification.
 */

/** True when a real database is configured server-side. */
const databaseConfigured = Boolean(process.env.DATABASE_URL?.trim());

/** Re-export so callers can branch on it without importing `server.ts`. */
export { authConfigured };

if (!authRequested && databaseConfigured) {
  console.error(
    "[auth] DATABASE_URL is set but auth is disabled (VITE_AUTH_ENABLED=false) " +
      "— requireUserId() will reject every request (fail closed) rather than " +
      "share one dev user on a real database.",
  );
}

/** Dev fallback user id, used only when auth is disabled (VITE_AUTH_ENABLED=false). */
export const DEV_USER_ID = "dev-user";

/**
 * Thrown by `requireUserId` when the caller has no valid session. Carries
 * `status: 401`; the message is a stable contract — match
 * `err.message === "Unauthorized"` client-side to send the visitor to sign-in.
 */
export class UnauthorizedError extends Error {
  readonly status = 401;
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

export type VerifiedUser = { id: string; email: string | null };

/**
 * Resolve the signed-in user from the current request, or `null` when auth isn't
 * configured / nobody is signed in. Safe to call from server functions and SSR
 * loaders.
 */
export async function getSessionUser(): Promise<VerifiedUser | null> {
  if (!authConfigured) return null;
  const request = getRequest();
  if (!request) return null;
  return verifiedSessionUser(auth, request.headers, authConfigured);
}

/**
 * Resolve the current user id for a server function, or throw when unauthorized.
 * Prefer `authMiddleware` (`./middleware`), which calls this for you.
 * - Auth explicitly off (`VITE_AUTH_ENABLED=false`) + no `DATABASE_URL` -> the
 *   rejects (Phase 1 does not authenticate development identities).
 * - Auth explicitly off + `DATABASE_URL` set -> throw (fail closed): one
 *   shared dev user on a real database would let every visitor read/write
 *   everyone's rows.
 * - Auth requested but NO method configured -> throw (fail closed): sign-in
 *   was asked for, so falling back to the dev user would silently bypass it.
 * - Auth configured -> the verified session user id; throws
 *   `UnauthorizedError` when signed out.
 */
export async function requireUserId(): Promise<string> {
  if (!authRequested) {
    if (databaseConfigured) {
      throw new Error(
        "Auth is disabled (VITE_AUTH_ENABLED=false) but DATABASE_URL is set — " +
          "refusing to fall back to the shared dev user against a real database.",
      );
    }
    throw new UnauthorizedError();
  }
  if (!authConfigured) {
    throw new Error(AUTH_MISCONFIGURED_MESSAGE);
  }
  const user = await getSessionUser();
  if (!user) throw new UnauthorizedError();
  return user.id;
}
