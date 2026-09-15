import type { NormalizedMessage, WebhookRequest } from "../../../../packages/shared/src/types.ts";

export const WEBHOOK_SIZE_LIMIT = 1024 * 1024;

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
  return {
    type: "webhook",
    source: "http",
    sender: request.headers["user-agent"] ?? "HTTP client",
    recipient: request.url,
    subject: event ?? `${request.method} ${request.url.split("?")[0]}`,
    textBody,
    htmlBody: "",
    rawData: JSON.stringify(request),
    createdAt: Date.now(),
  };
}
