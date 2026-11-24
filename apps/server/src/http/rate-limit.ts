import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";

export interface RateLimitOptions {
  limit?: number;
  windowMs?: number;
  maxKeys?: number;
  totalLimit?: number;
  now?: () => number;
}

/** Fixed-window admission control. No timers, no unbounded peer registry, no
 * eviction of active peers (which would let identity rotation reset quotas).
 * The total budget also bounds work from distributed/rotating sources.
 */
export class RequestRateLimiter {
  private readonly peers = new Map<string, number>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly totalLimit: number;
  private readonly now: () => number;
  private resetAt = 0;
  private total = 0;

  constructor(options: RateLimitOptions = {}) {
    this.limit = options.limit ?? 120;
    this.windowMs = options.windowMs ?? 60_000;
    this.maxKeys = options.maxKeys ?? 4096;
    this.totalLimit = options.totalLimit ?? 12_000;
    this.now = options.now ?? Date.now;
    for (const value of [this.limit, this.windowMs, this.maxKeys, this.totalLimit]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid rate limit");
    }
  }

  /** Returns Retry-After seconds when rejected, otherwise zero. */
  check(key: string): number {
    const now = this.now();
    if (now >= this.resetAt) {
      this.peers.clear();
      this.total = 0;
      this.resetAt = now + this.windowMs;
    }
    const used = this.peers.get(key) ?? 0;
    if (this.total >= this.totalLimit || used >= this.limit ||
      (!this.peers.has(key) && this.peers.size >= this.maxKeys)) {
      return Math.max(1, Math.ceil((this.resetAt - now) / 1000));
    }
    this.total++;
    this.peers.set(key, used + 1);
    return 0;
  }
}

/** Ignore all forwarding headers: this listener does not trust reverse proxies.
 * Normalize equivalent IPv6 spellings and group IPv6 clients by /64 to prevent
 * trivial address rotation. IPv4-mapped IPv6 shares the IPv4 bucket.
 */
export function peerRateLimitKey(req: Pick<IncomingMessage, "socket">): string {
  try {
    const address = req.socket.remoteAddress ?? "";
    if (isIP(address) === 4) return address;
    if (isIP(address) !== 6) return "unknown-peer";
    const canonical = new URL(`http://[${address.split("%", 1)[0]}]/`).hostname.slice(1, -1);
    const [head, tail] = canonical.split("::");
    const left = head ? head.split(":") : [];
    const right = tail ? tail.split(":") : [];
    const words = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
    const numbers = words.map(word => Number.parseInt(word, 16));
    if (numbers.length !== 8 || numbers.some(word => !Number.isInteger(word) || word < 0 || word > 0xffff)) {
      return "unknown-peer";
    }
    if (numbers.slice(0, 5).every(word => word === 0) && numbers[5] === 65535) {
      return [numbers[6] >> 8, numbers[6] & 255, numbers[7] >> 8, numbers[7] & 255].join(".");
    }
    return `${numbers.slice(0, 4).map(word => word.toString(16)).join(":")}::/64`;
  } catch {
    // One shared bucket. A parse failure must not skip admission control.
    return "unknown-peer";
  }
}

/** Non-borrowing Web Request ceilings. Their sum is the process aggregate. */
export const WEB_AGGREGATE_CEILING = 600;
export const WEB_REQUEST_BUDGET = {
  authentication: 180,
  capture: 180,
  privateApi: 120,
  controlAnonymous: 30,
  controlSession: 60,
  controlSessionTotal: 90,
  controlSessionMaxKeys: 256,
  windowMs: 60_000,
} as const;

export type WebBudgetClass = "authentication" | "capture" | "private-api" | "control";

export interface WebBudgetOptions {
  authentication?: number;
  capture?: number;
  privateApi?: number;
  controlAnonymous?: number;
  controlSession?: number;
  controlSessionTotal?: number;
  controlSessionMaxKeys?: number;
  windowMs?: number;
  now?: () => number;
  /**
   * HMAC key for the session cookie. `undefined` reads `BETTER_AUTH_SECRET`.
   * `null` or blank refuses every cookie: shape is not authentication.
   */
  sessionSecret?: string | null;
}

