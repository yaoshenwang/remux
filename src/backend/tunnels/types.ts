/**
 * Tunnel provider abstraction.
 *
 * Both Cloudflare and DevTunnel implement this interface so the
 * CLI can switch between them via --tunnel-provider flag.
 */

export interface TunnelResult {
  publicUrl: string;
}

export interface TunnelProvider {
  /** Start the tunnel, exposing the given local port. */
  start(port: number): Promise<TunnelResult>;
  /** Stop the tunnel. */
  stop(): void;
}
