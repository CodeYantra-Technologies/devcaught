import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  AUTH_COOKIES,
  AUTH_MISCONFIGURED_MESSAGE,
  LOCAL_DEV_ORIGINS,
  resolveAuthState,
  resolveBaseUrl,
  resolveTrustedOrigins,
} from "./auth-config.ts";

const AUTH_DIR = dirname(fileURLToPath(import.meta.url));

test("shipped default: VITE_AUTH_ENABLED=false is auth off (dev user)", () => {
  assert.deepEqual(
    resolveAuthState({ viteAuthEnabled: "false", emailAndPasswordEnabled: false }),
    { authRequested: false, authConfigured: false },
  );
});

test("auth requested without a configured method is NOT configured (fail closed, never the dev user)", () => {
  assert.deepEqual(
    resolveAuthState({ viteAuthEnabled: "true", emailAndPasswordEnabled: false }),
    { authRequested: true, authConfigured: false },
  );
  // An unset/blank flag also means "requested", so the same fail-closed state
  // is reachable by omission — it must not silently degrade to the dev user.
  assert.deepEqual(
    resolveAuthState({ viteAuthEnabled: undefined, emailAndPasswordEnabled: false }),
    { authRequested: true, authConfigured: false },
  );
  assert.deepEqual(
    resolveAuthState({ viteAuthEnabled: "   ", emailAndPasswordEnabled: false }),
    { authRequested: true, authConfigured: false },
  );
});

test("auth is configured only when a method is enabled alongside the request", () => {
  assert.deepEqual(
    resolveAuthState({ viteAuthEnabled: "true", emailAndPasswordEnabled: true }),
    { authRequested: true, authConfigured: true },
  );
  // A method enabled while auth is explicitly off stays off.
  assert.deepEqual(
    resolveAuthState({ viteAuthEnabled: "false", emailAndPasswordEnabled: true }),
    { authRequested: false, authConfigured: false },
  );
});

test("the fail-closed message names the fix, not a dev-user fallback", () => {
  assert.match(AUTH_MISCONFIGURED_MESSAGE, /no authentication method is configured/);
  assert.match(AUTH_MISCONFIGURED_MESSAGE, /VITE_AUTH_ENABLED=false/);
});

test("cookies are DevCaught-owned and __Host- prefixed", () => {
  for (const cookie of Object.values(AUTH_COOKIES)) {
    assert.match(cookie.name, /^__Host-devcaught-auth\./);
  }
  assert.equal(
    AUTH_COOKIES.session_token.name,
    "__Host-devcaught-auth.session_token",
  );
  // Four distinct names, one per Better Auth cookie slot.
  assert.equal(new Set(Object.values(AUTH_COOKIES).map((c) => c.name)).size, 4);
});

test("base URL is the deployer's URL, else the local dev contract", () => {
  assert.equal(resolveBaseUrl(undefined), "http://localhost:8080");
  assert.equal(
    resolveBaseUrl("https://devcaught.example.com"),
    "https://devcaught.example.com",
  );
});

test("trusted origins are strict: explicit + loopback only, never wildcards", () => {
  assert.deepEqual(resolveTrustedOrigins(undefined), [...LOCAL_DEV_ORIGINS]);
  assert.deepEqual(resolveTrustedOrigins("https://devcaught.example.com"), [
    "https://devcaught.example.com",
    ...LOCAL_DEV_ORIGINS,
  ]);
  for (const origin of resolveTrustedOrigins("https://x.example")) {
    assert.ok(!origin.includes("*"), `wildcard origin leaked: ${origin}`);
  }
  // Every local origin is the 8080 dev contract over both http and loopback.
  for (const origin of LOCAL_DEV_ORIGINS) {
    assert.match(origin, /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):8080$/);
  }
});

test("no Grok broker coupling remains in the auth sources", () => {
  // preview.ts is excluded by instruction (protected file, not read here).
  const sources = [
    "auth-config.ts",
    "client.ts",
    "email-password.ts",
    "gates.tsx",
    "isolation.server.ts",
    "middleware.ts",
    "provider.tsx",
    "pglite-dialect.ts",
    "server.ts",
    "use-current-user.ts",
    "verify.server.ts",
  ];
  for (const file of sources) {
    const text = readFileSync(join(AUTH_DIR, file), "utf8").toLowerCase();
    for (const needle of ["grok", "xai", "genericoauth", "oauth2/authorize"]) {
      assert.ok(!text.includes(needle), `${file} still references ${needle}`);
    }
  }
  // The protected preview module must not be imported by the auth core.
  const server = readFileSync(join(AUTH_DIR, "server.ts"), "utf8");
  assert.ok(!server.includes("./preview"), "server.ts still imports ./preview");
  // The broker provider list is gone.
  assert.throws(
    () => readFileSync(join(AUTH_DIR, "providers.ts"), "utf8"),
    { code: "ENOENT" },
  );
});
