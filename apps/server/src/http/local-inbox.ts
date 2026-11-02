import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect, ViteDevServer } from "vite";
import { isNumericLoopbackHost } from "../config.ts";
import { ensureRuntime, type DevCaughtRuntime } from "../runtime.ts";

const namespace = "/__devcaught/local-inbox";
const capabilityPath = `${namespace}/health`;
const messagesPath = `${namespace}/messages`;
const MAX_PATH_DECODE_PASSES = 32;
const MAX_REQUEST_TARGET_LENGTH = 4_096;
const MAX_QUERY_STRING_LENGTH = 2_048;
const MAX_SEARCH_QUERY_LENGTH = 200;
const MAX_CURSOR_LENGTH = 1_024;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

type RuntimeProvider = () => Promise<DevCaughtRuntime>;

export interface LocalInboxMiddleware {
  handler: (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => void;
  revoke(): void;
}

function rawHeaderValues(req: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]?.toLowerCase() === name) values.push(req.rawHeaders[i + 1] ?? "");
  }
  return values;
}

function matchesNamespacePrefix(path: string): boolean {
  // A decoded encoded-leading-slash alias can begin with `//`. Collapse only
  // that leading run for comparison; do not rewrite request paths globally.
  const candidate = path.replace(/^\/{2,}/, "/");
  return candidate === namespace || candidate.startsWith(`${namespace}/`) ||
    candidate.startsWith(`${namespace}%`) || candidate.startsWith(`${namespace}\\`);
}

function normalizedPathname(path: string): string {
  // Resolve origin-form paths against a fixed origin with the leading slash
  // already attached. This preserves `//` as path characters instead of
  // letting WHATWG URL parsing reinterpret them as an authority.
  const input = path.startsWith("/") ? `http://vite.invalid${path}` : path;
  return new URL(input, "http://vite.invalid").pathname;
}

function decodeValidPercentEscapes(value: string): string {
  // Decode escape bytes independently: one invalid UTF-8 byte such as %FF
  // must not prevent valid ASCII prefix escapes later in the path from decoding.
  return value.replace(/%[0-9a-f]{2}/gi, encoded => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  });
}

/**
 * Recognize raw, URL-normalized and repeatedly encoded namespace prefixes.
 * Decoding is capped at 32 passes. At the cap, any still-escaped path is
 * ambiguous and consumed rather than sent to downstream middleware. Before
 * the cap, no progress means remaining escapes are malformed or non-ASCII
 * bytes; valid ASCII escapes have already been decoded independently.
 */
