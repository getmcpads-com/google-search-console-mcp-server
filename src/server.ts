/**
 * google-search-console-mcp-server: an open-source MCP server for Google Search Console.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GSCConfig } from "./config.js";
import { registerGSC } from "./platforms/gsc/index.js";
import { logger } from "./core/logger.js";

export const PACKAGE_VERSION = "1.0.2";

export function createServer(config: GSCConfig): McpServer {
  const server = new McpServer(
    { name: "google-search-console-mcp", version: PACKAGE_VERSION },
    { capabilities: { tools: { listChanged: true }, resources: { subscribe: false, listChanged: true } } },
  );

  registerGSC(server, config);

  logger.system(`google-search-console-mcp v${PACKAGE_VERSION} ready, read-only`);
  return server;
}
