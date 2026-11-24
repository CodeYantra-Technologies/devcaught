// Detection is a bounded, best-effort view. Raw captures are never truncated here.
// Covers the default 10 MiB SMTP limit and the 1 MiB webhook limit.
//
// htmlparser2 keeps open tags at the front of an array. Each nested open is an
// unshift and each close searches with indexOf and shift, so deep nesting and
// long runs of unmatched closes are quadratic. This scanner never builds that
// stack: one forward index, a saturating depth integer, and hard caps checked
// before the scan (size) or before any further structural work (depth and steps).

export const MAX_PARSE_CHARS = 10 * 1024 * 1024;
export const MAX_URL_CHARS = 8192;
/** Open tags past this depth do not allocate and do not scan earlier tags. */
export const MAX_NESTING_DEPTH = 256;
/**
 * Worst-case linear coefficient. A close inspects at most MAX_NESTING_DEPTH
 * stack slots, and the shortest close tag is 4 characters (`</a>`), so the
 * stack probe adds at most 256/4 inspections per input character. The extra
 * room covers the characters of the tag itself. Quadratic rescans exceed it
 * as soon as the input is larger than a few hundred tags.
 */
export const MAX_PARSE_WORK_FACTOR = 80;
export const MAX_PARSE_WORK = MAX_PARSE_CHARS * MAX_PARSE_WORK_FACTOR;
const MAX_NAME_CHARS = 32;
const MAX_ENTITY_CHARS = 32;

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00A0",
  ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009", ndash: "\u2013", mdash: "\u2014",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201C", rdquo: "\u201D", hellip: "\u2026",
  bull: "\u2022", middot: "\u00B7", copy: "\u00A9", reg: "\u00AE", trade: "\u2122",
  laquo: "\u00AB", raquo: "\u00BB", pound: "\u00A3", yen: "\u00A5", euro: "\u20AC",
  cent: "\u00A2", sect: "\u00A7", deg: "\u00B0", plusmn: "\u00B1", times: "\u00D7", divide: "\u00F7",
  shy: "\u00AD", zwnj: "\u200C", zwj: "\u200D",
};

export interface HtmlParseStats {
  text: string;
  hrefs: string[];
  /** Character inspections. Linear scans stay within MAX_PARSE_WORK_FACTOR per input character. */
  work: number;
  maxDepth: number;
  /** Input size, nesting, or step budget stopped unconstrained processing. */
  limited: boolean;
  boundedChars: number;
}

function isAlpha(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t" || char === "\f";
}

function lower(char: string): string {
  const code = char.charCodeAt(0);
  return code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : char;
}

function namedEntity(body: string): string | undefined {
  const direct = NAMED_ENTITIES[body];
  if (direct) return direct;
  const folded = body.toLowerCase();
  if (folded === "amp" || folded === "lt" || folded === "gt" || folded === "quot" || folded === "apos") {
    return NAMED_ENTITIES[folded];
  }
  return undefined;
}

function decodeNumeric(body: string): string | undefined {
  let value: number;
  if (body[0] !== "#") return undefined;
  if (body[1] === "x" || body[1] === "X") {
    const digits = body.slice(2);
    if (digits.length < 1 || digits.length > 6 || [...digits].some(char => !/[0-9a-fA-F]/.test(char))) return undefined;
    value = Number.parseInt(digits, 16);
  } else {
    const digits = body.slice(1);
    if (digits.length < 1 || digits.length > 7 || [...digits].some(char => char < "0" || char > "9")) return undefined;
    value = Number.parseInt(digits, 10);
  }
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return "\uFFFD";
  return String.fromCodePoint(value);
}

