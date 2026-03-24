/**
 * Wrap the existing CloudflaredManager to implement TunnelProvider.
 */

import { CloudflaredManager, type CloudflaredResult } from "../cloudflared/manager.js";
import type { TunnelProvider, TunnelResult } from "./types.js";

export class CloudflareTunnelProvider implements TunnelProvider {
  private readonly manager = new CloudflaredManager();

  async start(port: number): Promise<TunnelResult> {
    const result: CloudflaredResult = await this.manager.start(port);
    return { publicUrl: result.publicUrl };
  }

  stop(): void {
    this.manager.stop();
  }
}
