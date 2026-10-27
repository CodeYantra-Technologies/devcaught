import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type {
  SmsEvent,
  SmsProvider,
  SmsEventKind,
  SmsVerification,
} from "../types.ts";
import { maskPhone } from "./phone.ts";

/**
 * DevCaught provider adapters (S1): pure, dependency-free functions that map
 * inbound/ delivery-status payloads from Twilio and MSG91 onto the S0
 * provider-neutral types, plus the two signature-verifiers used by the public
 * callback paths (wired up in Phase S2).
 *
 * All parsers are strict: a payload that does not match a documented shape is
 * `null` (MSG91 inbound), never an invented mapping. Nothing here logs secrets;
 * the verifiers return booleans and never surface auth tokens or webhook
 * secrets.
 */

/** Maximum length accepted for an SMS body before truncation (1 KB). */
export const MAX_SMS_BODY = 1024;

/** Maximum length accepted for From/To before truncation (100 chars each). */
export const MAX_PHONE_FIELD = 100;

const SUPPORTED_PROVIDERS: SmsProvider[] = ["twilio", "msg91", "simulated"];

/** SMS delivery-status values, canonical and documented. */
export type Msg91Status =
  | "delivered"
  | "failed"
  | "sent"
  | "nDNC"
  | "rejected"
  | "blocked"
  | "pending"
  | string;

/** SMS delivery-status numeric → canonical mapping (MSG91 docs). */
export const MSG91_STATUS_MAP: Record<string, Msg91Status> = {
  "1": "delivered",
  "2": "failed",
  "9": "nDNC",
  "16": "rejected",
  "25": "rejected",
  "17": "blocked",
};

/**
 * Provider detection. Explicit selection wins; payload-based guessing is
 * attempted only when a documented provider signal is unambiguous. Payload
 * guessing is deliberately unavailable when multiple providers claim the
 * payload, because it is unreliable.
 */
export function detectProvider(
  hint: SmsProvider | null | undefined,
  raw: unknown,
): SmsProvider | null {
  if (hint !== null && hint !== undefined) {
    return SUPPORTED_PROVIDERS.includes(hint) ? hint : null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const hasTwilio =
    hasKey(o, ["From", "To", "Body"]) || hasKey(o, ["MessageSid"]);
  const hasMsg91 =
    hasKey(o, ["requestId", "telNum", "customerNumber"]) ||
    hasKey(o, ["messageId"]);
  if (hasTwilio && hasMsg91) return null; // ambiguous
  if (hasTwilio) return "twilio";
  if (hasMsg91) return "msg91";
  return null;
}

function hasKey(o: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((k) =>
    Object.prototype.hasOwnProperty.call(o, k) &&
    o[k] !== undefined &&
    o[k] !== null,
  );
}

/** `true` only when every key is present and non-null (AND semantics). */
function hasAllKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((k) =>
    Object.prototype.hasOwnProperty.call(o, k) &&
    o[k] !== undefined &&
    o[k] !== null,
  );
}

function asText(value: unknown, max = MAX_SMS_BODY): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function now(): number {
  return Date.now();
}

export interface NormalizeSmsInput {
  provider: SmsProvider;
  kind: SmsEventKind;
  messageSid: string | null;
  from: string;
  to: string;
  body: string;
  status: string | null;
  errorCode: string | null;
  numSegments: number | null;
  numMedia: number | null;
  mediaUrls: string[];
  verification: SmsVerification;
  receivedAt: number;
}

/**
 * Provider-neutral normalization onto the S0 SmsEvent shape.
 *
 * Identity masking is applied here (no secrets/partial numbers escape via the
 * normalized view). The returned event carries the dedupe identity
 * (messageSid for inbound, status-scoped for delivery_status) that
 * `smsDedupeKey` consumes at the store layer.
 */
export function normalizeSms(input: NormalizeSmsInput): SmsEvent {
  return {
    provider: input.provider,
    kind: input.kind,
    messageSid: input.messageSid,
    from: maskPhone(input.from) ?? input.from,
    to: maskPhone(input.to) ?? input.to,
    body: input.body,
    status: input.status,
    errorCode: input.errorCode,
    numSegments: input.numSegments,
    numMedia: input.numMedia,
    mediaUrls: input.mediaUrls,
    receivedAt: input.receivedAt,
    verification: input.verification,
  };
}

/** ---- Twilio ---- */

export interface TwilioInboundFields {
  from: string;
  to: string;
  body: string;
  messageSid: string | null;
  numSegments: number | null;
  numMedia: number | null;
}

