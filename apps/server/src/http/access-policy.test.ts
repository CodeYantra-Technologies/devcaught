import { test } from "node:test";
import assert from "node:assert/strict";
import {
  requireInboxAccess,
  requireGenericWebhookAccess,
} from "./access-policy.ts";

test("inbox access fails closed without verified authentication", () => {
  assert.deepEqual(requireInboxAccess(), {
    allowed: false,
    status: 401,
    error: "Unauthorized",
  });
});

test("generic webhook access fails closed without verification", () => {
  assert.deepEqual(requireGenericWebhookAccess(), {
    allowed: false,
    status: 401,
    error: "Unauthorized",
  });
});
