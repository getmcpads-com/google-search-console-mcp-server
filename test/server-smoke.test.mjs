import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(repoRoot, "..", "..");
const binName = process.platform === "win32" ? "tsx.cmd" : "tsx";
const localTsxBin = path.join(repoRoot, "node_modules", ".bin", binName);
const workspaceTsxBin = path.join(workspaceRoot, "node_modules", ".bin", binName);
const tsxBin = fs.existsSync(localTsxBin) ? localTsxBin : workspaceTsxBin;

function cleanEnv(extra) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === "string")),
    ...extra,
  };
}

test("Google Search Console MCP exposes core tools and resources over stdio", async () => {
  const client = new Client({ name: "gsc-mcp-smoke", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: tsxBin,
    args: ["src/cli.ts"],
    cwd: repoRoot,
    env: cleanEnv({
      GSC_ACCESS_TOKEN: "test-access-token",
      LOG_LEVEL: "error",
    }),
    stderr: "pipe",
  });

  try {
    await client.connect(transport, { timeout: 15000 });
    const tools = await client.listTools(undefined, { timeout: 15000 });
    const toolNames = tools.tools.map((tool) => tool.name);
    assert.equal(toolNames.length, 20);

    for (const name of [
      "gsc_health_check",
      "gsc_query_search_analytics",
      "gsc_validate_query",
      "gsc_detect_cannibalization",
      "gsc_get_site",
      "gsc_get_sitemap",
    ]) {
      assert.ok(toolNames.includes(name), `missing tool ${name}`);
    }

    const resources = await client.listResources(undefined, { timeout: 15000 });
    const resourceUris = resources.resources.map((resource) => resource.uri);

    for (const uri of [
      "gsc://manifest",
      "gsc://metrics",
      "gsc://compatibility",
    ]) {
      assert.ok(resourceUris.includes(uri), `missing resource ${uri}`);
    }

    const manifest = await client.readResource({ uri: "gsc://manifest" }, { timeout: 15000 });
    const manifestJson = JSON.parse(manifest.contents[0].text);
    assert.equal(manifestJson.tools.length, 20);
  } finally {
    await transport.close().catch(() => undefined);
  }
});
