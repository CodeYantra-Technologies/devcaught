import type { NormalizedMessage, WebhookRequest } from "../../../../packages/shared/src/types.ts";

export const WEBHOOK_SIZE_LIMIT = 1024 * 1024;

/** Headers that carry credentials or session material. Matched case-insensitively. */
const SENSITIVE_HEADER_KEYS = new Set([
  "cookie",
  "set-cookie",
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "x-api-token",
  "x-client-token",
  "x-auth-token",
  "x-access-token",
  "x-csrf-token",
  "x-csrftoken",
  "frontend-token",
]);

/**
 * Redact sensitive headers without mutating the caller's object.
 * Case-insensitive header-name matching; non-sensitive headers pass through.
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = SENSITIVE_HEADER_KEYS.has(key.toLowerCase()) ? "[REDACTED]" : value;
  }
  return redacted;
}

export function normalizeWebhook(request: WebhookRequest): NormalizedMessage {
  let textBody = request.body;
  let event: string | undefined;
  try {
    const json: unknown = JSON.parse(request.body);
    textBody = JSON.stringify(json, null, 2);
    if (json && typeof json === "object" && !Array.isArray(json)) {
      const record = json as Record<string, unknown>;
      const name = record.type ?? record.event;
      if (typeof name === "string") event = name.slice(0, 250);
    }
  } catch {
    /* Preserve non-JSON and malformed JSON requests for inspection. */
  }
  const redactedHeaders = redactHeaders(request.headers);
  return {
    type: "webhook",
    source: "http",
    sender: request.headers["user-agent"] ?? "HTTP client",
    recipient: request.url,
    subject: event ?? `${request.method} ${request.url.split("?")[0]}`,
    textBody,
    htmlBody: "",
    // Sensitive headers are redacted BEFORE serialization/storage.
    rawData: JSON.stringify({ ...request, headers: redactedHeaders }),
    createdAt: Date.now(),
  };
}
