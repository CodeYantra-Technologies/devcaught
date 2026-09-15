import { test } from "node:test";
import assert from "node:assert/strict";
import { commerceParser, defaultParsers, runParsers } from "../src/index.ts";

const parse = (body: unknown) => runParsers({ textBody: JSON.stringify(body) }, [commerceParser]);
test("nested payment event extracts related references and preserves raw amount units", () => {
  const result = parse({
    type: "payment_intent.succeeded",
    data: {
      object: {
        object: "payment_intent",
        id: "pi_123",
        order_id: "order_42",
        transaction_id: "txn_7",
        amount: 0,
        currency: "usd",
        status: "succeeded",
      },
    },
  });
  assert.deepEqual(
    result.map((d) => [d.type, d.value]),
    [
      ["payment", "pi_123"],
      ["order", "order_42"],
      ["transaction", "txn_7"],
    ],
  );
  assert.equal(result[0].metadata?.amount, 0);
});
test("nested entities, arrays, numeric IDs, and camel case references", () => {
  const result = parse({
    payload: [
      { order: { entity: { id: 42 } } },
      { transactionId: "tx_7" },
      { payment: { id: "pay_1" } },
    ],
  });
  assert.deepEqual(
    result.map((d) => d.value),
    ["42", "tx_7", "pay_1"],
  );
});
test("event name without entity is retained, unrelated IDs are not detections", () => {
  assert.equal(parse({ event: "order.created" })[0].value, "order.created");
  assert.deepEqual(parse({ id: "user_1", amount: 100, status: "ok" }), []);
  assert.deepEqual(parse({ payment_id: { secret: "not a reference" } }), []);
  assert.deepEqual(parse(null), []);
});
test("plain email references coexist with OTPs and links without duplicating references", () => {
  const result = runParsers(
    {
      textBody:
        "Order #ORD-42. Transaction ID: txn_7. Order #ORD-42. Your verification code is 482913. https://example.test",
    },
    defaultParsers,
  );
  assert.equal(result.filter((d) => d.type === "order").length, 1);
  assert.ok(result.some((d) => d.type === "transaction" && d.value === "txn_7"));
  assert.ok(result.some((d) => d.type === "otp"));
  assert.ok(result.some((d) => d.type === "url"));
  assert.deepEqual(
    commerceParser.parse({ textBody: "Your payment was received. Please order more." }),
    [],
  );
});

test("event IDs and nested customer IDs are not payment references", () => {
  const result = parse({
    id: "evt_1",
    type: "payment.succeeded",
    data: { object: { object: "payment", id: "pay_1", customer: { id: "cus_1" } } },
  });
  assert.deepEqual(
    result.map((d) => d.value),
    ["pay_1"],
  );
});
