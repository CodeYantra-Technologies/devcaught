import path from "node:path";
import {
  DEFAULT_DB_PATH,
  DEFAULT_HOST,
  DEFAULT_HTTP_PORT,
  DEFAULT_SMTP_PORT,
  DEFAULT_SMTP_SIZE_LIMIT,
  MIN_NODE_VERSION,
} from "../../../packages/shared/src/constants.ts";

export interface DevCaughtConfig {
  /** Explicit opt-in only; unset retains the existing SMTP behavior. */
  smtpRoutingMode?: 'private';
  smsRoutingMode?: 'private';
  twilioAccountSid?: string;
  host: string;
  smtpPort: number;
  httpPort: number;
  dbPath: string;
  smtpSizeLimit: number;
  /** Delete messages older than this many days. 0 = disabled (default). */
  retentionDays: number;
  /** Keep at most this many messages (newest kept). 0 = disabled (default). */
  maxMessages: number;
  /** Optional Twilio auth token required to verify X-Twilio-Signature (fail-closed). */
  twilioAuthToken?: string;
  /** Optional Twilio public callback URL (absolute HTTPS, no credentials, no fragment). */
  twilioPublicUrl?: string;
}

function readPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535 (got "${raw}").`);
  }
  return value;
}

function readSize(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1024) {
    throw new Error(`${name} must be a byte size of at least 1024 (got "${raw}").`);
  }
  return value;
}

function readCount(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer (got "${raw}").`);
  }
  return value;
}

/**
 * Validate the Twilio public callback URL and return it, preserving the
 * configured path and query exactly.
 *
 * Returns undefined unless the value is an absolute HTTPS URL with no embedded
 * credentials and no fragment.
 */
export function parseTwilioPublicUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return undefined;
    if (url.username !== "" || url.password !== "")
      return undefined;
    if (url.hash !== "") return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export function parseNodeVersion(version: string): { major: number; minor: number; patch: number } {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  return { major, minor, patch };
}

export function isSupportedNode(version = process.versions.node): boolean {
  const minimum = parseNodeVersion(MIN_NODE_VERSION);
  const current = parseNodeVersion(version);
  if (current.major !== minimum.major) return current.major > minimum.major;
  if (current.minor !== minimum.minor) return current.minor > minimum.minor;
  return current.patch >= minimum.patch;
}

export function assertSupportedNode(version = process.versions.node): void {
  if (isSupportedNode(version)) return;
  throw new Error(
    [
      `DevCaught requires Node.js ${MIN_NODE_VERSION} or later (found v${version}).`,
      "This LTS line includes the built-in node:sqlite driver, so npm install does not compile a native SQLite addon on Windows, macOS, or Linux.",
    ].join("\n"),
  );
}

export function loadConfig(cwd = process.cwd()): DevCaughtConfig {
  const smtpRouting = process.env.DEVCAUGHT_SMTP_ROUTING_MODE;
  if (smtpRouting !== undefined && smtpRouting !== '' && smtpRouting !== 'private') {
    throw new Error('DEVCAUGHT_SMTP_ROUTING_MODE must be unset or private');
  }
  const smsRouting = process.env.DEVCAUGHT_SMS_ROUTING_MODE;
  if (smsRouting !== undefined && smsRouting !== '' && smsRouting !== 'private') {
    throw new Error('DEVCAUGHT_SMS_ROUTING_MODE must be unset or private');
  }
  const host = process.env.DEVCAUGHT_HOST?.trim() || DEFAULT_HOST;
  const dbPathRaw = process.env.DEVCAUGHT_DB_PATH?.trim() || DEFAULT_DB_PATH;
  if (smsRouting === 'private' && dbPathRaw === ':memory:') {
    throw new Error('Private SMS requires persistent SQLite storage');
  }
  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioPublicUrl =
    process.env.TWILIO_PUBLIC_URL && parseTwilioPublicUrl(process.env.TWILIO_PUBLIC_URL);
  const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
  if (smsRouting === 'private' && (!twilioAuthToken?.trim() || !twilioPublicUrl ||
    !/^AC[0-9a-fA-F]{32}$/.test(twilioAccountSid ?? ''))) {
    throw new Error('Private SMS requires a Twilio account, token and HTTPS callback URL');
  }
  return {
    ...(smtpRouting === 'private' ? {smtpRoutingMode: 'private' as const} : {}),
    ...(smsRouting === 'private' ? {smsRoutingMode: 'private' as const, twilioAccountSid} : {}),
    host,
    smtpPort: readPort("DEVCAUGHT_SMTP_PORT", DEFAULT_SMTP_PORT),
    httpPort: readPort("DEVCAUGHT_HTTP_PORT", DEFAULT_HTTP_PORT),
    dbPath: path.isAbsolute(dbPathRaw) ? dbPathRaw : path.join(cwd, dbPathRaw),
    smtpSizeLimit: readSize("DEVCAUGHT_SMTP_SIZE_LIMIT", DEFAULT_SMTP_SIZE_LIMIT),
    retentionDays: readCount("DEVCAUGHT_RETENTION_DAYS", 0),
    maxMessages: readCount("DEVCAUGHT_MAX_MESSAGES", 0),
    twilioAuthToken,
    twilioPublicUrl,
  };
}

export function portInUseMessage(
  service: "SMTP" | "HTTP",
  host: string,
  port: number,
  envName: string,
): string {
  return [
    `DevCaught could not start the ${service} server on ${host}:${port} because that port is already in use.`,
    `Set ${envName} to a free port, for example:`,
    `  ${envName}=${port + 1} npm run dev`,
  ].join("\n");
}
