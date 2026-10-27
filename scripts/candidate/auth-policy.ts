/** Copied into the server source only by the separate authorization build. */
export function candidateAuthorizationEnabled(request: Request): boolean {
  const expires = Number(process.env.DEVCAUGHT_CANDIDATE_AUTH_EXPIRES);
  const now = Date.now();
  return process.env.DEVCAUGHT_APP_ENV === 'local-development'
    && process.env.DEVCAUGHT_CANDIDATE_AUTH_TEST === 'enabled'
    && process.env.BETTER_AUTH_URL === 'http://localhost:3300'
    && process.env.PORT === '3300'
    && process.env.DEVCAUGHT_DB_PATH === '/app/data/candidate-auth-verification.db'
    && Number.isSafeInteger(expires) && expires > now && expires <= now + 15 * 60_000
    && new URL(request.url).origin === 'http://localhost:3300';
}
