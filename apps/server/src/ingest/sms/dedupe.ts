import { createHash } from "node:crypto";
import type { SmsEvent } from "../../../../../packages/shared/src/types.ts";

/**
 * Stable deduplication key for a provider SMS event, or null when the event has
 * no stable identity — simulated events are never deduplicated.
 *
 * Identity rules (providers retry callbacks at-least-once, and DevCaught must
 * keep every DISTINCT delivery-status transition while collapsing retries):
 *
 * - A provider message id (Twilio MessageSid / MSG91 requestId) is the stable
 *   identity for inbound events.
 * - Delivery-status transitions share the provider message id, so the key is
 *   SCOPED to the status: delivered → failed yields two rows; a retry of the
 *   same transition collapses to one.
 * - No message id: fall back to a fingerprint of the canonical payload, which
 *   still collapses exact retries without discinating distinct events.
 */
export function smsDedupeKey(event: SmsEvent): string | null {
  if (event.provider === "simulated") return null;
  const scope = event.kind === "inbound" ? "in" : `dlr:${event.status ?? "unknown"}`;
  if (event.messageSid) return `sms:${event.provider}:${scope}:${event.messageSid}`;
  return `sms:${event.provider}:${scope}:fp:${eventFingerprint(event)}`;
}

function eventFingerprint(event: SmsEvent): string {
  const canonical = JSON.stringify([
    event.provider,
    event.kind,
    event.from,
    event.to,
    event.body,
    event.status ?? null,
    event.errorCode ?? null,
  ]);
  return createHash("sha256").update(canonical).digest("base64url").slice(0, 32);
}
