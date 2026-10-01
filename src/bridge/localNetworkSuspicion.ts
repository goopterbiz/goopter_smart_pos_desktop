import { PERMISSION_SUSPICION_DISTINCT_HOSTS, PERMISSION_SUSPICION_FAILURES } from "./constants.js";

/**
 * Guesses whether macOS local network access was denied (SPEC §8.2).
 *
 * macOS 15 and later ask before an app may reach the store LAN, and no API reads the answer, so a
 * denial and an unplugged printer arrive as the same failure. Several distinct printers failing
 * in a row with no success between them is the shape a denial makes. One printer failing
 * repeatedly is an ordinary broken printer.
 *
 * Not used on Windows or Linux, which have no such permission.
 */
export class LocalNetworkSuspicion {
  private readonly failedHosts = new Set<string>();
  private consecutiveFailures = 0;

  recordFailure(host: string): void {
    this.failedHosts.add(host);
    this.consecutiveFailures += 1;
  }

  /** Any success clears it, including a refused connection: the printer answered. */
  recordSuccess(): void {
    this.failedHosts.clear();
    this.consecutiveFailures = 0;
  }

  get isSuspected(): boolean {
    return (
      this.failedHosts.size >= PERMISSION_SUSPICION_DISTINCT_HOSTS &&
      this.consecutiveFailures >= PERMISSION_SUSPICION_FAILURES
    );
  }
}

/**
 * Whether this system gates the store LAN behind the Local Network permission the §8.2 message
 * names. macOS 15 (Darwin 24) introduced it; earlier macOS, Windows and Linux have nothing to turn
 * on, so pointing staff at it would send them looking for a setting that does not exist.
 */
export function hasLocalNetworkPermission(platform: string, osRelease: string): boolean {
  if (platform !== "darwin") return false;
  const darwinMajor = Number.parseInt(osRelease, 10);
  return Number.isFinite(darwinMajor) && darwinMajor >= 24;
}
