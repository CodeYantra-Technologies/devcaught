export type MessageType = "email" | "webhook" | "sms" | "push";
export type MessageSource = "smtp" | "http" | "test";
export type DetectionType = "otp" | "url" | "payment" | "order" | "transaction";

/** SMS providers DevCaught can capture callbacks from, plus local simulation. */
export type SmsProvider = "twilio" | "msg91" | "simulated";

/**
 * Provider SMS event kinds. DevCaught is a catcher, not a sender, in V1:
 * "inbound" is a message received on a provider number; "delivery_status" is a
 * provider DLR/status callback for a message the developer's own app sent.
 */
export type SmsEventKind = "inbound" | "delivery_status";

/**
 * Authenticity of an SMS event.
 * - "valid": provider signature/shared secret verified (public ingest with
 *   verification credentials configured).
 * - "invalid": verification failed — must be refused, never stored.
 * - "local": locally simulated; only the isolated simulation path ever
 *   produces this.
 * - "unverified": captured with no way to verify (generic debug capture only;
 *   public provider callbacks must never land here — see resolveSmsIngestPolicy).
 */
export type SmsVerification = "valid" | "invalid" | "local" | "unverified";

/**
 * Provider-neutral SMS event. The full provider payload is always preserved in
 * the message's rawData; this is the normalized view for the dashboard.
 */
export interface SmsEvent {
  provider: SmsProvider;
  kind: SmsEventKind;
  /** Stable provider message id when the provider supplies one. */
  messageSid: string | null;
  from: string;
  to: string;
  body: string;
  /** Delivery status, for delivery_status events ("delivered", "failed", …). */
  status?: string | null;
  errorCode?: string | null;
  numSegments?: number | null;
  numMedia?: number | null;
  mediaUrls?: string[];
  /** Epoch ms the event was captured. */
  receivedAt: number;
  verification: SmsVerification;
}

export interface Detection {
  type: DetectionType;
  value: string;
  confidence: number;
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface NormalizedMessage {
  type: MessageType;
  source: MessageSource;
  sender: string;
  recipient: string;
  subject: string | null;
  textBody: string;
  htmlBody: string;
  rawData: string;
  createdAt: number;
}

export interface StoredMessage extends NormalizedMessage {
  id: string;
  detections: Detection[];
}

/** List payload — never includes raw MIME or HTML bodies. */
export interface MessageSummary {
  id: string;
  type: MessageType;
  source: MessageSource;
  sender: string;
  recipient: string;
  subject: string | null;
  createdAt: number;
  detections: Detection[];
  hasHtml: boolean;
  hasText: boolean;
  /** Normalized SMS view for type "sms" (absent for other types). */
  sms?: SmsEvent;
}

/** Detail payload — includes bodies, never raw MIME. */
export interface MessageDetail extends MessageSummary {
  textBody: string;
  htmlBody: string;
  htmlPreview: string;
  webhook?: WebhookRequest;
  /** Normalized SMS event view, present for type "sms" (raw JSON in rawData). */
  sms?: SmsEvent;
}

export interface ListenerStatus {
  running: boolean;
  host: string;
  port: number;
  error: string | null;
}

export interface DevCaughtStatus {
  product: string;
  smtp: ListenerStatus;
  http: ListenerStatus;
  messageCount: number;
  db: {
    path: string;
    mode: "file" | "memory";
  };
}

export interface TestEmailInput {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface WebhookRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}
