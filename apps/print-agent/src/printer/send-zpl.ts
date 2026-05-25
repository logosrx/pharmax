import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { connect, type Socket } from "node:net";

export interface ZplTransport {
  send(zpl: string): Promise<void>;
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
}

export function createZplTransport(input: {
  mode: "file" | "tcp";
  filePath: string;
  host: string;
  port: number;
  timeoutMs: number;
}): ZplTransport {
  if (input.mode === "file") {
    return new FileZplTransport(input.filePath);
  }
  return new TcpZplTransport(input.host, input.port, input.timeoutMs);
}