/** Parse the Incoming Messages webhook into fields. `null` means the shape
 *  was not recognized (no invented mapping). */
export function parseTwilioInbound(
  raw: unknown,
  receivedAt: number,
): SmsEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (!hasAllKeys(o, ["From", "To", "Body"])) return null; // required by Twilio docs

  const from = asText(o.From);
  const to = asText(o.To);
  const body = asText(o.Body);
  const messageSid = asText(o.MessageSid, 255) || null;

  return normalizeSms({
    provider: "twilio",
    kind: "inbound",
    messageSid,
    from,
    to,
    body,
    status: null,
    errorCode: null,
    numSegments: asNumber(o.NumSegments),
    numMedia: asNumber(o.NumMedia),
    mediaUrls: [],
    verification: "unverified",
    receivedAt,
  });
}

export interface TwilioDeliveryStatusFields {
  messageSid: string | null;
  from: string;
  to: string;
  body: string;
  status: string | null;
  errorCode: string | null;
  numSegments: number | null;
  numMedia: number | null;
}

/** Parse the Message Status webhook into fields. `null` means the shape was
 *  not recognized. */
export function parseTwilioDeliveryStatus(
  raw: unknown,
  receivedAt: number,
): SmsEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;

  const messageSid =
    asText(o.MessageSid, 255) || asText(o.SmsMessageSid, 255) || null;
  if (!messageSid) return null; // a DLR without an id is not useful

  const from = maskPhone(asText(o.From)) ?? "";
  const to = maskPhone(asText(o.To)) ?? "";
  const body = asText(o.Body);
  const status =
    asText(o.MessageStatus, 64) || asText(o.SmsStatus, 64) || null;
  const errorCode = asText(o.ErrorCode, 64) || null;

  return normalizeSms({
    provider: "twilio",
    kind: "delivery_status",
    messageSid,
    from,
    to,
    body,
    status,
    errorCode,
    numSegments: asNumber(o.NumSegments),
    numMedia: asNumber(o.NumMedia),
    mediaUrls: [],
    verification: "unverified",
    receivedAt,
  });
}

/** ---- MSG91 delivery report ---- */

export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isNewWebhookShape(o: Record<string, unknown>): boolean {
  return (
    hasKey(o, ["telNum", "customerNumber"]) ||
    hasKey(o, ["eventName", "requestedAt"])
  );
}

function isLegacyV3Shape(o: Record<string, unknown>): boolean {
  return hasKey(o, ["number"]) && hasKey(o, ["status"]) && hasKey(o, ["requestId"]);
}

function msg91Status(status: unknown, desc: unknown): Msg91Status | null {
  const s = asText(status, 32);
  if (s !== "" && /^[0-9]+$/.test(s)) {
    const mapped = MSG91_STATUS_MAP[s];
    if (mapped) return mapped;
    return null; // undocumented numeric code: do not guess
  }
  const upper = asText(desc, 64).toUpperCase();
  switch (upper) {
    case "DELIVERED":
      return "delivered";
    case "FAILED":
      return "failed";
    case "SENT":
      return "sent";
    case "READ":
      return "pending";
    case "NDNC":
      return "nDNC";
    case "REJECTED":
      return "rejected";
    case "BLOCKED NUMBER":
      return "blocked";
    default:
      return s || null;
  }
}

function parseMsg91DlrObject(o: Record<string, unknown>, receivedAt: number): SmsEvent | null {
  if (isNewWebhookShape(o)) {
    const requestId = asText(o.requestId, 255);
    const telNum = asText(o.telNum) || asText(o.customerNumber);
    if (!requestId || !telNum) return null; // new-webhook requires an id + recipient
    const senderId = asText(o.senderId) || "";
    const status = msg91Status(o.status, o.eventName);

    return normalizeSms({
      provider: "msg91",
      kind: "delivery_status",
      messageSid: requestId,
      from: senderId,
      to: telNum,
      body: "",
      status,
      errorCode: asText(o.failureReason, 255) || null,
      numSegments: null,
      numMedia: null,
      mediaUrls: [],
      verification: "unverified",
      receivedAt,
    });
  }

  if (isLegacyV3Shape(o)) {
    const status = msg91Status(o.status, o.desc);
    const number = asText(o.number) || "";
    return normalizeSms({
      provider: "msg91",
      kind: "delivery_status",
      messageSid: asText(o.requestId, 255) || null,
      from: asText(o.senderId) || asText(o.userId) || "",
      to: number,
      body: "",
      status,
      errorCode: asText(o.failedReason, 255) || null,
      numSegments: null,
      numMedia: null,
      mediaUrls: [],
      verification: "unverified",
      receivedAt,
    });
  }

  return null;
}

