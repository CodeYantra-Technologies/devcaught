import type { Request, Response } from "express";
import {
  parseTwilioDeliveryStatus,
  parseTwilioInbound,
  twilioVerifySignature,
  twilioVerifyWithBody,
} from "../../../../packages/shared/src/sms/adapters.ts";
import { smsDedupeKey } from "./sms/dedupe.ts";
import type { SmsEvent } from "../../../../packages/shared/src/types.ts";
import type { NormalizedMessage } from "../../../../packages/shared/src/types.ts";
import {authenticateSmsRoutingAccount, canonicalSmsDestination, type AuthenticatedSmsAccount} from '../../../../src/lib/inbox/private-inbox-routing.server.ts';
import type {PrivateSmsIngest} from './sms/private-routing.ts';

/**
 * Signed URL reconstruction.
 *
 * Contract: the configured TWILIO_PUBLIC_URL contributes only its scheme,
 * host, and path. The request contributes its exact query string, exactly
 * once. We never re-encode, reorder, decode, or synthesize query parameters,
 * and we never re-add the configured static query params — the incoming
 * query already carries them. Rebuilding the URL this way keeps the string
 * that Twilio signed identical to what the provider sent.
 */
export function buildSignedUrl(publicUrl: string, incomingQuery: string): string {
  const urlWithoutQuery =
    publicUrl.indexOf("?") === -1 ? publicUrl : publicUrl.slice(0, publicUrl.indexOf("?"));
  if (!incomingQuery) return urlWithoutQuery;
  return `${urlWithoutQuery}?${incomingQuery}`;
}

export interface TwilioWebhookConfig {
  smsRoutingMode?: 'private';
  twilioAccountSid?: string;
  /** Raw TWILIO_AUTH_TOKEN (never logged/exposed). */
  twilioAuthToken?: string;
  /** TWILIO_PUBLIC_URL (absolute HTTPS, no credentials, no fragment) as configured. */
  twilioPublicUrl?: string;
}

export interface TwilioWebhookHandler {
  (req: Request, res: Response): Promise<any>;
}

/**
 * Smallest Twilio HTTP callback: form (Signature over URL + params) and JSON
 * (bodySHA256 + URL signature) webhooks, verified before any SMS parsing or
 * persistence. Fails closed when the config is incomplete.
 */
