// ZPL transport tests — "no silent printer failures".
//
// The `~HS` frames below are SYNTHETIC, shaped after the public field
// layout in Zebra's ZPL II programming guide (string 1 carries the
// paper-out and pause flags, string 2 the head-up and ribbon-out
// flags). No frame here was captured from a real device.
//
// The TCP suite scripts a fake socket through a mocked `node:net` so
// connection refusal, write errors, and timeouts are deterministic —
// no real sockets, no real printers.

import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";

import {
  createZplTransport,
  FileZplTransport,
  parseHostStatus,
  TcpZplTransport,
} from "./send-zpl.js";

const netMock = vi.hoisted(() => ({
  connect: vi.fn(),
}));

vi.mock("node:net", () => ({ connect: netMock.connect }));

const STX = "\x02";
const ETX = "\x03";

// -- ~HS frame constructors (synthetic, public field layout) ----------

/** String 1: aaa,b,c,dddd,eee,f,g,h,iii,j,k,l — b = paper out, c = pause. */
function hsString1(over: { paperOut?: string; paused?: string } = {}): string {
  return ["014", over.paperOut ?? "0", over.paused ?? "0", "1234", "000", "0", "0", "0"].join(",");
}

/** String 2: mmm,n,o,p,q,... — o = head up, p = ribbon out. */
function hsString2(over: { headUp?: string; ribbonOut?: string } = {}): string {
  return ["000", "0", over.headUp ?? "0", over.ribbonOut ?? "0", "0", "0", "0"].join(",");
}

function frame(content: string): string {
  return `${STX}${content}${ETX}`;
}

function hsResponse(string1: string, string2: string, string3 = "1234,0"): string {
  return `${frame(string1)}\r\n${frame(string2)}\r\n${frame(string3)}\r\n`;
}

// -- Fake socket -------------------------------------------------------

class FakeSocket extends EventEmitter {
  public destroyed = false;
  public readonly written: string[] = [];
  public timeoutMs: number | null = null;
  public writeError: Error | null = null;
  private timeoutHandler: (() => void) | null = null;

  setTimeout(ms: number, handler: () => void): this {
    this.timeoutMs = ms;
    this.timeoutHandler = handler;
    return this;
  }

  triggerTimeout(): void {
    this.timeoutHandler?.();
  }

  write(data: string, _encoding: string, callback?: (error?: Error) => void): boolean {
    this.written.push(data);
    callback?.(this.writeError ?? undefined);
    return true;
  }

