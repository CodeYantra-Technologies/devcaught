import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LocalInboxBody } from "./LocalInboxBody.ts";

test("renders webhook JSON as escaped text rather than executable markup", () => {
  const payload = JSON.stringify({ html: "<script>window.compromised=true</script>", tag: "<img src=x onerror=alert(1)>" }, null, 2);
  const markup = renderToStaticMarkup(LocalInboxBody({
    message: {
      id: "webhook-1", type: "webhook", source: "http", method: "POST", subject: "example.created",
      createdAt: 1_000, hasHtml: false, hasText: true, textBody: payload,
    },
  }));

  assert.match(markup, /aria-label="Webhook JSON payload"/);
  assert.match(markup, /&lt;script&gt;window\.compromised=true&lt;\/script&gt;/);
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(markup, /<script>|<img /);
});

test("renders synthetic SMS body as escaped plain text", () => {
  const payload = "<script>window.compromised=true</script> & message";
  const markup = renderToStaticMarkup(LocalInboxBody({
    message: {
      id: "sms-1", type: "sms", source: "simulated", sender: "+*******0123", recipient: "+*******0199",
      subject: "Synthetic SMS", createdAt: 1000, hasHtml: false, hasText: true, body: payload,
      provider: "simulated", verification: "local",
    },
  }));
  assert.match(markup, /aria-label="SMS message body"/);
  assert.match(markup, /&lt;script&gt;window\.compromised=true&lt;\/script&gt; &amp; message/);
  assert.doesNotMatch(markup, /<script>/);
});