export function createTwilioWebhookHandler(
  config: TwilioWebhookConfig,
  ingestSms: (message: NormalizedMessage, dedupeKey: string | null) => any,
  privateIngest?: PrivateSmsIngest,
): TwilioWebhookHandler {
  const { twilioAuthToken, twilioPublicUrl } = config;
  const privateMode = config.smsRoutingMode === 'private';

  return async (req: Request, res: Response) => {
    if (privateMode && (!privateIngest || !/^AC[0-9a-fA-F]{32}$/.test(config.twilioAccountSid ?? '') ||
      !twilioAuthToken?.trim() || !twilioPublicUrl)) {
      return res.status(503).json({error:'Private SMS unavailable'});
    }
    // Fail-closed: without both configured values, refuse and store nothing.
    if (!twilioAuthToken || !twilioPublicUrl) {
      return res.status(403).json({ error: "Twilio webhook not configured" });
    }

    const signature = req.headers["x-twilio-signature"] as string | undefined;
    if (!signature) {
      return res.status(403).json({ error: "missing signature" });
    }

    const contentType = (req.headers["content-type"] ?? "").toLowerCase();

    // Express `express.raw({ type: () => true })` already materializes req.body
    // as a Buffer for every content type. Keep the exact bytes (never re-serialize).
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? "", "utf8");
    const bodyText = rawBody.toString("utf8");

    // Only the incoming query is contributed by the request; the configured
    // public URL supplies scheme/host/path plus any static query params.
    const incomingQuery =
      req.originalUrl.indexOf("?") >= 0
        ? req.originalUrl.slice(req.originalUrl.indexOf("?") + 1)
        : "";
    const signedUrl = buildSignedUrl(twilioPublicUrl, incomingQuery);

    let event: SmsEvent | null = null;
    let payload: unknown;
    let ambiguous = false;
    let verifyAuthenticity: () => Promise<boolean> = async () => false;

    if (contentType.startsWith("application/json")) {
      // JSON: verify raw-body SHA256 integrity against bodySHA256 in the query,
      // plus the URL signature over the full signed URL (no form params).
      const bodyHash = extractBodyHash(incomingQuery);
      const { bodyOk, signatureOk } = twilioVerifyWithBody(
        twilioAuthToken,
        signedUrl,
        bodyText,
        bodyHash,
        signature,
      );
      if (!bodyOk || !signatureOk) {
        return res.status(403).json({ error: "invalid body or signature" });
      }
      verifyAuthenticity = async () => {
        const checked = twilioVerifyWithBody(twilioAuthToken, signedUrl, bodyText, bodyHash, signature);
        return checked.bodyOk && checked.signatureOk;
      };
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        // Malformed JSON is rejected with 400; nothing is persisted.
        return res.status(400).json({ error: "malformed JSON" });
      }
      // Route the parsed payload to the correct adapter. Inbound (received
      // messages) and delivery-status (message status) webhooks share an
      // endpoint; the shape is distinguished by the error/status fields the
      // provider adds on delivery updates.
      if (privateMode) {
        payload = parsed;
        ambiguous = duplicateJsonKeys(bodyText);
      } else {
        event = isTwilioDeliveryStatus(parsed)
          ? parseTwilioDeliveryStatus(parsed, Date.now())
          : parseTwilioInbound(parsed, Date.now());
      }
    } else if (contentType.includes("x-www-form-urlencoded")) {
      // Form: verify the signature over the signed URL + sorted form params.
      const formParams = parseFormParams(bodyText);
      const signatureOk = twilioVerifySignature(twilioAuthToken, signedUrl, formParams, signature);
      if (!signatureOk) {
        return res.status(403).json({ error: "invalid signature" });
      }
      verifyAuthenticity = async () => twilioVerifySignature(twilioAuthToken, signedUrl, formParams, signature);
      const record: Record<string, string> = {};
      for (const [k, v] of new URLSearchParams(bodyText)) {
        record[k] = v;
      }
      if (privateMode) {
        payload = record;
        ambiguous = Object.values(formParams).some(Array.isArray);
      } else {event = parseTwilioInbound(record, Date.now());}
    } else {
      return res.status(415).json({ error: "unsupported content type" });
    }

    let account: AuthenticatedSmsAccount | undefined;
    let destination: string | undefined;
    if (privateMode) {
      if (ambiguous || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return res.status(400).json({error:'Invalid private SMS payload'});
      }
      const fields = payload as Record<string, unknown>;
      // Inbound Twilio forms can carry SmsStatus=received. Other statuses,
      // errors and status-only shapes must never become private inbound mail.
      if (isTwilioDeliveryStatus(fields) || ['MessageStatus','SmsStatus'].some(key =>
        fields[key] !== undefined && fields[key] !== 'received')) {
        return res.status(400).json({error:'Private SMS supports inbound messages only'});
      }
      if (typeof fields.AccountSid !== 'string' || !/^AC[0-9a-fA-F]{32}$/.test(fields.AccountSid) ||
        typeof fields.To !== 'string' || typeof fields.From !== 'string' || !fields.From.trim() ||
        typeof fields.Body !== 'string' || typeof fields.MessageSid !== 'string' ||
        !/^(SM|MM)[0-9a-fA-F]{32}$/.test(fields.MessageSid) ||
        (fields.SmsMessageSid !== undefined && fields.SmsMessageSid !== fields.MessageSid)) {
        return res.status(400).json({error:'Invalid private SMS identity'});
      }
      try {destination = canonicalSmsDestination(fields.To);}
      catch {return res.status(400).json({error:'Invalid private SMS destination'});}
      try {
        // Bind using the same exact raw request and configured signing credentials,
        // never a caller-supplied verification flag or normalized payload.
        account = await authenticateSmsRoutingAccount('twilio', config.twilioAccountSid!, fields.AccountSid, verifyAuthenticity);
      } catch {return res.status(403).json({error:'Twilio account not authenticated'});}
      // Route using original canonical To; mask only for the normalized view.
      event = parseTwilioInbound({...fields, To:destination}, Date.now());
      if (event) event.verification = 'valid';
    }
    if (!event) {
      return res.status(400).json({ error: "unrecognized payload" });
    }

    // Normalize the parsed event into the shared message shape. The SMS body
    // is preserved under `rawData` only in its normalized form (S0/S1
    // retention truncates bodies to MAX_SMS_BODY); the raw bytes are not
    // retained here.
    const normalized: NormalizedMessage = {
      type: "sms",
      source: "http",
      sender: event.from,
      recipient: event.to,
      subject: event.messageSid,
      textBody: event.body,
      htmlBody: "",
      // Keep the raw provider payload under `sms` so the inbox getter can
      // reconstruct the provider-neutral event without re-parsing the bytes.
      rawData: JSON.stringify({ sms: event, request: { body: event.body } }),
      createdAt: event.receivedAt,
    };

    // Deduplicate provider retries (collapse repeats, keep distinct transitions)
    // and persist through the verified SMS path.
    const dedupeKey = privateMode ? `sms:twilio:account:${account!.accountId}:in:${event.messageSid}` : smsDedupeKey(event);
    let result;
    if (privateMode) {
      try {result = await privateIngest!(account!, destination!, normalized, dedupeKey!);}
      catch(error) {
        const unavailable = (error as {code?:unknown})?.code === 'SMS_ROUTE_UNAVAILABLE';
        return res.status(unavailable ? 404 : 503).json({error:unavailable ? 'SMS route unavailable' : 'SMS ingestion unavailable'});
      }
    } else {result = ingestSms(normalized, dedupeKey);}
    const storedId = result.duplicate ? result.id : result.message.id;
    res.status(200).json({ id: storedId, ok: true });
  };
}

