import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { devServerHost } from "./dev-server-host.mjs";

test("Vite dev host defaults to numeric loopback", () => {
  assert.equal(devServerHost({}), "127.0.0.1");
  assert.equal(devServerHost({ DEVCAUGHT_LIVE_PREVIEW: "true" }), "127.0.0.1");
});

test("network-accessible live preview requires the explicit opt-in", () => {
  assert.equal(devServerHost({ DEVCAUGHT_LIVE_PREVIEW: "1" }), "0.0.0.0");
});

test("npm dev leaves host selection to Vite config so CLI and config cannot conflict", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts.dev, /vite dev --port 8080$/);
  assert.doesNotMatch(pkg.scripts.dev, /--host/);
  const config = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(config, /host:\s*devServerHost\(process\.env\)/);
});