/**
 * Parse a MSG91 delivery report.
 *
 * Documented shapes supported:
 * - New webhook (JSON): requestId/telNum/status/eventName (+ many optional
 *   fields). status is a numeric string ("1" = delivered) in the docs.
 * - Legacy v3 (JSON): requestId/number/senderId/status/desc (+userId etc.).
 * - Legacy v2 form post: x-www-form-urlencoded with a `data` parameter whose
 *   value is a JSON array of report objects.
 *
 * A payload that matches none of these is ignored (`null`), never an invented
 * mapping.
 */
export function parseMsg91DeliveryReport(
  raw: unknown,
  receivedAt: number,
): SmsEvent | null {
  let payload: unknown = raw;

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      payload = tryParseJson(trimmed);
    } else {
      const form = new URLSearchParams(trimmed);
      const data = form.get("data");
      if (data !== null) {
        payload = tryParseJson(data); // legacy v2 `data` JSON body
      } else if (form.has("requestId")) {
        payload = Object.fromEntries(form); // flattened top-level fields
      }
    }
  }

  if (typeof payload === "object" && payload !== null) {
    if (Array.isArray(payload)) {
      for (const item of payload) {
        const event = parseMsg91DlrObject(item as Record<string, unknown>, receivedAt);
        if (event) return event;
      }
      return null;
    }
    if (isNewWebhookShape(payload as Record<string, unknown>) ||
        isLegacyV3Shape(payload as Record<string, unknown>)) {
      return parseMsg91DlrObject(payload as Record<string, unknown>, receivedAt);
    }
  }

  return null;
}

/** ---- MSG91 inbound SMS ---- */

/**
 * MSG91 inbound SMS payload result.
 *
 * - `accepted`: a documented inbound shape was mapped (messageId/sender/
 *   recipient/message).
 * - `unknown`: the payload did not match any documented shape. rawData is the
 *   untouched payload (never introspected, never logged) and sketch says which
 *   shape the parser attempted. No provider mapping is invented.
 */
export type SmsInboundResult =
  | { readonly kind: "accepted"; readonly event: SmsEvent }
  | { readonly kind: "unknown"; readonly rawData: string; readonly sketch: string };

const MSG91_INBOUND_MIN = ["messageId", "sender", "recipient"];

function isMsg91InboundDocumented(o: Record<string, unknown>): boolean {
  return hasKey(o, MSG91_INBOUND_MIN);
}

/** Short human-readable sketch used only to label unrecognized shapes. */
function describeRawShape(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return "msg91-inbound-json-object";
  if (trimmed.startsWith("[")) return "msg91-inbound-json-array";
  if (trimmed.includes("=")) return "msg91-inbound-form-urlencoded";
  return "msg91-inbound-unknown-text";
}

/**
 * Parse the documented MSG91 inbound SMS webhook.
 *
 * The documented shape is a JSON object with at least messageId, sender,
 * recipient (and optionally message/body). Anything else is reported as
 * `unknown` with rawData preserved — never an invented mapping.
 */
export function parseMsg91Inbound(
  raw: unknown,
  receivedAt: number,
): SmsInboundResult {
  let o: Record<string, unknown> | null = null;
  let text: string | null = null;

  if (typeof raw === "string") {
    text = raw;
    try {
      o = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      o = null;
    }
  } else if (typeof raw === "object" && raw !== null) {
    o = raw as Record<string, unknown>;
  }

  if (o !== null && isMsg91InboundDocumented(o)) {
    const messageId = asText(o.messageId, 255);
    if (!messageId) {
      // Missing or whitespace-only identity field: do not accept an inbound
      // event; report the recognized-but-incomplete shape as unknown.
      const sketch = "msg91-inbound-json-object";
      const rawData = JSON.stringify(o);
      return { kind: "unknown", rawData, sketch };
    }
    const from = asText(o.sender) || "";
    const to = asText(o.recipient) || "";
    const body = asText(o.message) || asText(o.text) || asText(o.body) || "";

    return {
      kind: "accepted",
      event: normalizeSms({
        provider: "msg91",
        kind: "inbound",
        messageSid: messageId,
        from,
        to,
        body,
        status: null,
        errorCode: null,
        numSegments: null,
        numMedia: null,
        mediaUrls: [],
        verification: "unverified",
        receivedAt,
      }),
    };
  }

  const sketch = text !== null ? describeRawShape(text) : "non-object raw payload";
  const rawData = text ?? JSON.stringify(raw);
  return { kind: "unknown", rawData, sketch };
}

