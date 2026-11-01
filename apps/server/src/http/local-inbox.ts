import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect, ViteDevServer } from "vite";
import { isNumericLoopbackHost } from "../config.ts";
import { ensureRuntime, type DevCaughtRuntime } from "../runtime.ts";

const namespace = "/__devcaught/local-inbox";
const capabilityPath = `${namespace}/health`;
const MAX_PATH_DECODE_PASSES = 16;

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
  return path === namespace || path.startsWith(`${namespace}/`) ||
    path.startsWith(`${namespace}%`) || path.startsWith(`${namespace}\\`);
}

/**
 * Recognize raw, URL-normalized and repeatedly encoded namespace prefixes.
 * Decoding is capped at 16 passes to bound work on adversarial request targets.
 * Any namespace alias recognized within that bound is consumed; ordinary
 * non-reserved paths are not claimed by this middleware.
 */
function isReservedNamespace(target: string): boolean {
  const rawPath = target.split(/[?#]/, 1)[0] ?? "";
  let current = rawPath;
  for (let pass = 0; pass <= MAX_PATH_DECODE_PASSES; pass++) {
    if (matchesNamespacePrefix(current)) return true;
    try {
      const normalized = new URL(current, "http://vite.invalid").pathname;
      if (matchesNamespacePrefix(normalized)) return true;
    } catch {
      // Continue with the raw form; malformed reserved prefixes are consumed below.
    }
    if (pass === MAX_PATH_DECODE_PASSES) {
      return false;
    }
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) return false;
      current = decoded;
    } catch {
      return false;
    }
  }
  return false;
}

function send(res: ServerResponse, status: number, body: { ok: boolean; mode?: string; error?: string }): void {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(JSON.stringify(body));
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

      let runtime: DevCaughtRuntime;
      try {
        runtime = await getRuntime();
      } catch {
        send(res, 503, { ok: false, error: "Unavailable" });
        return;
      }
      if (!active || res.destroyed || res.writableEnded) return;
      if (
        !active ||
        runtime.config.smtpRoutingMode !== "local" ||
        !runtime.smtp.status.running ||
        !isNumericLoopbackHost(runtime.smtp.status.host) ||
        runtime.smtp.status.host !== runtime.config.host
      ) {
        send(res, 503, { ok: false, error: "Unavailable" });
        return;
      }

      let pathname: string;
      try {
        pathname = new URL(target, "http://vite.invalid").pathname;
      } catch {
        send(res, 404, { ok: false, error: "Not found" });
        return;
      }
      if (target !== capabilityPath || pathname !== capabilityPath) {
        send(res, req.method === "GET" ? 404 : 405, { ok: false, error: "Not found" });
        return;
      }
      if (req.method !== "GET") {
        send(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }
      send(res, 200, { ok: true, mode: "local-capture" });
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
