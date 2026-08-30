import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertSupportedNode, isSupportedNode, portInUseMessage } from "./config.ts";

describe("node version policy", () => {
  it("accepts current Node 22 LTS and newer majors", () => {
    assert.equal(isSupportedNode("22.13.0"), true);
    assert.equal(isSupportedNode("22.23.2"), true);
    assert.equal(isSupportedNode("24.1.0"), true);
  });

  it("rejects Node 20 and early 22", () => {
    assert.equal(isSupportedNode("20.19.0"), false);
    assert.equal(isSupportedNode("22.12.0"), false);
    assert.throws(() => assertSupportedNode("20.19.0"), /22\.13\.0/);
  });
});

describe("portInUseMessage", () => {
  it("names the occupied service and how to change it", () => {
    const message = portInUseMessage("SMTP", "127.0.0.1", 1025, "DEVCAUGHT_SMTP_PORT");
    assert.match(message, /SMTP server on 127.0.0.1:1025/);
    assert.match(message, /DEVCAUGHT_SMTP_PORT=1026 npm run dev/);
  });
});
