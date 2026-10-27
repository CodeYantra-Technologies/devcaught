import { browserFetch, BrowserAccessError } from "../auth/browser-session.ts";

export const PRIVATE_ACCESS_EVENT = "devcaught:private-access";
export const privateInboxKey = (userId: string, resource: string, ...parts: unknown[]) =>
  ["private-inbox", userId, resource, ...parts] as const;

export function notifyPrivateAccess(status: number) {
  if (([401, 403].includes(status) || status >= 500) && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(PRIVATE_ACCESS_EVENT, { detail: status >= 500 ? 503 : status }));
  }
}

export async function privateRequest(path: string, options: RequestInit = {}): Promise<Response> {
  try {
    const response = await browserFetch(path, options);
    if (!response.ok) {
      throw new BrowserAccessError(response.status);
    }
    return response;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const status = error instanceof BrowserAccessError ? error.status : 503;
    notifyPrivateAccess(status);
    throw error instanceof BrowserAccessError ? error : new BrowserAccessError(503);
  }
}
