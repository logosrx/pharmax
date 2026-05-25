import { normalizeNdc } from "./normalize-ndc.js";

export const GS1_PARSE_FAILED = "GS1_PARSE_FAILED";

const FNC1 = "\u001d";

export interface ParsedGs1Fields {
  readonly gtin14: string | null;
  readonly ndc11: string | null;
  readonly lotNumber: string | null;
  readonly expirationDate: string | null;
  readonly serialNumber: string | null;
}

export interface ParsedGs1 {
  readonly fields: ParsedGs1Fields;
}

function gtin14ToNdc11(gtin14: string): string | null {
  if (!/^\d{14}$/.test(gtin14)) {
    return null;
  }
  const body = gtin14.slice(0, 13);
  return normalizeNdc(body.slice(1, 12));
}

function parseExpirationYyMmDd(raw: string): string | null {
  if (!/^\d{6}$/.test(raw)) {
    return null;
  }
  const year = Number.parseInt(raw.slice(0, 2), 10);
  const month = Number.parseInt(raw.slice(2, 4), 10);
  const day = Number.parseInt(raw.slice(4, 6), 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const fullYear = year >= 50 ? 1900 + year : 2000 + year;
  return `${fullYear.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function readVariableField(
  source: string,
  startIndex: number
): { value: string; nextIndex: number } {
  const separatorIndex = source.indexOf(FNC1, startIndex);
  if (separatorIndex === -1) {
    return { value: source.slice(startIndex), nextIndex: source.length };
  }
  return { value: source.slice(startIndex, separatorIndex), nextIndex: separatorIndex + 1 };
}

function parseParenthesizedGs1(raw: string): ParsedGs1Fields | null {
  const fields = {
    gtin14: null as string | null,
    ndc11: null as string | null,
    lotNumber: null as string | null,
    expirationDate: null as string | null,
    serialNumber: null as string | null,
  };

  const pattern = /\((\d{2,4})\)([^()]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const ai = match[1]!;
    const value = match[2]!.trim();
    switch (ai) {
      case "01": {
        if (!/^\d{14}$/.test(value)) {
          return null;
        }
        fields.gtin14 = value;
        fields.ndc11 = gtin14ToNdc11(value);
        break;
      }
      case "10":
        fields.lotNumber = value.length > 0 ? value : null;
        break;
      case "17":
        fields.expirationDate = parseExpirationYyMmDd(value);
        break;
      case "21":
        fields.serialNumber = value.length > 0 ? value : null;
        break;
      default:
        break;
    }
  }

  if (fields.gtin14 === null && fields.lotNumber === null && fields.expirationDate === null) {
    return null;
  }
  return fields;
}

function parseElementStringGs1(raw: string): ParsedGs1Fields | null {
  const normalized = raw.replace(/\s+/g, "");
  if (normalized.length === 0) {
    return null;
  }

  const fields = {
    gtin14: null as string | null,
    ndc11: null as string | null,
    lotNumber: null as string | null,
    expirationDate: null as string | null,
    serialNumber: null as string | null,
  };

  let index = 0;
  while (index < normalized.length) {
    if (normalized[index] === FNC1) {
      index += 1;
      continue;
    }

    if (normalized.startsWith("01", index)) {
      const gtin = normalized.slice(index + 2, index + 16);
      if (!/^\d{14}$/.test(gtin)) {
        return null;
      }
      fields.gtin14 = gtin;
      fields.ndc11 = gtin14ToNdc11(gtin);
      index += 16;
      continue;
    }

    if (normalized.startsWith("17", index)) {
      const expiry = normalized.slice(index + 2, index + 8);
      fields.expirationDate = parseExpirationYyMmDd(expiry);
      index += 8;
      continue;
    }

    if (normalized.startsWith("10", index)) {
      const lot = readVariableField(normalized, index + 2);
      fields.lotNumber = lot.value.length > 0 ? lot.value : null;
      index = lot.nextIndex;
      continue;
    }

    if (normalized.startsWith("21", index)) {
      const serial = readVariableField(normalized, index + 2);
      fields.serialNumber = serial.value.length > 0 ? serial.value : null;
      index = serial.nextIndex;
      continue;
    }

    return null;
  }

  if (fields.gtin14 === null && fields.lotNumber === null && fields.expirationDate === null) {
    return null;
  }
  return fields satisfies ParsedGs1Fields;
}

/** Parse a GS1 DataMatrix / linear payload from a scanner wedge. */
export function parseGs1(raw: string): ParsedGs1 | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const fields = trimmed.includes("(")
    ? parseParenthesizedGs1(trimmed)
    : parseElementStringGs1(trimmed);
  if (fields === null) {
    return null;
  }

  return { fields };
}