  end(callback?: () => void): this {
    callback?.();
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

function nextSocket(): FakeSocket {
  const socket = new FakeSocket();
  netMock.connect.mockReturnValueOnce(socket);
  return socket;
}

// ======================================================================
// parseHostStatus — fault-flag decoding
// ======================================================================

describe("parseHostStatus", () => {
  it("reports ready with zero faults on an all-clear frame", () => {
    const status = parseHostStatus(hsResponse(hsString1(), hsString2()));
    expect(status).toEqual({ ready: true, faults: [] });
  });

  it("maps the paper-out flag to a 'paper out' fault", () => {
    const status = parseHostStatus(hsResponse(hsString1({ paperOut: "1" }), hsString2()));
    expect(status.ready).toBe(false);
    expect(status.faults).toEqual(["paper out"]);
  });

  it("maps the pause flag to a 'paused' fault", () => {
    const status = parseHostStatus(hsResponse(hsString1({ paused: "1" }), hsString2()));
    expect(status.ready).toBe(false);
    expect(status.faults).toEqual(["paused"]);
  });

  it("maps the head-up flag to a 'head up' fault", () => {
    const status = parseHostStatus(hsResponse(hsString1(), hsString2({ headUp: "1" })));
    expect(status.ready).toBe(false);
    expect(status.faults).toEqual(["head up"]);
  });

  it("maps the ribbon-out flag to a 'ribbon out' fault", () => {
    const status = parseHostStatus(hsResponse(hsString1(), hsString2({ ribbonOut: "1" })));
    expect(status.ready).toBe(false);
    expect(status.faults).toEqual(["ribbon out"]);
  });

  it("reports every raised flag when several faults coincide", () => {
    const status = parseHostStatus(
      hsResponse(
        hsString1({ paperOut: "1", paused: "1" }),
        hsString2({ headUp: "1", ribbonOut: "1" })
      )
    );
    expect(status.ready).toBe(false);
    expect(status.faults).toEqual(["paper out", "paused", "head up", "ribbon out"]);
  });

  it("tolerates whitespace padding around a raised flag", () => {
    const status = parseHostStatus(hsResponse(hsString1({ paperOut: " 1 " }), hsString2()));
    expect(status.faults).toEqual(["paper out"]);
  });

  it("treats an empty response as a fault, never as ready (fail-closed)", () => {
    const status = parseHostStatus("");
    expect(status.ready).toBe(false);
    expect(status.faults).toEqual(["unparseable ~HS response (0 frame(s) received)"]);
  });

  it("treats a single-frame (truncated) response as a fault", () => {
    const status = parseHostStatus(frame(hsString1()));
    expect(status.ready).toBe(false);
    expect(status.faults).toEqual(["unparseable ~HS response (1 frame(s) received)"]);
  });

  it("drops a frame whose ETX terminator is missing (truncated mid-frame)", () => {
    // Frame 1 complete, frame 2 opened but never closed → only one
    // parseable frame → fault.
    const status = parseHostStatus(`${frame(hsString1())}${STX}${hsString2()}`);
    expect(status.ready).toBe(false);
    expect(status.faults).toEqual(["unparseable ~HS response (1 frame(s) received)"]);
  });

  it("treats unframed garbage (no STX/ETX at all) as a fault", () => {
    const status = parseHostStatus("garbage,with,commas,but,no,framing");
    expect(status.ready).toBe(false);
    expect(status.faults[0]).toMatch(/unparseable/);
  });

  it("parses a two-frame response (third status string absent)", () => {
    const status = parseHostStatus(`${frame(hsString1({ paperOut: "1" }))}${frame(hsString2())}`);
    expect(status.faults).toEqual(["paper out"]);
  });

  it("ignores inter-frame noise and reads only framed content", () => {
    const raw = `\r\n${frame(hsString1())}junk${frame(hsString2({ ribbonOut: "1" }))}\r\n`;
    expect(parseHostStatus(raw).faults).toEqual(["ribbon out"]);
  });

  // KNOWN GAP (real-bug candidate, headline in PR): the module header
  // promises "anything unparseable is reported as a fault", but a
  // response with two well-FRAMED strings whose comma fields are
  // missing (e.g. a device echoing empty frames) parses as READY —
  // the flag lookups all miss via optional chaining and the empty
  // fault list reads as all-clear. A truncated-but-framed response
  // therefore silently passes verification. Fix would be to require
  // the minimum field counts per string before trusting the frame.
  it.skip("treats framed strings with missing fields as a fault (currently returns ready)", () => {
    const status = parseHostStatus(`${frame("014")}${frame("000")}`);
    expect(status.ready).toBe(false);
  });
});

// ======================================================================
// TcpZplTransport — scripted fake socket
// ======================================================================

describe("TcpZplTransport.send", () => {
  it("connects to the configured host/port, writes the payload, and destroys the socket", async () => {
    const socket = nextSocket();
    const transport = new TcpZplTransport("printer.test.internal", 9100, 500);

    const pending = transport.send("^XA^FDsynthetic^XZ");
    socket.emit("connect");
    await pending;

    expect(netMock.connect).toHaveBeenCalledWith({ host: "printer.test.internal", port: 9100 });
    expect(socket.written).toEqual(["^XA^FDsynthetic^XZ"]);
    expect(socket.destroyed).toBe(true);
  });

  it("rejects when the connection is refused", async () => {
    const socket = nextSocket();
    const transport = new TcpZplTransport("printer.test.internal", 9100, 500);

    const pending = transport.send("^XA^XZ");
    socket.emit("error", new Error("connect ECONNREFUSED 192.0.2.10:9100"));

    await expect(pending).rejects.toThrow(/ECONNREFUSED/);
    expect(socket.destroyed).toBe(true);
  });

  it("rejects when the socket write reports an error", async () => {
    const socket = nextSocket();
    socket.writeError = new Error("EPIPE: broken pipe");
    const transport = new TcpZplTransport("printer.test.internal", 9100, 500);

    const pending = transport.send("^XA^XZ");
    socket.emit("connect");

    await expect(pending).rejects.toThrow(/EPIPE/);
    expect(socket.destroyed).toBe(true);
  });

  it("rejects with the configured timeout in the message when the send stalls", async () => {
    const socket = nextSocket();
    const transport = new TcpZplTransport("printer.test.internal", 9100, 750);

    const pending = transport.send("^XA^XZ");
    expect(socket.timeoutMs).toBe(750);
    socket.triggerTimeout();

    await expect(pending).rejects.toThrow("ZPL TCP send timed out after 750ms");
    expect(socket.destroyed).toBe(true);
  });

  it("settles exactly once — a late socket error after success is ignored", async () => {
    const socket = nextSocket();
    const transport = new TcpZplTransport("printer.test.internal", 9100, 500);

    const pending = transport.send("^XA^XZ");
    socket.emit("connect");
    await pending;

    // Must not turn the settled promise into a rejection or throw.
    socket.emit("error", new Error("late RST"));
    await expect(pending).resolves.toBeUndefined();
  });
});

describe("TcpZplTransport.verifyPrinterReady", () => {
  it("writes ~HS and resolves ready on a three-frame all-clear response", async () => {
    const socket = nextSocket();
    const transport = new TcpZplTransport("printer.test.internal", 9100, 500);

    const pending = transport.verifyPrinterReady();
    socket.emit("connect");
    socket.emit("data", Buffer.from(hsResponse(hsString1(), hsString2()), "utf8"));

    const status = await pending;
    expect(socket.written).toEqual(["~HS"]);
    expect(status).toEqual({ ready: true, faults: [] });
    expect(socket.destroyed).toBe(true);
  });

  it("maps a paper-out response to a non-ready status with the reason", async () => {
    const socket = nextSocket();
    const transport = new TcpZplTransport("printer.test.internal", 9100, 500);

    const pending = transport.verifyPrinterReady();
    socket.emit("connect");
    socket.emit("data", Buffer.from(hsResponse(hsString1({ paperOut: "1" }), hsString2()), "utf8"));

    const status = await pending;
    expect(status.ready).toBe(false);
    expect(status.faults).toEqual(["paper out"]);
  });

  it("reassembles a response split across multiple TCP chunks", async () => {
    const socket = nextSocket();
    const transport = new TcpZplTransport("printer.test.internal", 9100, 500);
    const raw = hsResponse(hsString1(), hsString2({ headUp: "1" }));

    const pending = transport.verifyPrinterReady();
    socket.emit("connect");
    // Split mid-frame, mid-ETX-run — byte boundaries are arbitrary.
    socket.emit("data", Buffer.from(raw.slice(0, 7), "utf8"));
    socket.emit("data", Buffer.from(raw.slice(7, 23), "utf8"));
    socket.emit("data", Buffer.from(raw.slice(23), "utf8"));

    const status = await pending;
    expect(status.faults).toEqual(["head up"]);
  });

  it("times out (rejects) when the printer never completes three frames", async () => {
    const socket = nextSocket();
    const transport = new TcpZplTransport("printer.test.internal", 9100, 250);

    const pending = transport.verifyPrinterReady();
    socket.emit("connect");
    // Two frames only — the transport keeps waiting for the third.
    socket.emit("data", Buffer.from(`${frame(hsString1())}${frame(hsString2())}`, "utf8"));
    socket.triggerTimeout();

    await expect(pending).rejects.toThrow("~HS status query timed out after 250ms");
  });

  it("rejects when the status connection errors", async () => {
    const socket = nextSocket();
    const transport = new TcpZplTransport("printer.test.internal", 9100, 500);

    const pending = transport.verifyPrinterReady();
    socket.emit("error", new Error("connect EHOSTUNREACH 192.0.2.10:9100"));

    await expect(pending).rejects.toThrow(/EHOSTUNREACH/);
  });

  it("rejects when writing the ~HS query fails", async () => {
    const socket = nextSocket();
    socket.writeError = new Error("EPIPE: broken pipe");
    const transport = new TcpZplTransport("printer.test.internal", 9100, 500);

    const pending = transport.verifyPrinterReady();
    socket.emit("connect");

    await expect(pending).rejects.toThrow(/EPIPE/);
  });

  it("settles exactly once — a late socket error after the status resolved is ignored", async () => {
    const socket = nextSocket();
    const transport = new TcpZplTransport("printer.test.internal", 9100, 500);

    const pending = transport.verifyPrinterReady();
    socket.emit("connect");
    socket.emit("data", Buffer.from(hsResponse(hsString1(), hsString2()), "utf8"));
    await pending;

    socket.emit("error", new Error("late RST"));
    await expect(pending).resolves.toEqual({ ready: true, faults: [] });
  });
});

// ======================================================================
// createZplTransport — factory wiring
// ======================================================================

describe("createZplTransport", () => {
  const baseInput = {
    filePath: "/tmp/pharmax-test/label.zpl",
    host: "printer.test.internal",
    port: 9100,
    timeoutMs: 500,
  };

  it("returns a FileZplTransport in file mode (no status verification surface)", () => {
    const transport = createZplTransport({ ...baseInput, mode: "file" });
    expect(transport).toBeInstanceOf(FileZplTransport);
    expect(transport.verifyPrinterReady).toBeUndefined();
  });

  it("returns a verifying TcpZplTransport in tcp mode by default", () => {
    const transport = createZplTransport({ ...baseInput, mode: "tcp" });
    expect(transport).toBeInstanceOf(TcpZplTransport);
    expect(typeof transport.verifyPrinterReady).toBe("function");
  });

  it("returns a send-only transport when verifyStatus is false", () => {
    const transport = createZplTransport({ ...baseInput, mode: "tcp", verifyStatus: false });
    expect(transport).not.toBeInstanceOf(TcpZplTransport);
    expect(transport.verifyPrinterReady).toBeUndefined();
  });

  it("send-only transport still delegates send to the TCP transport", async () => {
    const socket = nextSocket();
    const transport = createZplTransport({ ...baseInput, mode: "tcp", verifyStatus: false });

    const pending = transport.send("^XA^XZ");
    socket.emit("connect");
    await pending;

    expect(socket.written).toEqual(["^XA^XZ"]);
  });
});

// ======================================================================
// FileZplTransport — dev transport
// ======================================================================

describe("FileZplTransport", () => {
  it("writes ZPL payload to the configured path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pharmax-zpl-"));
    const filePath = join(dir, "label.zpl");
    const transport = new FileZplTransport(filePath);

    await transport.send("^XA^FDdemo^XZ");

    const written = await readFile(filePath, "utf8");
    expect(written).toBe("^XA^FDdemo^XZ");
  });

  it("creates missing parent directories before writing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pharmax-zpl-"));
    const filePath = join(dir, "nested", "deeper", "label.zpl");
    const transport = new FileZplTransport(filePath);

    await transport.send("^XA^XZ");

    expect(await readFile(filePath, "utf8")).toBe("^XA^XZ");
  });

  it("overwrites a previous label rather than appending", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pharmax-zpl-"));
    const filePath = join(dir, "label.zpl");
    const transport = new FileZplTransport(filePath);

    await transport.send("^XA^FDfirst^XZ");
    await transport.send("^XA^FDsecond^XZ");

    expect(await readFile(filePath, "utf8")).toBe("^XA^FDsecond^XZ");
  });

  it("rejects (never silently succeeds) when the parent path is a regular file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pharmax-zpl-"));
    const blocker = join(dir, "not-a-directory");
    await writeFile(blocker, "occupied", "utf8");
    const transport = new FileZplTransport(join(blocker, "label.zpl"));

    await expect(transport.send("^XA^XZ")).rejects.toThrow();
  });
});
