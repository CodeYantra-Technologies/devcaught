export type MessageType = "email" | "webhook" | "sms" | "push";
export type MessageSource = "smtp" | "http" | "test";
export type DetectionType = "otp" | "url";

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
}

/** Detail payload — includes bodies, never raw MIME. */
export interface MessageDetail extends MessageSummary {
  textBody: string;
  htmlBody: string;
  htmlPreview: string;
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
