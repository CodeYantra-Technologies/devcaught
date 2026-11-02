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