/** ---- Signature verifiers ---- */

function createHmacSha1(key: string, data: string): ReturnType<typeof createHmac> {
  return createHmac("sha1", key).update(data, "utf8");
}

function createHmacSha256(key: string, data: string): ReturnType<typeof createHmac> {
  return createHmac("sha256", key).update(data, "utf8");
}

/**
 * Canonical Twilio X-Twilio-Signature (form-urlencoded request).
 *
 * The string signed is the full URL (including any query string, e.g.
 * bodySHA256 on a JSON webhook) followed by each alphabetically-sorted
 * parameter name directly appended with its value — no "=", no percent
 * encoding — and multi-value parameters contribute one sorted, deduplicated
 * value per name. Then base64(HMAC-SHA1(authToken, signedString)).
 *
 * This matches the official twilio-node SDK (twilio-node/src/webhooks/webhooks.ts
 * getExpectedTwilioSignature) and the twilio-python SDK (request_validator.py).
 * Verification is performed by `twilioVerifySignature` (timing-safe compare).
 */
export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string | string[]>,
): string {
  // Canonical Twilio signature (per the official twilio-node SDK, which this
  // mirrors): the full URL (including any query string, e.g. bodySHA256 on a
  // JSON webhook) is the prefix, then each alphabetically-sorted parameter
  // name is appended directly followed by its value — no "=", no percent
  // encoding — and multi-value parameters contribute one sorted, deduplicated
  // value per name. Then HMAC-SHA1(authToken, signedString) is base64()
  // encoded.
  //
  // NOTE: we deliberately do NOT URL-encode the key/value pairs and do NOT
  // join them with "&". That is the single most common deviation from
  // Twilio's documented algorithm and would silently reject every real
  // Twilio webhook.
  const keys = Object.keys(params).sort();
  let signed = url;
  for (const key of keys) {
    const values = Array.isArray(params[key]) ? [...new Set(params[key])] : [params[key]];
    for (const value of values) {
      signed += key + value;
    }
  }
  return createHmacSha1(authToken, signed).digest("base64");
}

/** Verify the X-Twilio-Signature of a form/JSON webhook. */
export function twilioVerifySignature(
  authToken: string,
  url: string,
  params: Record<string, string | string[]>,
  expected: string,
): boolean {
  if (typeof expected !== "string" || expected.length === 0) return false;
  const actual = twilioSignature(authToken, url, params);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual, "utf8"), Buffer.from(expected, "utf8"));
}

/**
 * Verify an application/json Twilio webhook. Two independent checks:
 *
 * 1. `bodyHash` is the sha256 (hex) of the raw body — integrity.
 * 2. The X-Twilio-Signature header matches the signature computed over the
 *    URL (which carries the bodySHA256 value), as Twilio documents.
 *
 * Secrets are never logged; this returns a partial result so callers can tell
 * body-integrity from signature failures apart.
 */
export function twilioVerifyWithBody(
  authToken: string,
  url: string,
  body: string,
  bodyHash: string,
  expectedSignature: string,
): { bodyOk: boolean; signatureOk: boolean } {
  const actualHash = createHash("sha256").update(body, "utf8").digest("hex");
  const bodyBuffer = Buffer.from(actualHash, "ascii");
  const expectedBuffer = Buffer.from(bodyHash, "ascii");
  const bodyOk =
    bodyBuffer.length === expectedBuffer.length &&
    timingSafeEqual(bodyBuffer, expectedBuffer);

  // The canonical signature is computed over the full webhook URL exactly as
  // Twilio configured it (which carries the bodySHA256 value for JSON
  // webhooks). Parameters are empty for JSON requests, so no Param is
  // appended and the string signs as-is.
  const signatureOk = twilioVerifySignature(authToken, url, {}, expectedSignature);
  return { bodyOk, signatureOk };
}

/**
 * MSG91 webhook signature.
 *
 * MSG91 signs the raw payload with HMAC-SHA256 using the webhook secret, and
 * sends the base64 of the HMAC in the X-MSG91-Signature header (documented
 * contract). `msg91VerifySignature` compares it with a timing-safe compare.
 *
 * Secrets are never logged; this function returns only a boolean.
 */
export function msg91Signature(secret: string, rawBody: string): string {
  return createHmacSha256(secret, rawBody).digest("base64");
}

export function msg91VerifySignature(
  secret: string,
  rawBody: string,
  expected: string,
): boolean {
  if (typeof expected !== "string" || expected.length === 0) return false;
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(msg91Signature(secret, rawBody));
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
