import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { linkParser } from "../src/linkParser.ts";

describe("linkParser", () => {
  it("extracts http and https URLs from text", () => {
    const detections = linkParser.parse({
      textBody:
        "Reset: https://nexa.test/reset/abc123 and http://localhost:3000/ok.",
    });
    const values = detections.map((d) => d.value);
    assert.ok(values.includes("https://nexa.test/reset/abc123"));
    assert.ok(values.includes("http://localhost:3000/ok"));
  });

  it("extracts href URLs from HTML", () => {
    const detections = linkParser.parse({
      htmlBody: `<p><a href="https://app.example.test/verify?token=1">Verify</a></p>`,
    });
    assert.equal(detections[0]?.value, "https://app.example.test/verify?token=1");
  });

  it("deduplicates and ignores javascript urls", () => {
    const detections = linkParser.parse({
      textBody: "https://example.test/a https://example.test/a",
      htmlBody: `<a href="javascript:alert(1)">x</a>`,
    });
    assert.equal(detections.length, 1);
    assert.equal(detections[0]?.value, "https://example.test/a");
  });
});