/** Extract inert text and links. This is NOT a sanitizer. */
export function extractHtmlStats(html: string): HtmlParseStats {
  if (typeof html !== "string") throw new TypeError("HTML input must be a string");
  const sizeLimited = html.length > MAX_PARSE_CHARS;
  const boundedChars = sizeLimited ? MAX_PARSE_CHARS : html.length;
  const source = sizeLimited ? html.slice(0, boundedChars) : html;
  const parts: string[] = [];
  const hrefs: string[] = [];
  let index = 0;
  let work = 0;
  let maxDepth = 0;
  let depthLimited = false;
  let workLimited = false;
  // End-of-array stack capped at MAX_NESTING_DEPTH. Push and length-truncate are
  // O(1); a close inspects at most MAX_NESTING_DEPTH entries and never the input.
  const stack: string[] = [];
  let overflow = 0;

  const charge = (amount: number): boolean => {
    work += amount;
    if (work > MAX_PARSE_WORK) {
      workLimited = true;
      return false;
    }
    return true;
  };
  const peek = (offset = 0): string => source[index + offset] ?? "";
  const emit = (value: string) => { if (value) parts.push(value); };

  const decodeSegment = (segment: string): string => {
    if (!segment.includes("&")) return segment;
    const chunks: string[] = [];
    let cursor = 0;
    while (cursor < segment.length) {
      const amp = segment.indexOf("&", cursor);
      if (amp < 0) {
        chunks.push(segment.slice(cursor));
        break;
      }
      if (amp > cursor) chunks.push(segment.slice(cursor, amp));
      const semi = segment.indexOf(";", amp + 1);
      if (semi < 0 || semi - amp > MAX_ENTITY_CHARS) {
        chunks.push("&");
        cursor = amp + 1;
        continue;
      }
      const body = segment.slice(amp + 1, semi);
      const decoded = decodeNumeric(body) ?? namedEntity(body);
      chunks.push(decoded === undefined ? segment.slice(amp, semi + 1) : decoded);
      cursor = semi + 1;
    }
    return chunks.join("");
  };

  const skipUntil = (terminator: string) => {
    while (index < source.length) {
      if (!charge(1)) return;
      if (source[index] === terminator) {
        index++;
        return;
      }
      index++;
    }
  };

  const readName = (): string => {
    let name = "";
    while (index < source.length) {
      const char = peek();
      if (!isAlpha(char) && !((char >= "0" && char <= "9") || char === "-" || char === ":")) break;
      if (!charge(1)) return name;
      index++;
      if (name.length < MAX_NAME_CHARS) name += lower(char);
    }
    return name;
  };

  const readAttributes = (tag: string) => {
    let href: string | undefined;
    let hrefTaken = false;
    while (index < source.length) {
      const char = peek();
      if (char === ">" || char === "" || char === "<") break;
      if (char === "/") {
        if (!charge(1)) return;
        index++;
        continue;
      }
      if (isWhitespace(char)) {
        if (!charge(1)) return;
        index++;
        continue;
      }
      if (!isAlpha(char)) {
        if (!charge(1)) return;
        index++;
        continue;
      }
      const attr = readName();
      const captureHref = tag === "a" && attr === "href" && !hrefTaken;
      if (captureHref) hrefTaken = true;
      while (isWhitespace(peek())) {
        if (!charge(1)) return;
        index++;
      }
      if (peek() !== "=") continue;
      if (!charge(1)) return;
      index++;
      while (isWhitespace(peek())) {
        if (!charge(1)) return;
        index++;
      }
      const quote = peek();
      let raw = "";
      let store = captureHref;
      if (quote === "\"" || quote === "'") {
        if (!charge(1)) return;
        index++;
        while (index < source.length && peek() !== quote) {
          if (!charge(1)) return;
          if (store && raw.length <= MAX_URL_CHARS) raw += source[index];
          else if (raw.length > MAX_URL_CHARS) store = false;
          index++;
        }
        if (peek() === quote) {
          if (!charge(1)) return;
          index++;
        }
      } else {
        while (index < source.length && !isWhitespace(peek()) && peek() !== ">") {
          if (!charge(1)) return;
          if (store && raw.length <= MAX_URL_CHARS) raw += source[index];
          else if (raw.length > MAX_URL_CHARS) store = false;
          index++;
        }
      }
      if (store) {
        hrefTaken = true;
        const decoded = decodeSegment(raw);
        if (decoded.length > 0 && decoded.length <= MAX_URL_CHARS) href = decoded;
      }
    }
    if (peek() === ">") {
      if (!charge(1)) return;
      index++;
    }
    if (href) hrefs.push(href);
  };

  const noteOpen = (tag: string) => {
    if (VOID_TAGS.has(tag)) return;
    if (stack.length >= MAX_NESTING_DEPTH) {
      depthLimited = true;
      overflow++;
      return;
    }
    stack.push(tag);
    if (stack.length > maxDepth) maxDepth = stack.length;
  };

  const noteClose = (tag: string): boolean => {
    if (VOID_TAGS.has(tag)) return false;
    if (overflow > 0) {
      overflow--;
      return true;
    }
    for (let slot = stack.length - 1; slot >= 0; slot--) {
      if (!charge(1)) return false;
      if (stack[slot] === tag) {
        stack.length = slot;
        return true;
      }
    }
    return false;
  };

  const skipRaw = (tag: string) => {
    const end = `</${tag}`;
    while (index < source.length) {
      if (!charge(1)) return;
      if (source[index] !== "<") {
        index++;
        continue;
      }
      let matched = true;
      for (let offset = 0; offset < end.length; offset++) {
        if (!charge(1)) return;
        if (lower(peek(offset)) !== end[offset]) {
          matched = false;
          break;
        }
      }
      if (!matched) {
        index++;
        continue;
      }
      const boundary = peek(end.length);
      if (boundary !== ">" && !isWhitespace(boundary)) {
        index++;
        continue;
      }
      index += end.length;
      while (index < source.length && peek() !== ">") {
        if (!charge(1)) return;
        index++;
      }
      if (peek() === ">") {
        if (!charge(1)) return;
        index++;
      }
      return;
    }
  };

  while (index < source.length && !workLimited) {
    const char = peek();
    if (char !== "<") {
      const start = index;
      while (index < source.length && peek() !== "<") {
        if (!charge(1)) break;
        index++;
      }
      emit(decodeSegment(source.slice(start, index)));
      continue;
    }
    const next = peek(1);
    if (next === "/") {
      if (!charge(2)) break;
      index += 2;
      const tag = readName();
      while (index < source.length && peek() !== ">") {
        if (!charge(1)) break;
        index++;
      }
      if (peek() === ">") {
        if (!charge(1)) break;
        index++;
      }
      if (noteClose(tag)) emit(" ");
      continue;
    }
    if (next === "!") {
      if (!charge(1)) break;
      index++;
      // `<!--` is a comment. htmlparser2 treats the opening dashes as two of the
      // three `-->` end characters, so `<!-->` and `<!--->` are complete comments.
      if (peek() === "-" && peek(1) === "-") {
        if (!charge(2)) break;
        index += 2;
        let endState = 2;
        while (index < source.length) {
          if (!charge(1)) break;
          const commentChar = source[index++]!;
          if (endState === 2) {
            if (commentChar === ">") break;
            if (commentChar !== "-") endState = 0;
          } else if (commentChar === "-") {
            endState++;
          } else {
            endState = 0;
          }
        }
      } else {
        skipUntil(">");
      }
      continue;
    }
    if (next === "?") {
      if (!charge(1)) break;
      index++;
      skipUntil(">");
      continue;
    }
    if (!isAlpha(next)) {
      if (!charge(1)) break;
      index++;
      emit("<");
      continue;
    }
    if (!charge(1)) break;
    index++;
    const tag = readName();
    readAttributes(tag);
    emit(" ");
    if (tag === "script" || tag === "style") {
      noteOpen(tag);
      skipRaw(tag);
      if (noteClose(tag)) emit(" ");
      continue;
    }
    noteOpen(tag);
  }

  return {
    text: parts.join("").replace(/\s+/g, " ").trim(),
    hrefs,
    work,
    maxDepth,
    limited: sizeLimited || depthLimited || workLimited,
    boundedChars,
  };
}

export function extractHtml(html: string): { text: string; hrefs: string[] } {
  const parsed = extractHtmlStats(html);
  return { text: parsed.text, hrefs: parsed.hrefs };
}

/** Plain text for detection only; never insert this result as HTML. */
export function htmlToText(html: string): string { return extractHtml(html).text; }

export function messageCorpus(input: {
  subject?: string | null;
  textBody?: string | null;
  htmlBody?: string | null;
}): string {
  const subject = (input.subject ?? "").slice(0, MAX_PARSE_CHARS);
  const text = (input.textBody ?? "").slice(0, MAX_PARSE_CHARS - subject.length);
  const remaining = Math.max(0, MAX_PARSE_CHARS - subject.length - text.length);
  return [subject, text, input.htmlBody && remaining ? htmlToText(input.htmlBody.slice(0, remaining)) : ""]
    .filter(Boolean).join("\n");
}
