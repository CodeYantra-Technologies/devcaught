import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractHtmlStats,
  MAX_NESTING_DEPTH,
  MAX_PARSE_CHARS,
  MAX_PARSE_WORK,
  MAX_PARSE_WORK_FACTOR,
} from "../src/htmlText.ts";

function assertLinear(samples: string[]) {
  const stats = samples.map(sample => extractHtmlStats(sample));
  const densities = stats.map(sample => sample.work / sample.boundedChars);
  for (const sample of stats) {
    assert.equal(sample.work <= MAX_PARSE_WORK, true);
    assert.equal(sample.maxDepth <= MAX_NESTING_DEPTH, true);
    assert.equal(sample.work <= sample.boundedChars * MAX_PARSE_WORK_FACTOR, true);
    assert.equal(sample.boundedChars <= MAX_PARSE_CHARS, true);
  }
  const growth = densities[densities.length - 1]! / densities[0]!;
  assert.equal(growth < 1.5, true, `work density grew ${growth}`);
  return stats;
}

test("deeply nested tags stay within a depth cap and a linear work bound", () => {
  const sizes = [1000, 2000, 4000, 8000];
  const stats = assertLinear(sizes.map(size => "<div>".repeat(size) + "KEEP" + "</div>".repeat(size)));
  for (const sample of stats) {
    assert.equal(sample.text, "KEEP");
    assert.equal(sample.maxDepth, MAX_NESTING_DEPTH);
    assert.equal(sample.limited, true);
  }
  assert.equal(stats[3]!.work / stats[2]!.work < 2.2, true);
  assert.equal(stats[3]!.work > stats[2]!.work, true);
});

test("unmatched closes do not scan earlier tags without a fixed bound", () => {
  const sizes = [1000, 2000, 4000, 8000];
  const open = "<div>".repeat(MAX_NESTING_DEPTH + 20);
  const stats = assertLinear(sizes.map(size => open + "</span>".repeat(size) + "TAIL"));
  for (const sample of stats) {
    assert.equal(sample.text.endsWith("TAIL"), true);
    assert.equal(sample.maxDepth, MAX_NESTING_DEPTH);
    assert.equal(sample.limited, true);
  }
  const bare = assertLinear(sizes.map(size => "</div>".repeat(size) + "<p>visible</p>"));
  for (const sample of bare) assert.equal(sample.text, "visible");
});

test("input size is capped before the scan and the raw capture is unchanged", () => {
  const raw = "a".repeat(MAX_PARSE_CHARS + 128);
  const parsed = extractHtmlStats(raw);
  assert.equal(raw.length, MAX_PARSE_CHARS + 128);
  assert.equal(parsed.boundedChars, MAX_PARSE_CHARS);
  assert.equal(parsed.limited, true);
  assert.equal(parsed.work <= MAX_PARSE_WORK, true);
  assert.equal(parsed.work <= parsed.boundedChars * MAX_PARSE_WORK_FACTOR, true);
  assert.equal(parsed.text.length, MAX_PARSE_CHARS);
});

test("malformed markup finishes and keeps script and style text out of the detection corpus", () => {
  const malformed = "<div><script>SECRET" + "<".repeat(1000) + "</script>visible<style>HIDDEN</style>ok";
  const parsed = extractHtmlStats(malformed + "</div>".repeat(50) + "<!-->kept");
  assert.equal(parsed.text.includes("SECRET"), false);
  assert.equal(parsed.text.includes("HIDDEN"), false);
  assert.equal(parsed.text.includes("visible"), true);
  assert.equal(parsed.text.includes("kept"), true);
  assert.equal(parsed.work <= parsed.boundedChars * MAX_PARSE_WORK_FACTOR, true);
  assert.equal(extractHtmlStats("<script".repeat(10000)).text, "");
});
