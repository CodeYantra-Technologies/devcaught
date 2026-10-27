import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSmsIngestPolicy } from "../src/sms.ts";

describe("resolveSmsIngestPolicy (SMS security contract)", () => {
  it("fails closed for public providers without verification credentials", () => {
    assert.deepEqual(resolveSmsIngestPolicy("twilio", false), { mode: "fail_closed" });
    assert.deepEqual(resolveSmsIngestPolicy("msg91", false), { mode: "fail_closed" });
  });

  it("requires verification when credentials are configured", () => {
    assert.deepEqual(resolveSmsIngestPolicy("twilio", true), {
      mode: "verify",
      provider: "twilio",
    });
    assert.deepEqual(resolveSmsIngestPolicy("msg91", true), {
      mode: "verify",
      provider: "msg91",
    });
  });

  it("keeps local simulation isolated from public ingest", () => {
    assert.deepEqual(resolveSmsIngestPolicy("simulated", false), { mode: "accept_local" });
    assert.deepEqual(resolveSmsIngestPolicy("simulated", true), { mode: "accept_local" });
  });
});
