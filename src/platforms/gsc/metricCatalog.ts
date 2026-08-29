/**
 * google-search-console-mcp-server: an open-source MCP server for Google Search Console.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 */
// ============================================
// GSC METRIC CATALOG
// 4 native metrics returned by the Search Analytics API
// ============================================

import type { GSCMetricDefinition } from "./types.js";

export const GSC_METRIC_CATALOG: GSCMetricDefinition[] = [
  // ============================================
  // PERFORMANCE METRICS (always returned by API)
  // ============================================
  {
    key: "clicks",
    name: "Clicks",
    description: "Number of clicks from Google Search results to your site",
    category: "performance",
    format: "number",
    apiField: "clicks",
    type: "api",
  },
  {
    key: "impressions",
    name: "Impressions",
    description: "Number of times your site appeared in Google Search results",
    category: "performance",
    format: "number",
    apiField: "impressions",
    type: "api",
  },
  {
    key: "ctr",
    name: "CTR",
    description: "Click-through rate: clicks / impressions (percentage)",
    category: "performance",
    format: "percent",
    apiField: "ctr",
    type: "api",
  },
  {
    key: "position",
    name: "Average Position",
    description: "Average ranking position in Google Search results (1 = top)",
    category: "performance",
    format: "position",
    apiField: "position",
    type: "api",
  },
];

/**
 * Get a metric definition by key or apiField
 */
export function getMetricByKey(key: string): GSCMetricDefinition | undefined {
  return GSC_METRIC_CATALOG.find(
    (m) => m.key === key || m.apiField === key
  );
}
