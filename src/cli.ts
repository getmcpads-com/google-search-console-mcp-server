#!/usr/bin/env node
/**
 * google-search-console-mcp-server: an open-source MCP server for Google Search Console.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { logger } from "./core/logger.js";

async function main(): Promise<void> {
  try {
    const config = loadConfig();
    logger.setLevel(config.logLevel);
    const server = createServer(config);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.system("Stdio transport connected - waiting for MCP client");
  } catch (error) {
    logger.error("cli", "Fatal error", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
