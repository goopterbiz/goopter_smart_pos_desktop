import dgram from "node:dgram";
import { hasLocalNetworkPermission } from "./localNetworkSuspicion.js";
import { safely, type LogSink } from "./logEntry.js";

/** mDNS. A multicast address, so TN3179 counts it as a local network address on every subnet. */
const PROMPT_HOST = "224.0.0.251";
const PROMPT_PORT = 5353;

/** The slice of `dgram.Socket` this module touches, narrowed so a test can supply a fake. */
export interface UdpSocket {
  connect(port: number, address: string, callback: () => void): void;
  close(callback?: () => void): void;
  once(event: "error", listener: (error: NodeJS.ErrnoException) => void): void;
}

export type UdpSocketFactory = () => UdpSocket;

const defaultSocketFactory: UdpSocketFactory = () => dgram.createSocket("udp4");

/**
 * Brings up macOS 15's Local Network prompt at launch instead of at the first print (SPEC §8.2,
 * C3). TN3179's documented trigger is connecting a UDP socket to a local network address; no bytes
 * are sent, and every multicast address qualifies, so `224.0.0.251:5353` (mDNS) is used without
 * needing a real printer's address.
 *
 * A no-op everywhere `hasLocalNetworkPermission` is false: earlier macOS, Windows and Linux have no
 * such prompt to bring up. Never throws and never delays its caller; call it without awaiting it,
 * same as the shell does before `pos.openHome()`.
 */
export async function requestLocalNetworkPrompt(
  platform: string,
  osRelease: string,
  log: LogSink,
  createSocket: UdpSocketFactory = defaultSocketFactory,
): Promise<void> {
  if (!hasLocalNetworkPermission(platform, osRelease)) return;

  const outcome = await new Promise<string>((resolve) => {
    let settled = false;
    const finish = (result: string) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      const socket = createSocket();

      // Fires for a failure the connect itself reports asynchronously, such as no route to the
      // multicast group. Attached before connect() so it cannot be missed.
      socket.once("error", (error) => {
        finish(errorCode(error));
        try {
          socket.close();
        } catch {
          // Already gone.
        }
      });

      socket.connect(PROMPT_PORT, PROMPT_HOST, () => {
        try {
          socket.close(() => finish("requested"));
        } catch (error) {
          finish(errorCode(error));
        }
      });
    } catch (error) {
      // The factory or a synchronous connect() failure. Nothing was opened, so nothing to close.
      finish(errorCode(error));
    }
  });

  await safely(log, { timestamp: new Date(), event: "local_network", origin: "app", outcome });
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : "unknown_error";
}
