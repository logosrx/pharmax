import { createHash } from "node:crypto";

export function hashZplContent(zpl: string): Buffer {
  return createHash("sha256").update(zpl, "utf8").digest();
}
