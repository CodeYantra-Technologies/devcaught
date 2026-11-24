import assert from "node:assert/strict";
import { test } from "node:test";
import { Parser } from "htmlparser2";
import { htmlToText } from "../../../../packages/parsers/src/htmlText.ts";
import { sanitizeEmailHtml } from "./sanitizePreview.ts";

test("preview sanitizer removes executable markup and unsafe links independently of text extraction", () => {
  const html = sanitizeEmailHtml(`<SCRIPT>alert(1)</SCRIPT ><style>bad</style>
    <img src="https://tracker.test/pixel" onerror="alert(1)">
    <svg/onload=alert(1)><iframe src="https://evil.test"></iframe>
    <a href="jav&#x61;script:alert(1)" onclick="alert(1)">unsafe</a>
    <a href="//evil.test">relative</a><a href="https://example.test/ok">safe</a>`);
  const links: string[] = [];
  const parser = new Parser({ onopentag(name, attrs) {
    assert.ok(!["script", "style", "svg", "iframe", "object", "embed"].includes(name));
    assert.ok(Object.keys(attrs).every(key => !key.startsWith("on")));
    if (name === "img") assert.equal(attrs.src, undefined);
    if (name === "a" && attrs.href) links.push(attrs.href);
  } });
  parser.end(html);
  assert.deepEqual(links, ["https://example.test/ok"]);
});

test("text extraction does not replace the preview sanitizer or mutate the raw capture", () => {
  const raw = "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p><script>SECRET</script>";
  const extracted = htmlToText(raw);
  assert.equal(raw, "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p><script>SECRET</script>");
  assert.equal(extracted.includes("SECRET"), false);
  assert.equal(extracted.includes("<script>"), true);
  const preview = sanitizeEmailHtml(raw);
  assert.equal(preview.includes("SECRET"), false);
  assert.equal(preview.includes("<script"), false);
  assert.notEqual(preview, extracted);
  const parsed = new Parser({ onopentag(name) {
    assert.notEqual(name, "script");
  } });
  parsed.end(preview);
});
