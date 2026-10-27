export interface SessionReader {
  api: { getSession(input: { headers: Headers; query: { disableCookieCache: boolean } }): Promise<{
    user: { id: string; email?: string | null };
  } | null> };
}

/** No client identity or development fallback can satisfy this check. */
export async function verifiedSessionUser(auth: SessionReader, headers: Headers, enabled: boolean) {
  if (!enabled) return null;
  const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
  if (!session?.user) return null;
  return { id: session.user.id, email: session.user.email ?? null };
}
