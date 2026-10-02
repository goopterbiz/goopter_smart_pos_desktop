import net from "node:net";
import type { Destination } from "./destination.js";
import { JobFailure } from "./jobFailure.js";

export interface PrinterTransport {
  /**
   * Write `data` to `destination` and return the byte count.
   *
   * Rejects with a `JobFailure`, or with `signal.reason` when aborted so the deadline names the
   * failure. `onConnected` fires once, after the socket opens and before any byte is written.
   */
  send(
    data: Uint8Array,
    destination: Destination,
    connectTimeoutMs: number,
    signal: AbortSignal,
    onConnected: () => void,
  ): Promise<number>;
}

/**
 * One TCP connection per job (SPEC §7). Connections are never reused: a printer typically accepts
 * a single connection on 9100, so holding one open would lock every other client out of it.
 *
 * "Written" means handed to the local network stack, the same definition iOS and Android use. It
 * is not a claim that paper moved.
 */
export class SocketPrinterTransport implements PrinterTransport {
  send(
    data: Uint8Array,
    destination: Destination,
    connectTimeoutMs: number,
    signal: AbortSignal,
    onConnected: () => void,
  ): Promise<number> {
    // A cancelled job is kept away from the socket entirely.
    if (signal.aborted) return Promise.reject(signal.reason);
    const target = destination.toString();

    return new Promise<number>((resolve, reject) => {
      const socket = new net.Socket();
      let connected = false;
      let settled = false;

      const finish = (outcome: { error: unknown } | { bytes: number }) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        signal.removeEventListener("abort", onAbort);
        if ("error" in outcome) {
          // A reset, not a close: a graceful close lets the kernel keep sending what it already
          // buffered after the printer has been handed to the next job. The reset discards it and
          // frees the printer's one connection at once.
          if (connected) socket.resetAndDestroy();
          else socket.destroy();
          reject(outcome.error);
        } else {
          resolve(outcome.bytes);
        }
      };

      const onAbort = () => finish({ error: signal.reason });
      signal.addEventListener("abort", onAbort, { once: true });

      const connectTimer = setTimeout(() => finish({ error: JobFailure.unreachable(target) }), connectTimeoutMs);

      socket.on("error", (error: NodeJS.ErrnoException) => {
        if (connected) {
          finish({ error: JobFailure.writeStalled(target) });
        } else if (error.code === "ECONNREFUSED") {
          // The host is up and saying no, for a printer usually busy with another till. Reported
          // now rather than after the connect timeout.
          finish({ error: JobFailure.connectionRefused(target) });
        } else {
          finish({ error: JobFailure.unreachable(target) });
        }
      });

      // Read and discard anything the printer sends, such as status bytes. Closing a socket with
      // unread input makes the kernel reset the connection, which can drop the tail of a receipt.
      socket.on("data", () => undefined);

      socket.connect({ host: destination.host, port: destination.port }, () => {
        connected = true;
        clearTimeout(connectTimer);
        onConnected();
        if (settled) return;
        socket.write(data, (error) => {
          if (error) {
            finish({ error: JobFailure.writeStalled(target) });
            return;
          }
          // Every byte is with the network stack. End the stream so the FIN follows the data, and
          // let the socket close on its own once the printer closes its side.
          socket.end();
          socket.setTimeout(5_000, () => socket.destroy());
          finish({ bytes: data.length });
        });
      });
    });
  }
}
