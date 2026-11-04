export type LocalInboxChannel = "all" | "email" | "sms" | "webhook";

interface LocalInboxSummaryBase {
  id: string;
  subject: string | null;
  createdAt: number;
  hasHtml: boolean;
  hasText: boolean;
}

export interface LocalEmailSummary extends LocalInboxSummaryBase {
  type: "email";
  source: "smtp";
  sender: string;
  recipient: string;
}

export interface LocalWebhookSummary extends LocalInboxSummaryBase {
  type: "webhook";
  source: "http";
  method: "POST";
}

export interface LocalSmsSummary extends LocalInboxSummaryBase {
  type: "sms";
  source: "simulated";
  sender: string;
  recipient: string;
  body: string;
  provider: "simulated";
  verification: "local";
}

export type LocalInboxSummary = LocalEmailSummary | LocalSmsSummary | LocalWebhookSummary;

export interface LocalEmailMessage extends LocalEmailSummary {
  textBody: string;
}

export interface LocalWebhookMessage extends LocalWebhookSummary {
  textBody: string;
}

export type LocalSmsMessage = LocalSmsSummary;

export type LocalInboxMessage = LocalEmailMessage | LocalSmsMessage | LocalWebhookMessage;

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
        ? "Local capture service is unavailable. Check that DevCaught is running in local mode."
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
    throw new LocalInboxApiError("Local capture service is unavailable.", 503);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCommonSummary(value: Record<string, unknown>): boolean {
  return typeof value.id === "string" && (typeof value.subject === "string" || value.subject === null) &&
    typeof value.createdAt === "number" && Number.isFinite(value.createdAt) &&
    typeof value.hasHtml === "boolean" && typeof value.hasText === "boolean";
}

function isLocalInboxSummary(value: unknown): value is LocalInboxSummary {
  if (!isRecord(value) || !hasCommonSummary(value)) return false;
  if (value.type === "email") return value.source === "smtp" && typeof value.sender === "string" && typeof value.recipient === "string";
  if (value.type === "sms") return value.source === "simulated" && typeof value.sender === "string" &&
    typeof value.recipient === "string" && typeof value.body === "string" && value.provider === "simulated" && value.verification === "local";
  if (value.type === "webhook") return value.source === "http" && value.method === "POST";
  return false;
}

function isLocalInboxMessage(value: unknown): value is LocalInboxMessage {
  if (!isLocalInboxSummary(value) || !isRecord(value)) return false;
  return value.type === "sms" || typeof value.textBody === "string";
}

export async function fetchLocalInboxPage(options: {
  limit?: number;
  cursor?: string;
  query?: string;
  channel?: LocalInboxChannel;
  signal?: AbortSignal;
} = {}): Promise<LocalInboxPage> {
  const params = new URLSearchParams();
  params.set("limit", String(options.limit ?? 20));
  params.set("channel", options.channel ?? "all");
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.query?.trim()) params.set("query", options.query.trim());
  const body = await getJson<Partial<LocalInboxPage> & { ok?: unknown }>(
    `/__devcaught/local-inbox/messages?${params.toString()}`,
    options.signal,
  );
  if (
    body.ok !== true || !Array.isArray(body.items) || !body.items.every(isLocalInboxSummary) || typeof body.hasMore !== "boolean" ||
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
  if (body.ok !== true || !isLocalInboxMessage(body.message)) {
    throw new LocalInboxApiError("The local inbox returned an invalid response.", 502);
  }
  return body.message;
}
