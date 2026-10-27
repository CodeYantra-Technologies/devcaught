export class BrowserAccessError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(status === 401 ? "Sign in to continue." : status === 403
      ? "Access to this private inbox is forbidden."
      : status === 404 ? "Message not found." : status >= 500
      ? "Authentication or private inbox access is temporarily unavailable."
      : "The request could not be completed.");
    this.name = "BrowserAccessError";
    this.status = status;
  }
}

export type BrowserUser = { id: string; name: string; email: string };

export async function browserFetch(path: string, options: RequestInit = {}, request: typeof fetch = fetch) {
  const timeout = AbortSignal.timeout(10000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    return await request(path, { ...options, signal, credentials: "same-origin", cache: "no-store" });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new BrowserAccessError(503);
  }
}

/** Verify the browser's actual cookie with the server; never use a dev identity. */
export async function readBrowserSession(signal?: AbortSignal, request: typeof fetch = fetch): Promise<BrowserUser | null> {
  const response = await browserFetch("/api/auth/get-session?disableCookieCache=true", { signal }, request);
  if (response.status === 401) return null;
  if (!response.ok) throw new BrowserAccessError(response.status);
  let result;
  try { result = await response.json(); }
  catch { throw new BrowserAccessError(503); }
  if (result === null) return null;
  if (!result?.session || typeof result?.user?.id !== "string" || !result.user.id) {
    throw new BrowserAccessError(503);
  }
  return { id: result.user.id, name: result.user.name ?? "", email: result.user.email ?? "" };
}

export async function submitBrowserAuth(registration: boolean, body: Record<string, string>, request: typeof fetch = fetch) {
  const response = await browserFetch(`/api/auth/${registration ? "register-invitation" : "sign-in/email"}`, {
    method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }, request);
  if (!response.ok) throw new BrowserAccessError(response.status);
  if (!registration && !await readBrowserSession(undefined, request)) {
    throw new BrowserAccessError(401);
  }
}
