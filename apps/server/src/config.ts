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
  host: string;
  smtpPort: number;
  httpPort: number;
  dbPath: string;
  smtpSizeLimit: number;
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
  const host = process.env.DEVCAUGHT_HOST?.trim() || DEFAULT_HOST;
  const dbPathRaw = process.env.DEVCAUGHT_DB_PATH?.trim() || DEFAULT_DB_PATH;
  return {
    host,
    smtpPort: readPort("DEVCAUGHT_SMTP_PORT", DEFAULT_SMTP_PORT),
    httpPort: readPort("DEVCAUGHT_HTTP_PORT", DEFAULT_HTTP_PORT),
    dbPath: path.isAbsolute(dbPathRaw) ? dbPathRaw : path.join(cwd, dbPathRaw),
    smtpSizeLimit: readSize("DEVCAUGHT_SMTP_SIZE_LIMIT", DEFAULT_SMTP_SIZE_LIMIT),
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