function isReservedNamespace(target: string): boolean {
  const rawPath = target.split(/[?#]/, 1)[0] ?? "";
  let current = rawPath;
  for (let pass = 0; pass <= MAX_PATH_DECODE_PASSES; pass++) {
    if (matchesNamespacePrefix(current)) return true;
    try {
      const normalized = normalizedPathname(current);
      if (matchesNamespacePrefix(normalized)) return true;
    } catch {
      // Continue with the raw form; malformed reserved prefixes are consumed below.
    }
    if (pass === MAX_PATH_DECODE_PASSES) {
      return current.includes("%");
    }
    const decoded = decodeValidPercentEscapes(current);
    if (decoded === current) return false;
    current = decoded;
  }
  return false;
}

function send(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(JSON.stringify(body));
}

function hasLocalCaptureCapability(runtime: DevCaughtRuntime): boolean {
  return runtime.config.smtpRoutingMode === "local" &&
    runtime.smtp.status.running &&
    isNumericLoopbackHost(runtime.smtp.status.host) &&
    runtime.smtp.status.host === runtime.config.host;
}

type LocalRoute =
  | { kind: "health" }
  | { kind: "list"; limit: number; cursor?: string; query?: string }
  | { kind: "detail"; id: string }
  | { kind: "missing" }
  | { kind: "bad-request" };

function parseLocalRoute(target: string): LocalRoute {
  if (target.length > MAX_REQUEST_TARGET_LENGTH) return { kind: "bad-request" };
  const rawPath = target.split(/[?#]/, 1)[0] ?? "";
  if (rawPath === capabilityPath) return target === capabilityPath ? { kind: "health" } : { kind: "missing" };
  if (target.includes("#")) return rawPath === messagesPath || rawPath.startsWith(`${messagesPath}/`)
    ? { kind: "bad-request" }
    : { kind: "missing" };
  if (rawPath !== messagesPath && !rawPath.startsWith(`${messagesPath}/`)) return { kind: "missing" };
  if (rawPath === messagesPath) {
    const rawQuery = target.includes("?") ? target.slice(target.indexOf("?") + 1) : "";
    if (rawQuery.length > MAX_QUERY_STRING_LENGTH) return { kind: "bad-request" };
    try {
      // URLSearchParams is forgiving of malformed escapes, so validate UTF-8
      // percent encodings before parsing and reject duplicate/unknown keys.
      decodeURIComponent(rawQuery.replace(/\+/g, "%20"));
    } catch {
      return { kind: "bad-request" };
    }
    const params = new URLSearchParams(rawQuery);
    const seen = new Set<string>();
    for (const [key] of params) {
      if (!new Set(["limit", "cursor", "query"]).has(key) || seen.has(key)) return { kind: "bad-request" };
      seen.add(key);
    }
    const rawLimit = params.get("limit");
    let limit = DEFAULT_PAGE_SIZE;
    if (rawLimit !== null) {
      if (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(rawLimit)) return { kind: "bad-request" };
      limit = Number(rawLimit);
    }
    const cursor = params.get("cursor") ?? undefined;
    if (cursor !== undefined && (!cursor || cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)))
      return { kind: "bad-request" };
    const query = params.get("query") ?? undefined;
    if (
      query !== undefined &&
      (query.length > MAX_SEARCH_QUERY_LENGTH || /[\u0000-\u001f\u007f]/.test(query))
    ) return { kind: "bad-request" };
    return { kind: "list", limit, ...(cursor === undefined ? {} : { cursor }), ...(query === undefined ? {} : { query }) };
  }

  const id = rawPath.slice(messagesPath.length + 1);
  if (!id || id.length > 128 || id.includes("/") || !/^[A-Za-z0-9_-]+$/.test(id)) return { kind: "bad-request" };
  if (target.includes("?")) return { kind: "bad-request" };
  return { kind: "detail", id };
}

function safeSummary(message: {
  id: string;
  type: string;
  source: string;
  sender: string;
  recipient: string;
  subject: string | null;
  createdAt: number;
  hasHtml: boolean;
  hasText: boolean;
}) {
  return {
    id: message.id,
    type: message.type,
    source: message.source,
    sender: message.sender,
    recipient: message.recipient,
    subject: message.subject,
    createdAt: message.createdAt,
    hasHtml: message.hasHtml,
    hasText: message.hasText,
  };
}

function loopbackPeer(req: IncomingMessage): boolean {
  const peer = req.socket.remoteAddress;
  if (!peer) return false;
  if (isNumericLoopbackHost(peer)) return true;
  // Node commonly reports an IPv4 loopback peer as an IPv4-mapped IPv6 address
  // when the listener is bound on ::1 / dual-stack.
  return peer.toLowerCase().startsWith("::ffff:") && isNumericLoopbackHost(peer.slice(7));
}

function actualAuthority(server: ViteDevServer): { host: string; port: number; authority: string } | undefined {
  const address = server.httpServer?.address();
  if (!address || typeof address === "string" || !isNumericLoopbackHost(address.address)) return undefined;
  if (!Number.isInteger(address.port) || address.port < 1 || address.port > 65535) return undefined;
  const authority = address.address.includes(":")
    ? `[${address.address}]:${address.port}`
    : `${address.address}:${address.port}`;
  return { host: address.address, port: address.port, authority };
}

function expectedOrigin(req: IncomingMessage, authority: string): string {
  const scheme = (req.socket as typeof req.socket & { encrypted?: boolean }).encrypted ? "https:" : "http:";
  return new URL(`${scheme}//${authority}`).origin;
}

function requestSecurityFailure(req: IncomingMessage, authority: string): string | undefined {
  if (rawHeaderValues(req, "host").length !== 1 || req.headers.host !== authority) return "unavailable";
  if (req.headers["x-forwarded-host"] || req.headers["x-forwarded-proto"] || req.headers["x-forwarded-for"])
    return "unavailable";
  if (!loopbackPeer(req)) return "unavailable";

  const originValues = rawHeaderValues(req, "origin");
  if (originValues.length > 1) return "unavailable";
  if (originValues.length === 1) {
    const origin = originValues[0]!;
    try {
      if (origin === "null" || new URL(origin).origin !== expectedOrigin(req, authority) || origin !== new URL(origin).origin)
        return "unavailable";
    } catch {
      return "unavailable";
    }
  }

  const fetchSites = rawHeaderValues(req, "sec-fetch-site");
  if (fetchSites.length > 1) return "unavailable";
  if (fetchSites.length === 1 && fetchSites[0] !== "same-origin" && fetchSites[0] !== "none")
    return "unavailable";

  if (req.method !== "GET" && req.method !== "HEAD") {
    if (originValues.length !== 1 || originValues[0] !== expectedOrigin(req, authority)) return "unavailable";
    if (fetchSites.length === 1 && fetchSites[0] !== "same-origin") return "unavailable";
  }
  return undefined;
}

/** Development-only gate for the reserved local-capture API namespace. */
export function createLocalInboxMiddleware(
  server: ViteDevServer,
  getRuntime: RuntimeProvider = ensureRuntime,
  livePreview = process.env.DEVCAUGHT_LIVE_PREVIEW === "1",
): LocalInboxMiddleware {
  let active = true;

  const handler = (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction): void => {
    const target = req.url ?? "";
    if (target === "/" && req.method === "GET") {
      void (async () => {
        if (!active || livePreview) {
          next();
          return;
        }
        const bound = actualAuthority(server);
        if (!bound || requestSecurityFailure(req, bound.authority)) {
          next();
          return;
        }

        let runtime: DevCaughtRuntime;
        try {
          runtime = await getRuntime();
        } catch {
          next();
          return;
        }
        if (!active || res.destroyed || res.writableEnded) return;
        if (!hasLocalCaptureCapability(runtime)) {
          next();
          return;
        }

        res.statusCode = 302;
        res.setHeader("location", "/local-inbox");
        res.setHeader("cache-control", "no-store");
        res.end();
      })().catch(() => {
        if (!res.headersSent && !res.destroyed && !res.writableEnded) next();
      });
      return;
    }
    if (!isReservedNamespace(target)) {
      next();
      return;
    }

    void (async () => {
      if (!active || livePreview) {
        send(res, 503, { ok: false, error: "Unavailable" });
        return;
      }
      const bound = actualAuthority(server);
      if (!bound || requestSecurityFailure(req, bound.authority)) {
        send(res, 403, { ok: false, error: "Unavailable" });
        return;
      }

      const route = parseLocalRoute(target);
      if (route.kind === "bad-request") {
        send(res, 400, { ok: false, error: "Invalid request" });
        return;
      }
      if (route.kind === "missing") {
        send(res, req.method === "GET" ? 404 : 405, { ok: false, error: req.method === "GET" ? "Not found" : "Method not allowed" });
        return;
      }
      if (req.method !== "GET") {
        send(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }

      let runtime: DevCaughtRuntime;
      try {
        runtime = await getRuntime();
      } catch {
        send(res, 503, { ok: false, error: "Unavailable" });
        return;
      }
      if (!active || res.destroyed || res.writableEnded) return;
      if (!active || !hasLocalCaptureCapability(runtime)) {
        send(res, 503, { ok: false, error: "Unavailable" });
        return;
      }

      if (route.kind === "health") {
        send(res, 200, { ok: true, mode: "local-capture" });
        return;
      }
      if (!runtime.store || typeof runtime.store.forLocalCapture !== "function") {
        send(res, 503, { ok: false, error: "Unavailable" });
        return;
      }
      try {
        const localStore = runtime.store.forLocalCapture();
        if (route.kind === "list") {
          const page = localStore.listPage({ limit: route.limit, cursor: route.cursor, query: route.query });
          send(res, 200, {
            ok: true,
            items: page.items.map(safeSummary),
            hasMore: page.hasMore,
            nextCursor: page.nextCursor,
          });
          return;
        }
        if (typeof localStore.getLocalSmtp !== "function") {
          send(res, 503, { ok: false, error: "Unavailable" });
          return;
        }
        const message = localStore.getLocalSmtp(route.id);
        if (!message) {
          send(res, 404, { ok: false, error: "Not found" });
          return;
        }
        send(res, 200, { ok: true, message: { ...safeSummary(message), textBody: message.textBody } });
      } catch (error) {
        if (error instanceof Error && error.message === "Invalid local capture pagination cursor") {
          send(res, 400, { ok: false, error: "Invalid request" });
          return;
        }
        send(res, 503, { ok: false, error: "Unavailable" });
      }
    })().catch(() => {
      // No asynchronous failure may escape into Vite's error handling or fall through.
      if (!res.headersSent && !res.destroyed && !res.writableEnded)
        send(res, 503, { ok: false, error: "Unavailable" });
    });
  };

  return {
    handler,
    revoke() {
      active = false;
    },
  };
}
