/**
 * google-search-console-mcp-server: an open-source MCP server for Google Search Console.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from "zod";
import { logger } from "./core/logger.js";

const configSchema = z.object({
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  refreshToken: z.string().optional(),
  accessToken: z.string().optional(),
  defaultSiteUrl: z.string().optional(),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type GSCConfig = z.infer<typeof configSchema>;

export function loadConfig(): GSCConfig {
  const raw = {
    clientId: process.env["GSC_CLIENT_ID"] || undefined,
    clientSecret: process.env["GSC_CLIENT_SECRET"] || undefined,
    refreshToken: process.env["GSC_REFRESH_TOKEN"] || undefined,
    accessToken: process.env["GSC_ACCESS_TOKEN"] || undefined,
    defaultSiteUrl: process.env["GSC_SITE_URL"] || undefined,
    logLevel: process.env["LOG_LEVEL"] ?? "info",
  };

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const missing = result.error.issues.map((issue) => issue.message).join(", ");
    logger.error("config", `Invalid GSC config: ${missing}`);
    throw new Error(`Invalid GSC config: ${missing}`);
  }

  const config = result.data;
  const canRefresh = Boolean(config.refreshToken && config.clientId && config.clientSecret);
  if (!config.accessToken && !canRefresh) {
    throw new Error(
      "Missing GSC credentials: set GSC_ACCESS_TOKEN, or set GSC_CLIENT_ID, GSC_CLIENT_SECRET, and GSC_REFRESH_TOKEN.",
    );
  }

  return config;
}
