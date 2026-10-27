/**
 * Local email/password sign-in (this app's Better Auth DB — not the broker).
 *
 * Enabled for invitation-only Phase 1. Public signUp.email is disabled;
 * registration uses /api/auth/register-invitation. Login uses signIn.email.
 *
 * Do NOT edit `server.ts` for this — that file is frozen pre-wired config.
 */
export const emailAndPasswordEnabled = true;
