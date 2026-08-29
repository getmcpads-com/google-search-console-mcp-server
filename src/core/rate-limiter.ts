/**
 * google-search-console-mcp-server: an open-source MCP server for Google Search Console.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 */
import { logger } from "./logger.js";

export class RateLimiter {
  private timestamps: number[] = [];

  async acquire(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 60_000);
    const lastSecond = this.timestamps.filter((t) => now - t < 1_000);

    if (lastSecond.length >= 10) {
      const waitMs = 1_000 - (now - lastSecond[0]) + 50;
      logger.debug("gsc", `Rate limit wait: ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    if (this.timestamps.length >= 600) {
      const waitMs = 60_000 - (now - this.timestamps[0]) + 100;
      logger.debug("gsc", `Minute rate limit wait: ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    this.timestamps.push(Date.now());
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    for (let i = 0; i <= 3; i++) {
      await this.acquire();
      try {
        return await fn();
      } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : "";
        const code = typeof (error as { code?: unknown })?.code === "number"
          ? (error as { code: number }).code
          : undefined;
        const isRateLimit = code === 429 || message.includes("rate limit") || message.includes("quota");
        if (isRateLimit && i < 3) {
          const waitMs = Math.min(1_000 * Math.pow(2, i) + Math.floor(Math.random() * 500), 30_000);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }
        throw error;
      }
    }

    throw new Error("Rate limiter exhausted retries");
  }
}
