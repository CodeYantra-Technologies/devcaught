import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Parser } from "htmlparser2";
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
  assertInertPre(markup, payload);
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
  assertInertPre(markup, payload);
});

/** Inspect actual HTML structure and decoded text, including mixed-case payloads. */
function assertInertPre(markup: string, payload: string) {
  const tags: string[] = [];
  let text = "";
  const parser = new Parser({
    onopentag(name) { tags.push(name); },
    ontext(value) { text += value; },
  });
  parser.end(markup);
  assert.deepEqual(tags, ["pre"]);
  assert.equal(text, payload);
}

test("mixed-case, malformed and entity-encoded payload tags remain literal text", () => {
  for (const payload of [
    "<SCRIPT>alert(1)</SCRIPT >",
    "<img src=x onerror=alert(1)><svg/onload=alert(1)>",
    "</pre><ScRiPt>alert(1)</ScRiPt>",
    "&lt;script&gt;alert(1)&lt;/script&gt;",
  ]) {
    const markup = renderToStaticMarkup(LocalInboxBody({ message: {
      id: "hostile", type: "webhook", source: "http", method: "POST",
      subject: "test", createdAt: 1000, hasHtml: false, hasText: true, textBody: payload,
    } }));
    assertInertPre(markup, payload);
  }
});
