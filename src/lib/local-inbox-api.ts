export interface LocalInboxSummary {
  id: string;
  type: "email";
  source: "smtp";
  sender: string;
  recipient: string;
  subject: string | null;
  createdAt: number;
  hasHtml: boolean;
  hasText: boolean;
}

export interface LocalInboxMessage extends LocalInboxSummary {
  textBody: string;
}

export interface LocalInboxPage {
  items: LocalInboxSummary[];
  hasMore: boolean;
  nextCursor: string | null;
}

export class LocalInboxApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "LocalInboxApiError";
    this.status = status;
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new LocalInboxApiError("Local capture service could not be reached.", 0);
  }

  if (!response.ok) {
    const message = response.status === 404
      ? "This local capture is no longer available."
      : response.status === 503
        ? "Local SMTP capture is unavailable. Check that the local SMTP service is running."
        : "The local inbox request could not be completed.";
    throw new LocalInboxApiError(message, response.status);
  }

  try {
    return await response.json() as T;
  } catch {
    throw new LocalInboxApiError("The local inbox returned an invalid response.", 502);
  }
}

export async function checkLocalInboxHealth(signal?: AbortSignal): Promise<void> {
  const body = await getJson<{ ok?: unknown; mode?: unknown }>("/__devcaught/local-inbox/health", signal);
  if (body.ok !== true || body.mode !== "local-capture") {
    throw new LocalInboxApiError("Local SMTP capture is unavailable.", 503);
  }
}

export async function fetchLocalInboxPage(options: {
  limit?: number;
  cursor?: string;
  query?: string;
  signal?: AbortSignal;
} = {}): Promise<LocalInboxPage> {
  const params = new URLSearchParams();
  params.set("limit", String(options.limit ?? 20));
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.query?.trim()) params.set("query", options.query.trim());
  const body = await getJson<Partial<LocalInboxPage> & { ok?: unknown }>(
    `/__devcaught/local-inbox/messages?${params.toString()}`,
    options.signal,
  );
  if (
    body.ok !== true || !Array.isArray(body.items) || typeof body.hasMore !== "boolean" ||
    !(typeof body.nextCursor === "string" || body.nextCursor === null)
  ) {
    throw new LocalInboxApiError("The local inbox returned an invalid response.", 502);
  }
  return { items: body.items, hasMore: body.hasMore, nextCursor: body.nextCursor };
}

export async function fetchLocalInboxMessage(id: string, signal?: AbortSignal): Promise<LocalInboxMessage> {
  const body = await getJson<{ ok?: unknown; message?: LocalInboxMessage }>(
    `/__devcaught/local-inbox/messages/${encodeURIComponent(id)}`,
    signal,
  );
  if (body.ok !== true || !body.message || typeof body.message.textBody !== "string") {
    throw new LocalInboxApiError("The local inbox returned an invalid response.", 502);
  }
  return body.message;
}
