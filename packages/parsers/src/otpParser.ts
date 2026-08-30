import type { Detection } from "./types.ts";
import type { ParseInput } from "./types.ts";
import { messageCorpus } from "./htmlText.ts";

const CUES: { re: RegExp; weight: number }[] = [
  { re: /one[\s-]*time\s+pass(?:word|code)/gi, weight: 0.97 },
  { re: /verification\s+code/gi, weight: 0.95 },
  { re: /authentication\s+code/gi, weight: 0.95 },
  { re: /security\s+code/gi, weight: 0.93 },
  { re: /login\s+code/gi, weight: 0.93 },
  { re: /confirm(?:ation)?\s+code/gi, weight: 0.92 },
  { re: /\botp\b/gi, weight: 0.92 },
  { re: /passcode/gi, weight: 0.9 },
];

const SOLID_CODE = /(?<!\d)(\d{4,8})(?!\d)/g;
const SPLIT_CODE = /(?<!\d)(\d{3}[\s-]\d{3})(?!\d)/g;
const EXPIRY =
  /(?:expires?|valid)\s+(?:in\s+)?(\d+)\s*(minutes?|mins?|hours?|hrs?|seconds?|secs?|days?)/i;

const WINDOW_BEFORE = 24;
const WINDOW_AFTER = 160;

function isYearLike(digits: string): boolean {
  if (digits.length !== 4) return false;
  const n = Number(digits);
  return n >= 1900 && n <= 2099;
}

function collectCueIndexes(text: string): { index: number; weight: number; length: number }[] {
  const found: { index: number; weight: number; length: number }[] = [];
  for (const cue of CUES) {
    cue.re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = cue.re.exec(text)) !== null) {
      found.push({ index: match.index, weight: cue.weight, length: match[0].length });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

function collectCodes(text: string): { value: string; index: number; length: number }[] {
  const codes: { value: string; index: number; length: number }[] = [];

  SOLID_CODE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SOLID_CODE.exec(text)) !== null) {
    const value = match[1];
    if (isYearLike(value)) continue;
    codes.push({ value, index: match.index, length: match[0].length });
  }

  SPLIT_CODE.lastIndex = 0;
  while ((match = SPLIT_CODE.exec(text)) !== null) {
    const value = match[1].replace(/[\s-]/g, "");
    if (value.length < 4 || value.length > 8) continue;
    if (isYearLike(value)) continue;
    codes.push({ value, index: match.index, length: match[0].length });
  }

  return codes.sort((a, b) => a.index - b.index);
}

function expiryLabel(text: string): string | undefined {
  const match = EXPIRY.exec(text);
  if (!match) return undefined;
  const amount = match[1];
  const unitRaw = match[2].toLowerCase();
  const unit =
    unitRaw.startsWith("min")
      ? Number(amount) === 1
        ? "minute"
        : "minutes"
      : unitRaw.startsWith("hour") || unitRaw.startsWith("hr")
        ? Number(amount) === 1
          ? "hour"
          : "hours"
        : unitRaw.startsWith("sec")
          ? Number(amount) === 1
            ? "second"
            : "seconds"
          : Number(amount) === 1
            ? "day"
            : "days";
  return `Expires in ${amount} ${unit}`;
}

function confidenceFor(weight: number, digits: string): number {
  let confidence = weight;
  if (digits.length === 6) confidence = Math.min(0.99, confidence + 0.02);
  if (digits.length === 4) confidence = Math.max(0.75, confidence - 0.08);
  return Number(confidence.toFixed(2));
}

export const otpParser = {
  id: "otp",
  parse(input: ParseInput): Detection[] {
    const text = messageCorpus(input);
    if (!text) return [];

    const cues = collectCueIndexes(text);
    if (cues.length === 0) return [];

    const codes = collectCodes(text);
    if (codes.length === 0) return [];

    const used = new Set<string>();
    const detections: Detection[] = [];
    const label = expiryLabel(text);

    for (const cue of cues) {
      const windowStart = Math.max(0, cue.index - WINDOW_BEFORE);
      const windowEnd = Math.min(text.length, cue.index + cue.length + WINDOW_AFTER);
      const nearby = codes.filter(
        (code) => code.index >= windowStart && code.index <= windowEnd && !used.has(code.value),
      );
      if (nearby.length === 0) continue;

      const afterCue = nearby.find((code) => code.index >= cue.index);
      const chosen = afterCue ?? nearby[0];
      used.add(chosen.value);

      const detection: Detection = {
        type: "otp",
        value: chosen.value,
        confidence: confidenceFor(cue.weight, chosen.value),
      };
      if (label) {
        detection.label = label;
        detection.metadata = { expiresIn: label.replace(/^Expires in /, "") };
      }
      detections.push(detection);
    }

    return detections;
  },
};
