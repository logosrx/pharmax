// ZPL transports + post-send printer status verification.
//
// "No silent printer failures" (workflow-safety rule): a Zebra
// accepts a TCP payload while out of labels, paused, or with the
// head open — the socket write succeeding proves NOTHING about a
// physical label existing. The TCP transport therefore supports a
// post-send `~HS` (host status) query; the job processor treats a
// fault flag (paper out / paused / head up / ribbon out) as a
// FAILED print, so the tech sees a failure with a reason instead of
// the system recording a label that was never printed.
//
// The `~HS` response is three <STX>...<ETX> framed strings. The
// fields we read (Zebra ZPL II programming guide):
//   string 1: aaa,b,c,...      b = paper-out flag, c = pause flag
//   string 2: mmm,n,o,p,...    o = head-up flag,  p = ribbon-out flag
// Anything unparseable is reported as a fault (fail-closed) — a
// print server that doesn't relay bidirectional traffic should run
// with verification disabled (PRINT_AGENT_VERIFY_STATUS=false)
// rather than silently passing.

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { connect, type Socket } from "node:net";

export interface PrinterStatus {
  readonly ready: boolean;
  /** Human-readable fault descriptions; empty when ready. */
  readonly faults: ReadonlyArray<string>;
}

export interface ZplTransport {
  send(zpl: string): Promise<void>;
  /**
   * Optional post-send verification. Present on transports that can
   * query the physical printer (TCP); absent on the file transport
   * (dev). When present, the job processor calls it after `send`
   * and fails the job on a non-ready status.
   */
  verifyPrinterReady?(): Promise<PrinterStatus>;
}

export class FileZplTransport implements ZplTransport {
  public constructor(private readonly filePath: string) {}

  async send(zpl: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(this.filePath, { encoding: "utf8" });
      stream.on("error", reject);
      stream.on("finish", () => resolve());
      stream.write(zpl);
      stream.end();
    });
  }
}

const STX = "\x02";
const ETX = "\x03";

// Minimum comma-separated fields per status string, per the ZPL II
// format documented above: string 1 must reach the pause flag
// (aaa,b,c → index 2) and string 2 the ribbon-out flag
// (mmm,n,o,p → index 3). A framed string shorter than that is a
// truncated response, not an all-clear one — without this check the
// flag lookups all miss and the empty fault list reads as READY.
const MIN_STRING1_FIELDS = 3;
const MIN_STRING2_FIELDS = 4;

/** Parse the three-string `~HS` response into a fault list. */
export function parseHostStatus(raw: string): PrinterStatus {
  const frames: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = raw.indexOf(STX, cursor);
    if (start === -1) break;
    const end = raw.indexOf(ETX, start + 1);
    if (end === -1) break;
    frames.push(raw.slice(start + 1, end));
    cursor = end + 1;
  }

  if (frames.length < 2) {
    return Object.freeze({
      ready: false,
      faults: [`unparseable ~HS response (${frames.length} frame(s) received)`],
    });
  }

  const string1 = frames[0]!.split(",");
  const string2 = frames[1]!.split(",");

  if (string1.length < MIN_STRING1_FIELDS || string2.length < MIN_STRING2_FIELDS) {
    return Object.freeze({
      ready: false,
      faults: [
        `unparseable ~HS response (status string 1 has ${string1.length}/${MIN_STRING1_FIELDS} required field(s), string 2 has ${string2.length}/${MIN_STRING2_FIELDS})`,
      ],
    });
  }

  const faults: string[] = [];

  if (string1[1]?.trim() === "1") faults.push("paper out");
  if (string1[2]?.trim() === "1") faults.push("paused");
  if (string2[2]?.trim() === "1") faults.push("head up");
  if (string2[3]?.trim() === "1") faults.push("ribbon out");

  return Object.freeze({ ready: faults.length === 0, faults: Object.freeze(faults) });
}

export class TcpZplTransport implements ZplTransport {
  public constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs: number
  ) {}

  async send(zpl: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket: Socket = connect({ host: this.host, port: this.port });
      let settled = false;

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve();
      };

      socket.setTimeout(this.timeoutMs, () => {
        finish(new Error(`ZPL TCP send timed out after ${this.timeoutMs}ms`));
      });

      socket.on("error", (error) => finish(error));
      socket.on("connect", () => {
        socket.write(zpl, "utf8", (writeError) => {
          if (writeError) {
            finish(writeError);
            return;
          }
          socket.end(() => finish());
        });
      });
    });
  }

  /** Query `~HS` on a fresh connection and parse the fault flags. */
  async verifyPrinterReady(): Promise<PrinterStatus> {
    const raw = await new Promise<string>((resolve, reject) => {
      const socket: Socket = connect({ host: this.host, port: this.port });
      let settled = false;
      let received = "";

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve(received);
      };

      socket.setTimeout(this.timeoutMs, () => {
        finish(new Error(`~HS status query timed out after ${this.timeoutMs}ms`));
      });
      socket.on("error", (error) => finish(error));
      socket.on("data", (chunk) => {
        received += chunk.toString("utf8");
        // Three framed strings terminate the response.
        const etxCount = received.split(ETX).length - 1;
        if (etxCount >= 3) finish();
      });
      socket.on("connect", () => {
        socket.write("~HS", "utf8", (writeError) => {
          if (writeError) finish(writeError);
        });
      });
    });
    return parseHostStatus(raw);
  }
}

export function createZplTransport(input: {
  mode: "file" | "tcp";
  filePath: string;
  host: string;
  port: number;
  timeoutMs: number;
  /** Post-send `~HS` verification for TCP transports. Default true. */
  verifyStatus?: boolean;
}): ZplTransport {
  if (input.mode === "file") {
    return new FileZplTransport(input.filePath);
  }
  const tcp = new TcpZplTransport(input.host, input.port, input.timeoutMs);
  if (input.verifyStatus ?? true) {
    return tcp;
  }
  // Verification disabled (print server without bidirectional
  // relay): expose a send-only transport so the job processor's
  // feature check skips the status query.
  return { send: (zpl) => tcp.send(zpl) };
}