// DevCaught-owned session cookie. Duplicated so this limiter does not import
// the auth server (that module throws without DATABASE_URL). Tests assert the
// name matches AUTH_COOKIES.
const SESSION_COOKIE_NAME = "__Host-devcaught-auth.session_token";
const MAX_COOKIE_HEADER = 8192;
const MIN_SESSION_TOKEN = 16;
const MAX_SESSION_TOKEN = 512;
const MAX_SESSION_SECRET = 4096;
/** Standard base64 of HMAC-SHA256, including padding. Matches signed cookies. */
const SESSION_SIGNATURE_LENGTH = 44;

function configuredSessionSecret(override: string | null | undefined): string | null {
  if (override === null) return null;
  const configured = override ?? process.env.BETTER_AUTH_SECRET;
  const trimmed = configured?.trim() ?? "";
  if (!trimmed || trimmed.length > MAX_SESSION_SECRET) return null;
  return trimmed;
}

function printableAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

/** Token when the cookie carries a valid HMAC. Never a syntactic cookie. */
function verifiedSessionToken(value: string, secret: string): string | null {
  const dot = value.lastIndexOf(".");
  if (dot < 1) return null;
  const token = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  if (token.length < MIN_SESSION_TOKEN || token.length > MAX_SESSION_TOKEN) return null;
  if (signature.length !== SESSION_SIGNATURE_LENGTH || !signature.endsWith("=")) return null;
  let presented: Buffer;
  let expected: Buffer;
  try {
    presented = Buffer.from(signature, "base64");
    if (presented.length !== 32) return null;
    expected = createHmac("sha256", secret).update(token).digest();
  } catch {
    return null;
  }
  if (!timingSafeEqual(presented, expected)) return null;
  return token;
}

/**
 * Stable budget key for one signed session, or null when the cookie is
 * missing, malformed, unsigned, or signed with a different secret.
 * A printable cookie value is not proof of authentication.
 */
export function controlSessionKey(
  cookieHeader: string | null | undefined,
  sessionSecret?: string | null,
): string | null {
  const secret = configuredSessionSecret(sessionSecret);
  if (!secret || !cookieHeader || cookieHeader.length > MAX_COOKIE_HEADER) return null;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0 || trimmed.slice(0, separator) !== SESSION_COOKIE_NAME) continue;
    let value = trimmed.slice(separator + 1);
    if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) value = value.slice(1, -1);
    try { value = decodeURIComponent(value); } catch { return null; }
    if (!value || value.length > MAX_SESSION_TOKEN + 1 + SESSION_SIGNATURE_LENGTH) return null;
    if (!printableAscii(value)) return null;
    const token = verifiedSessionToken(value, secret);
    if (!token) return null;
    return createHash("sha256").update(token).digest("hex").slice(0, 32);
  }
  return null;
}

export class WebRequestBudgets {
  private readonly authentication: RequestRateLimiter;
  private readonly capture: RequestRateLimiter;
  private readonly privateApi: RequestRateLimiter;
  private readonly controlAnonymous: RequestRateLimiter;
  private readonly controlSessions: RequestRateLimiter;
  private readonly sessionSecret: string | null;

