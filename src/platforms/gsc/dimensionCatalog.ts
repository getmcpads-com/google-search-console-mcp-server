/**
 * google-search-console-mcp-server: an open-source MCP server for Google Search Console.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 */
// ============================================
// GSC DIMENSION CATALOG
// 7 dimensions supported by Search Analytics API
// ============================================

import type { GSCDimensionDefinition, GSCDimensionKey } from "./types.js";

export const GSC_DIMENSION_CATALOG: GSCDimensionDefinition[] = [
  {
    key: "query",
    name: "Search Query",
    description: "The search query (keyword) that triggered an impression. Not available for Discover and Google News search types.",
    category: "query",
    apiField: "query",
  },
  {
    key: "page",
    name: "Page URL",
    description: "The final URL of the page that appeared in search results",
    category: "page",
    apiField: "page",
  },
  {
    key: "country",
    name: "Country",
    description: "Country where the search originated. Uses ISO 3166-1 alpha-3 codes (e.g., USA, FRA, GBR, DEU, JPN)",
    category: "geography",
    apiField: "country",
  },
  {
    key: "device",
    name: "Device",
    description: "Device type used for the search: DESKTOP, MOBILE, or TABLET",
    category: "device",
    apiField: "device",
  },
  {
    key: "date",
    name: "Date",
    description: "Date of the search impression in YYYY-MM-DD format",
    category: "time",
    apiField: "date",
  },
  {
    key: "hour",
    name: "Hour",
    description: "Hour of the search impression. Use with dataState=hourly_all; recent hourly rows can be incomplete.",
    category: "time",
    apiField: "hour",
  },
  {
    key: "searchAppearance",
    name: "Search Appearance",
    description: "Special search result features: AMP_ARTICLE, INSTANT_APP, PRODUCT_LISTING, REVIEW_SNIPPET, SEARCH_ACTION, etc. One URL can have multiple appearances, inflating row count.",
    category: "appearance",
    apiField: "searchAppearance",
  },
];

/**
 * Get a dimension definition by key
 */
export function getDimensionByKey(key: string): GSCDimensionDefinition | undefined {
  return GSC_DIMENSION_CATALOG.find((d) => d.key === key);
}

/**
 * Validate dimension keys and return the valid ones
 */
export function validateDimensions(keys: string[]): { valid: GSCDimensionKey[]; invalid: string[] } {
  const valid: GSCDimensionKey[] = [];
  const invalid: string[] = [];

  for (const key of keys) {
    const dim = getDimensionByKey(key);
    if (dim) {
      valid.push(dim.key);
    } else {
      invalid.push(key);
    }
  }

  return { valid, invalid };
}
