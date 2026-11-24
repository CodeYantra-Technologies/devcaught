import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { htmlToText, messageCorpus, MAX_PARSE_CHARS, MAX_URL_CHARS } from "../src/htmlText.ts";
import { linkParser } from "../src/linkParser.ts";
import { commerceParser } from "../src/commerceParser.ts";

test("HTML extraction handles real tag syntax, raw text and character entities", () => {
  assert.equal(htmlToText('<P>Code&nbsp;482913</P><SCRIPT type="text/javascript">bad()</SCRIPT ><style>hidden</style ><div>A &amp; B &#39;x&#39;</div>'), "Code 482913 A & B 'x'");
  assert.equal(htmlToText('<p title="a > b">visible</p><!-- hidden --><script>unclosed'), "visible");
  assert.equal(htmlToText('<scripture>visible</scripture><p>&lt;script&gt;literal&lt;/script&gt;</p>'), "visible <script>literal</script>");
});

test("HTML links use tokenized attributes, entity decoding and explicit HTTP protocols", () => {
  const result = linkParser.parse({ htmlBody: `<a HREF=https://example.test/a?x=1&amp;y=2>ok</a>
    <a href="javascript:alert('https://evil.test')">bad</a>
    <a href="data:text/html,https://evil.test">bad</a><a href="//example.test/relative">bad</a>
    <script>https://hidden.test</script><a href="https://[invalid">bad</a>` });
  assert.deepEqual(result.map(item => item.value), ["https://example.test/a?x=1&y=2"]);
  const deceptive = linkParser.parse({ textBody: "https://veltrix.test@evil.test/a" });
  assert.equal(new URL(deceptive[0].value).hostname, "evil.test"); // No trusted-host inference.
});

test("detection bounds do not mutate raw input or return truncated URLs", () => {
  const input = { textBody: "x".repeat(MAX_PARSE_CHARS) + " https://beyond.test" };
  assert.equal(messageCorpus(input).length, MAX_PARSE_CHARS);
  assert.equal(input.textBody.length, MAX_PARSE_CHARS + " https://beyond.test".length);
  assert.deepEqual(linkParser.parse({ textBody: "https://example.test/" + "a".repeat(MAX_URL_CHARS) }), []);
});

test("commerce references preserve whitespace, delimiters, case and ID boundaries", () => {
  assert.deepEqual(commerceParser.parse({ textBody: "PAYMENT ID pi_42; Order no. = ord_42; transaction reference: tx_42" })
    .map(item => item.value), ["pi_42", "ord_42", "tx_42"]);
  assert.deepEqual(commerceParser.parse({ textBody: "Order ID " + "a".repeat(101) }), []);
});

test("adversarial regex inputs complete within a child-process CPU deadline", () => {
  const moduleUrl = (name: string) => JSON.stringify(new URL(`../src/${name}.ts`, import.meta.url).href);
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { htmlToText } from ${moduleUrl("htmlText")};
    import { linkParser } from ${moduleUrl("linkParser")};
    import { commerceParser } from ${moduleUrl("commerceParser")};
    assert.equal(htmlToText('<script'.repeat(100000)), '');
    assert.deepEqual(linkParser.parse({ textBody: 'https://example.test/' + '!'.repeat(100000) + 'x' }), []);
    assert.equal(linkParser.parse({ textBody: 'https://example.test/a' + '!'.repeat(100000) })[0].value, 'https://example.test/a');
    assert.deepEqual(commerceParser.parse({ textBody: 'payment id' + ' '.repeat(100000) + '!' }), []);
  `], { timeout: 5000, encoding: "utf8" });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr);
});