  constructor(options: WebBudgetOptions = {}) {
    const authentication = options.authentication ?? WEB_REQUEST_BUDGET.authentication;
    const capture = options.capture ?? WEB_REQUEST_BUDGET.capture;
    const privateApi = options.privateApi ?? WEB_REQUEST_BUDGET.privateApi;
    const controlAnonymous = options.controlAnonymous ?? WEB_REQUEST_BUDGET.controlAnonymous;
    const controlSession = options.controlSession ?? WEB_REQUEST_BUDGET.controlSession;
    const controlSessionTotal = options.controlSessionTotal ?? WEB_REQUEST_BUDGET.controlSessionTotal;
    const controlSessionMaxKeys = options.controlSessionMaxKeys ?? WEB_REQUEST_BUDGET.controlSessionMaxKeys;
    const windowMs = options.windowMs ?? WEB_REQUEST_BUDGET.windowMs;
    const ceiling = authentication + capture + privateApi + controlAnonymous + controlSessionTotal;
    if (!Number.isSafeInteger(ceiling) || ceiling < 1 || ceiling > WEB_AGGREGATE_CEILING) {
      throw new Error("Invalid web rate limit aggregate");
    }
    if (!Number.isSafeInteger(controlSession) || controlSession < 1 || controlSession > controlSessionTotal) {
      throw new Error("Invalid web rate limit aggregate");
    }
    const now = options.now;
    const shared = { windowMs, ...(now ? { now } : {}) };
    this.authentication = new RequestRateLimiter({ ...shared, limit: authentication, totalLimit: authentication, maxKeys: 1 });
    this.capture = new RequestRateLimiter({ ...shared, limit: capture, totalLimit: capture, maxKeys: 1 });
    this.privateApi = new RequestRateLimiter({ ...shared, limit: privateApi, totalLimit: privateApi, maxKeys: 1 });
    this.controlAnonymous = new RequestRateLimiter({ ...shared, limit: controlAnonymous, totalLimit: controlAnonymous, maxKeys: 1 });
    this.controlSessions = new RequestRateLimiter({
      ...shared,
      limit: controlSession,
      totalLimit: controlSessionTotal,
      maxKeys: controlSessionMaxKeys,
    });
    this.sessionSecret = configuredSessionSecret(options.sessionSecret);
  }

  /** Retry-After seconds, or zero when admitted. Classes do not share counters. */
  check(budget: WebBudgetClass, cookieHeader?: string | null): number {
    if (budget === "authentication") return this.authentication.check("authentication");
    if (budget === "capture") return this.capture.check("capture");
    if (budget === "private-api") return this.privateApi.check("private-api");
    // Signature check is local HMAC, after the header-size bound, and only for
    // this class. It is not a database session lookup. Invalid cookies never
    // allocate a session key; they share the single anonymous counter.
    const session = controlSessionKey(cookieHeader, this.sessionSecret);
    if (!session) return this.controlAnonymous.check("anonymous");
    return this.controlSessions.check(session);
  }
}

type WebBudgetGlobal = typeof globalThis & { __devcaughtWebBudgets?: WebRequestBudgets };

/** Test seam. Passing undefined restores the production budgets on next use. */
export function useWebBudgets(budgets: WebRequestBudgets | undefined): void {
  const slot = globalThis as WebBudgetGlobal;
  if (budgets) slot.__devcaughtWebBudgets = budgets;
  else delete slot.__devcaughtWebBudgets;
}

function webBudgets(): WebRequestBudgets {
  const slot = globalThis as WebBudgetGlobal;
  return slot.__devcaughtWebBudgets ??= new WebRequestBudgets();
}

function cookieHeader(request?: Pick<Request, "headers">): string | null {
  return request?.headers.get("cookie") ?? null;
}

/**
 * Web Request has no authenticated transport peer. Forwarded and
 * X-Forwarded-For headers are ignored so a client cannot mint budgets.
 * Authentication, capture, and private API each have a non-borrowing ceiling.
 * Control operations (sign-out, get-session) use a separate ceiling. Only a
 * cookie whose HMAC matches the configured secret can spend the per-session
 * budget. Forged, unsigned, and secret-less cookies share the anonymous
 * ceiling and cannot grow the session-key map. The ceilings sum to
 * WEB_AGGREGATE_CEILING.
 */
export function limitWebRequest(budget: WebBudgetClass, request?: Pick<Request, "headers">): Response | undefined {
  const retry = webBudgets().check(budget, cookieHeader(request));
  if (retry) return Response.json({ error: "Too many requests" }, {
    status: 429,
    headers: { "retry-after": String(retry), "cache-control": "no-store" },
  });
}
