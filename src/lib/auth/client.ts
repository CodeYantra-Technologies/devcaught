import { createAuthClient } from "better-auth/react";
import { runSignOut } from "../../../scripts/sign-out-plan.mjs";

/**
 * Better Auth client for this React SPA (browser-side).
 *
 * Talks to this app's OWN Better Auth at same-origin `/api/auth/*`. The session
 * rides the same-origin cookie.
 *
 * To sign out call `signOut()` below, NOT `authClient.signOut()`: the raw call
 * skips the sequencing in `scripts/sign-out-plan.mjs` that decides whether an
 * unconfirmed sign-out must reject instead of reporting success.
 */
export const authClient = createAuthClient();

/**
 * True when sign-in UI should be shown — i.e. whenever `VITE_AUTH_ENABLED` is
 * not `"false"`. The shipped default sets it to `"false"`
 * (`.devcaught/app-env.json`), which selects the dev user (see
 * `use-current-user`). Turning it on without a configured method fails closed
 * server-side (see `server.ts` / `verify.server.ts`).
 */
export const authEnabled = import.meta.env.VITE_AUTH_ENABLED !== "false";

/**
 * Sign out of THIS app's local session, then redirect.
 *
 * Use this, never `authClient.signOut()` — see the note on `authClient`.
 * Sequencing lives in `scripts/sign-out-plan.mjs` so it can be unit-tested.
 *
 * **Rejects if the server never confirms.** The session is an HttpOnly cookie
 * only the server can clear, so redirecting anyway would report a sign-out that
 * did not happen. `<UserButton />` handles that for you; a hand-rolled control
 * must catch it and let the visitor retry.
 */
export async function signOut(redirectTo = "/login"): Promise<void> {
  await runSignOut({
    livePreview: false,
    hasBearer: false,
    // Better Auth resolves with `{ error }` instead of rejecting, so surface a
    // failed response as a rejection for the sequence to act on.
    requestSignOut: async () => {
      const { error } = await authClient.signOut();
      if (error) throw new Error(error.message ?? "Sign-out failed");
    },
    clearToken: () => {},
    redirect: () => {
      window.location.replace(redirectTo);
    },
  });
}
