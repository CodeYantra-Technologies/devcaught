import assert from "node:assert/strict";
import { isRedirect } from "@tanstack/react-router";
import { test } from "node:test";
import { beforeLoadInboxRoute } from "./inbox-mode-navigation.ts";

function setBrowserEnvironment(fetchImpl: typeof fetch) {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  globalThis.fetch = fetchImpl;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  return () => {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  };
}

test("root client navigation replaces / with local inbox only after health verification", async () => {
  const restore = setBrowserEnvironment(async () =>
    Response.json({ ok: true, mode: "local-capture" }),
  );
  try {
    await assert.rejects(beforeLoadInboxRoute(), error => {
      assert.ok(isRedirect(error));
      assert.equal(error.options.to, "/local-inbox");
      assert.equal(error.options.replace, true);
      return true;
    });
  } finally {
    restore();
  }
});

test("root client navigation preserves private route when local health is unavailable", async () => {
  const restore = setBrowserEnvironment(async () =>
    new Response(JSON.stringify({ ok: false }), { status: 503 }),
  );
  try {
    await assert.doesNotReject(beforeLoadInboxRoute());
  } finally {
    restore();
  }
});

test("server rendering does not infer local mode from a browser flag", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("server must not probe the browser-only capability");
  };
  Reflect.deleteProperty(globalThis, "window");
  try {
    await assert.doesNotReject(beforeLoadInboxRoute());
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  }
});
