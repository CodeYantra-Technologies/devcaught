import type { Detection } from "../../shared/src/types.ts";

export type { Detection };

export interface ParseInput {
  subject?: string | null;
  textBody?: string | null;
  htmlBody?: string | null;
}

export interface Parser {
  id: string;
  parse(input: ParseInput): Detection[];
}
