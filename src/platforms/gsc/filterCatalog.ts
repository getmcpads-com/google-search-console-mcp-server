/**
 * google-search-console-mcp-server: an open-source MCP server for Google Search Console.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 */
// ============================================
// GSC FILTER CATALOG
// 5 filterable dimensions with 6 operators each
// ============================================

import type {
  GSCFilterDefinition,
  GSCFilterOperator,
  GSCSearchAnalyticsFilter,
  GSCDimensionKey,
} from "./types.js";

// ============================================
// AVAILABLE OPERATORS
// ============================================

export const GSC_FILTER_OPERATORS: GSCFilterOperator[] = [
  "contains",
  "equals",
  "notContains",
  "notEquals",
  "includingRegex",
  "excludingRegex",
];

// ============================================
// FILTER DEFINITIONS
// ============================================

export const GSC_FILTER_CATALOG: GSCFilterDefinition[] = [
  {
    key: "query",
    name: "Search Query",
    description: "Filter by search query/keyword",
    dimension: "query",
    operators: GSC_FILTER_OPERATORS,
  },
  {
    key: "page",
    name: "Page URL",
    description: "Filter by page URL",
    dimension: "page",
    operators: GSC_FILTER_OPERATORS,
  },
  {
    key: "country",
    name: "Country",
    description: "Filter by country (ISO 3166-1 alpha-3 code, e.g., USA, FRA, GBR)",
    dimension: "country",
    operators: ["equals", "notEquals"],
  },
  {
    key: "device",
    name: "Device",
    description: "Filter by device type: DESKTOP, MOBILE, TABLET",
    dimension: "device",
    operators: ["equals", "notEquals"],
  },
  {
    key: "searchAppearance",
    name: "Search Appearance",
    description: "Filter by search appearance type",
    dimension: "searchAppearance",
    operators: ["equals", "notEquals"],
  },
];

/**
 * Build a single GSC Search Analytics filter
 */
export function buildFilter(
  dimension: GSCDimensionKey,
  operator: GSCFilterOperator,
  expression: string
): GSCSearchAnalyticsFilter {
  return { dimension, operator, expression };
}

/**
 * Build filters from copilot params
 * Converts the copilot-style filter array to GSC dimensionFilterGroups format
 */
export function buildFiltersFromParams(
  filters: Array<{ field: string; operator: string; value: unknown }>
): GSCSearchAnalyticsFilter[] {
  return filters
    .filter((f) => f.field && f.operator && f.value != null)
    .map((f) => ({
      dimension: f.field as GSCDimensionKey,
      operator: f.operator as GSCFilterOperator,
      expression: String(f.value),
    }));
}
