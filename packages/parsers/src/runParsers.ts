import type { Detection, Parser, ParseInput } from "./types.ts";

export function runParsers(input: ParseInput, parsers: Parser[]): Detection[] {
  const seen = new Set<string>();
  const detections: Detection[] = [];

  for (const parser of parsers) {
    for (const detection of parser.parse(input)) {
      const key = `${detection.type}:${detection.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      detections.push(detection);
    }
  }

  return detections;
}
