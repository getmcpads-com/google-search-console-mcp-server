/**
 * google-search-console-mcp-server: an open-source MCP server for Google Search Console.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GSCConfig } from "../../config.js";
import { registerGSCTools } from "./tools.js";
import { registerGSCResources } from "./resources.js";
import { logger } from "../../core/logger.js";

export function registerGSC(server: McpServer, config: GSCConfig): void {
  registerGSCTools(server, config);
  registerGSCResources(server);
  logger.info("gsc", "Registered 20 read tools and 7 resources");
}
