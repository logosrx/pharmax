import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { FileZplTransport } from "./send-zpl.js";

describe("FileZplTransport", () => {
  it("writes ZPL payload to the configured path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pharmax-zpl-"));
    const filePath = join(dir, "label.zpl");
    const transport = new FileZplTransport(filePath);

    await transport.send("^XA^FDdemo^XZ");

    const written = await readFile(filePath, "utf8");
    expect(written).toBe("^XA^FDdemo^XZ");
  });
});
