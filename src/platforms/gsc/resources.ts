/**
 * google-search-console-mcp-server: an open-source MCP server for Google Search Console.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GSC_METRIC_CATALOG } from "./metricCatalog.js";
import { GSC_CALCULATED_METRIC_DEFINITIONS } from "./calculatedMetrics.js";
import { GSC_DIMENSION_CATALOG } from "./dimensionCatalog.js";
import { GSC_FILTER_CATALOG } from "./filterCatalog.js";
import { GSC_OAUTH_SCOPE } from "./types.js";

const GSC_MANIFEST = {
  platform: "google-search-console",
  package: "@getmcpads/google-search-console-mcp-server",
  access: "read-only",
  oauthScope: GSC_OAUTH_SCOPE,
  defaultPropertyEnv: "GSC_SITE_URL",
  quotaNotes: {
    searchAnalytics: "Read-only Search Analytics queries. Maximum 25,000 rows per request.",
    urlInspection: "Read-only URL Inspection. Google quota is limited; bulk inspection is capped at 10 URLs per call.",
    p2Monitoring: "P2 tools are read-only orchestration helpers. Delta tracking is caller-managed: pass prior snapshots back in; no server-side state is written.",
  },
  tools: [
    { name: "gsc_health_check", category: "diagnostics", description: "Verify auth, visible sites, default property, permissions, and warnings." },
    { name: "gsc_list_sites", category: "properties", description: "List visible Search Console properties." },
    { name: "gsc_get_site", category: "properties", description: "Get one property and its exact permission level." },
    { name: "gsc_query_search_analytics", category: "analytics", description: "Query clicks, impressions, CTR, and position across supported dimensions." },
    { name: "gsc_get_data_freshness", category: "analytics", description: "Find the latest recent date with Search Analytics data." },
    { name: "gsc_monitor_indexation_freshness", category: "monitoring", description: "Monitor Search Analytics freshness, sitemap indexation totals, and optional small URL Inspection samples." },
    { name: "gsc_track_sitemap_deltas", category: "sitemaps", description: "Compare current sitemap counts/statuses to an agent-provided baseline snapshot." },
    { name: "gsc_analyze_search_appearance_trends", category: "analytics", description: "Trend structured data/rich result visibility via searchAppearance when available." },
    { name: "gsc_plan_large_site_sampling", category: "planning", description: "Build a large-site URL Inspection sampling plan from sitemaps and page analytics." },
    { name: "gsc_indexation_watchlist", category: "indexing", description: "Inspect up to 10 watchlist URLs and classify alert/review/ok indexation status." },
    { name: "gsc_find_losses_gains", category: "analytics", description: "Compare query/page performance between two periods." },
    { name: "gsc_cluster_queries", category: "analytics", description: "Cluster queries by brand, question intent, category, and tokens." },
    { name: "gsc_detect_cannibalization", category: "analytics", description: "Detect queries where multiple pages compete." },
    { name: "gsc_inspect_url", category: "indexing", description: "Inspect one URL for indexing, mobile usability, AMP, and rich result status." },
    { name: "gsc_bulk_inspect_urls", category: "indexing", description: "Inspect up to 10 URLs sequentially with normalized results." },
    { name: "gsc_list_sitemaps", category: "sitemaps", description: "List submitted sitemaps." },
    { name: "gsc_get_sitemap", category: "sitemaps", description: "Get one submitted sitemap by feed path." },
    { name: "gsc_get_sitemap_health", category: "sitemaps", description: "Summarize sitemap status, warnings, errors, submitted, and indexed counts." },
    { name: "gsc_compare_search_types", category: "analytics", description: "Compare web, image, video, news, Discover, and Google News performance." },
    { name: "gsc_validate_query", category: "planning", description: "Validate dimensions/search type/date compatibility." },
  ],
  resources: [
    "gsc://manifest",
    "gsc://recipes",
    "gsc://metrics",
    "gsc://dimensions",
    "gsc://filters",
    "gsc://compatibility",
    "gsc://p2-readonly-playbooks",
  ],
};

const GSC_RECIPES = [
  {
    name: "preflight",
    goal: "Confirm the MCP can read the right GSC property before analysis.",
    steps: [
      { tool: "gsc_health_check", args: { siteUrl: "optional property URL" } },
      { tool: "gsc_get_data_freshness", args: { searchType: "web", lookbackDays: 14 } },
    ],
  },
  {
    name: "weekly-performance-review",
    goal: "Find query or page winners and losers between two equal periods.",
    steps: [
      { tool: "gsc_find_losses_gains", args: { dimension: "query", datePreset: "last28days", topN: 25 } },
      { tool: "gsc_find_losses_gains", args: { dimension: "page", datePreset: "last28days", topN: 25 } },
    ],
  },
  {
    name: "indexing-and-sitemap-triage",
    goal: "Check sitemap health, then inspect a small set of URLs without burning URL Inspection quota.",
    steps: [
      { tool: "gsc_get_sitemap_health", args: {} },
      { tool: "gsc_bulk_inspect_urls", args: { urls: ["https://example.com/page"], continueOnError: true } },
    ],
    caution: "Keep URL Inspection batches small; bulk calls are capped at 10 URLs.",
  },
  {
    name: "p2-readonly-monitoring",
    goal: "Run a no-write monitoring pass for freshness, sitemap indexation, and optional critical URL checks.",
    steps: [
      { tool: "gsc_monitor_indexation_freshness", args: { searchTypes: ["web"], lookbackDays: 14, inspectUrls: [] } },
      { tool: "gsc_indexation_watchlist", args: { urls: [{ url: "https://example.com/important-page", priority: "high" }] } },
    ],
    caution: "URL Inspection quota is limited; keep watchlists capped at 10 URLs per call.",
  },
  {
    name: "p2-sitemap-delta-loop",
    goal: "Compare sitemap submitted/indexed counts against a previous agent-held snapshot.",
    steps: [
      { tool: "gsc_track_sitemap_deltas", args: { baseline: [] } },
      { tool: "gsc_track_sitemap_deltas", args: { baseline: [{ path: "https://example.com/sitemap.xml", submitted: 1000, indexed: 950, warnings: 0, errors: 0 }] } },
    ],
    caution: "This server does not persist snapshots. Store snapshots in the calling workflow if deltas are needed later.",
  },
  {
    name: "p2-rich-result-trends",
    goal: "Track structured data and rich-result visibility via Search Analytics searchAppearance rows.",
    steps: [
      { tool: "gsc_analyze_search_appearance_trends", args: { datePreset: "last28days", includePages: false } },
      { tool: "gsc_analyze_search_appearance_trends", args: { datePreset: "last28days", includePages: true, topN: 25 } },
    ],
    caution: "searchAppearance only returns rows when the property/date/search type has appearance data available.",
  },
  {
    name: "p2-large-site-sampling",
    goal: "Create an inspection sample before spending URL Inspection quota on a large site.",
    steps: [
      { tool: "gsc_plan_large_site_sampling", args: { datePreset: "last28days", maxInspectionUrls: 10 } },
      { tool: "gsc_indexation_watchlist", args: { urls: [{ url: "https://example.com/page-from-recommendedInspectionUrls", priority: "medium" }] } },
    ],
  },
  {
    name: "content-opportunity-map",
    goal: "Cluster demand and detect query-page overlap.",
    steps: [
      { tool: "gsc_cluster_queries", args: { datePreset: "last28days", limit: 5000 } },
      { tool: "gsc_detect_cannibalization", args: { datePreset: "last28days", minImpressions: 100 } },
    ],
  },
];

const GSC_P2_READONLY_PLAYBOOKS = {
  scope: "P2 read-only agent workflows for monitoring freshness/indexation, sitemap deltas, rich-result trends, large-site sampling, and indexation watchlists.",
  invariants: [
    "No tool writes to Search Console or local state.",
    "Sitemap delta tracking compares against caller-provided baselines only.",
    "URL Inspection is read-only but quota-limited; all P2 inspection tools cap calls at 10 URLs.",
    "Use Search Analytics searchAppearance only when rows are available for the selected property/date/search type.",
  ],
  workflows: [
    {
      name: "freshness-indexation-monitor",
      primaryTool: "gsc_monitor_indexation_freshness",
      followUps: ["gsc_track_sitemap_deltas", "gsc_indexation_watchlist"],
      outputUse: "Alert on stale Search Analytics data, sitemap errors/pending states, or unexpected URL Inspection verdicts.",
    },
    {
      name: "sitemap-delta-tracking",
      primaryTool: "gsc_track_sitemap_deltas",
      followUps: ["gsc_get_sitemap_health"],
      outputUse: "Persist the returned snapshot externally, then pass it as baseline on the next run.",
    },
    {
      name: "structured-data-trends",
      primaryTool: "gsc_analyze_search_appearance_trends",
      followUps: ["gsc_query_search_analytics"],
      outputUse: "Find searchAppearance winners/losses and optionally page-level feature changes.",
    },
    {
      name: "large-site-indexation-sampling",
      primaryTool: "gsc_plan_large_site_sampling",
      followUps: ["gsc_indexation_watchlist", "gsc_bulk_inspect_urls"],
      outputUse: "Spend URL Inspection quota on representative top-traffic, low-CTR, declining, and sitemap-risk URLs.",
    },
  ],
};

export function registerGSCResources(server: McpServer): void {
  server.resource("gsc-manifest", "gsc://manifest", async () => ({
    contents: [{
      uri: "gsc://manifest",
      mimeType: "application/json",
      text: JSON.stringify(GSC_MANIFEST, null, 2),
    }],
  }));

  server.resource("gsc-recipes", "gsc://recipes", async () => ({
    contents: [{
      uri: "gsc://recipes",
      mimeType: "application/json",
      text: JSON.stringify(GSC_RECIPES, null, 2),
    }],
  }));

  server.resource("gsc-metrics", "gsc://metrics", async () => ({
    contents: [{
      uri: "gsc://metrics",
      mimeType: "application/json",
      text: JSON.stringify([...GSC_METRIC_CATALOG, ...GSC_CALCULATED_METRIC_DEFINITIONS], null, 2),
    }],
  }));

  server.resource("gsc-dimensions", "gsc://dimensions", async () => ({
    contents: [{
      uri: "gsc://dimensions",
      mimeType: "application/json",
      text: JSON.stringify(GSC_DIMENSION_CATALOG, null, 2),
    }],
  }));

  server.resource("gsc-filters", "gsc://filters", async () => ({
    contents: [{
      uri: "gsc://filters",
      mimeType: "application/json",
      text: JSON.stringify(GSC_FILTER_CATALOG, null, 2),
    }],
  }));

  server.resource("gsc-compatibility", "gsc://compatibility", async () => ({
    contents: [{
      uri: "gsc://compatibility",
      mimeType: "application/json",
      text: JSON.stringify({
        description: "Google Search Console Search Analytics constraints.",
        maxDimensions: 5,
        dimensions: ["query", "page", "country", "device", "date", "hour", "searchAppearance"],
        searchTypes: ["web", "image", "video", "news", "discover", "googleNews"],
        queryDimensionUnsupportedFor: ["discover", "googleNews"],
        dataStates: ["final", "all", "hourly_all"],
        aggregationTypes: ["auto", "byPage", "byProperty", "byNewsShowcasePanel"],
        aggregationRules: {
          byProperty: "Cannot group or filter by page and is unsupported for discover/googleNews.",
          byNewsShowcasePanel: "Requires type=discover or type=googleNews and searchAppearance equals NEWS_SHOWCASE; cannot group/filter by page or filter to another searchAppearance.",
        },
        dataFreshness: "final is stable; all includes incomplete daily data; hourly_all requires hour, is limited to 10 days, and can return firstIncompleteHour metadata.",
        rowLimitMax: 25000,
      }, null, 2),
    }],
  }));

  server.resource("gsc-p2-readonly-playbooks", "gsc://p2-readonly-playbooks", async () => ({
    contents: [{
      uri: "gsc://p2-readonly-playbooks",
      mimeType: "application/json",
      text: JSON.stringify(GSC_P2_READONLY_PLAYBOOKS, null, 2),
    }],
  }));
}