/** JSON.parse loses duplicate properties. Scan only top-level keys after valid
 * JSON and signature verification, accounting for escaped strings/key names. */
function duplicateJsonKeys(text: string): boolean {
  const keys = new Set<string>();
  let depth = 0;
  for (let i=0;i<text.length;i++) {
    const char=text[i];
    if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
    else if (char === '"') {
      const start=i++;
      while(i<text.length && text[i] !== '"') {if(text[i] === '\\')i++;i++;}
      let next=i+1;while(/\s/.test(text[next] ?? '') && next<text.length)next++;
      if(depth === 1 && text[next] === ':') {
        const key=JSON.parse(text.slice(start,i+1)) as string;
        if(keys.has(key))return true;keys.add(key);
      }
    }
  }
  return false;
}

/** True when the parsed payload is a Twilio Message Status (delivery_status)
 * webhook rather than an incoming-message webhook. An inbound message is the
 * full shape From/To/Body; anything else that carries a status or error field
 * is a delivery-status update (a "received" carrier callback is *not* an
 * inbox message by itself and must not be forced through parseTwilioInbound,
 * which requires From/To/Body and would reject it). */
function isTwilioDeliveryStatus(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const o = raw as Record<string, unknown>;
  const hasError =
    Object.prototype.hasOwnProperty.call(o, "ErrorCode") ||
    Object.prototype.hasOwnProperty.call(o, "ErrorMessage");
  if (hasError) return true;
  // Inbound (Incoming Messages) has the full message shape: From, To, Body.
  const isInbound =
    Object.prototype.hasOwnProperty.call(o, "From") &&
    Object.prototype.hasOwnProperty.call(o, "To") &&
    Object.prototype.hasOwnProperty.call(o, "Body");
  if (isInbound) return false;
  // Delivery-status: a status field, without the full inbound body shape.
  const status = o.MessageStatus ?? o.SmsStatus;
  return typeof status === "string" && status.trim().length > 0;
}

function extractBodyHash(query: string): string {
  const match = query.split("&").find((p) => p.startsWith("bodySHA256="));
  return match ? match.split("=")[1] ?? "" : "";
}

function parseFormParams(bodyText: string): Record<string, string | string[]> {
  const params = new URLSearchParams(bodyText);
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of params) {
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      const existing = result[key];
      result[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    } else {
      result[key] = value;
    }
  }
  return result;
}
