/**
 * google-search-console-mcp-server: an open-source MCP server for Google Search Console.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 */
// ============================================
// GSC QUERY PLANNER
// Converts copilot parameters into GSCSearchAnalyticsRequest
// ============================================

import type {
  GSCQueryPlan,
  GSCSearchAnalyticsRequest,
  GSCDimensionKey,
  GSCSearchType,
  GSCDatePreset,
  GSCDateRange,
} from "./types.js";
import { resolveDatePreset } from "./types.js";
import { validateDimensions } from "./dimensionCatalog.js";
import { buildFiltersFromParams } from "./filterCatalog.js";
import { isCalculatedMetric } from "./calculatedMetrics.js";
import { validateGSCQuerySelection } from "./compatibilityRules.js";

// ============================================
// MAIN QUERY PLANNER
// ============================================

export function planGSCQuery(params: {
  siteUrl: string;
  metrics?: string[];
  dimensions?: string[];
  filters?: Array<{ field: string; operator: string; value: unknown }>;
  searchType?: string;
  dateRange?: { startDate: string; endDate: string };
  datePreset?: string;
  orderBy?: string;
  limit?: number;
  aggregationType?: string;
  dataState?: "all" | "final" | "hourly_all";
}): GSCQueryPlan {
  const warnings: string[] = [];
  const errors: string[] = [];

  // 1. Separate calculated vs native metrics
  // GSC always returns all 4 metrics, so we just need to track which calculated ones to compute
  const requestedMetrics = params.metrics || ["clicks", "impressions", "ctr", "position"];
  const calculatedMetrics = requestedMetrics.filter(isCalculatedMetric);

  // 2. Validate and resolve dimensions
  let resolvedDimensions: GSCDimensionKey[] = [];
  if (params.dimensions && params.dimensions.length > 0) {
    const { valid, invalid } = validateDimensions(params.dimensions);
    resolvedDimensions = valid;
    if (invalid.length > 0) {
      warnings.push(`Unknown dimensions ignored: ${invalid.join(", ")}. Valid: query, page, country, device, date, hour, searchAppearance.`);
    }
  }

  // 3. Validate search type
  const searchType = params.searchType as GSCSearchType | undefined;
  const validSearchTypes = ["web", "image", "video", "news", "discover", "googleNews"];
  if (searchType && !validSearchTypes.includes(searchType)) {
    warnings.push(`Unknown search type '${searchType}'. Valid: ${validSearchTypes.join(", ")}. Defaulting to 'web'.`);
  }

  // 4. Validate compatibility
  const validation = validateGSCQuerySelection(
    resolvedDimensions,
    searchType,
    params.dateRange
  );
  errors.push(...validation.errors);
  warnings.push(...validation.warnings);

  // 5. Resolve date range
  let dateRange: GSCDateRange;
  if (params.dateRange) {
    dateRange = params.dateRange;
  } else if (params.datePreset) {
    dateRange = resolveDatePreset(params.datePreset as GSCDatePreset);
  } else {
    dateRange = resolveDatePreset("last28days");
  }

  // 6. Build filters
  const gscFilters = params.filters
    ? buildFiltersFromParams(params.filters)
    : [];

  // 7. Assemble request
  const request: GSCSearchAnalyticsRequest = {
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    ...(resolvedDimensions.length > 0 && { dimensions: resolvedDimensions }),
    ...(searchType && { type: searchType }),
    ...(gscFilters.length > 0 && {
      dimensionFilterGroups: [
        {
          groupType: "and" as const,
          filters: gscFilters,
        },
      ],
    }),
    ...(params.limit && { rowLimit: params.limit }),
    ...(params.aggregationType && { aggregationType: params.aggregationType as GSCSearchAnalyticsRequest["aggregationType"] }),
    dataState: params.dataState ?? "all", // Include fresh (non-final) data by default
  };

  const requestFilters = request.dimensionFilterGroups?.flatMap((group) => group.filters) ?? [];
  const filtersPage = requestFilters.some((filter) => filter.dimension === "page");
  if (request.aggregationType === "byProperty" && (request.dimensions?.includes("page") || filtersPage)) {
    errors.push("aggregationType=byProperty cannot be used when grouping or filtering by page; use auto or byPage.");
  }
  if (request.aggregationType === "byProperty" && (request.type === "discover" || request.type === "googleNews")) {
    errors.push("aggregationType=byProperty is not supported for Discover or Google News.");
  }
  if (request.aggregationType === "byNewsShowcasePanel") {
    const searchAppearanceFilters = requestFilters.filter((filter) => filter.dimension === "searchAppearance");
    const isNewsShowcaseFilter = (filter: (typeof requestFilters)[number]) =>
      filter.operator === "equals" && filter.expression === "NEWS_SHOWCASE";

    if (request.type !== "discover" && request.type !== "googleNews") {
      errors.push("aggregationType=byNewsShowcasePanel requires searchType=discover or googleNews.");
    }
    if (request.dimensions?.includes("page") || filtersPage) {
      errors.push("aggregationType=byNewsShowcasePanel cannot be used when grouping or filtering by page.");
    }
    if (!searchAppearanceFilters.some(isNewsShowcaseFilter)) {
      errors.push("aggregationType=byNewsShowcasePanel requires a searchAppearance equals NEWS_SHOWCASE filter.");
    }
    if (searchAppearanceFilters.some((filter) => !isNewsShowcaseFilter(filter))) {
      errors.push("aggregationType=byNewsShowcasePanel cannot filter to a searchAppearance other than NEWS_SHOWCASE.");
    }
  }

  if (request.dataState === "hourly_all" && !request.dimensions?.includes("hour")) {
    warnings.push("dataState=hourly_all is most useful with the hour dimension; add hour to receive hourly breakdown and incomplete-hour metadata.");
  }
  if (request.dimensions?.includes("hour") && request.dataState !== "hourly_all") {
    errors.push("The hour dimension requires dataState=hourly_all.");
  }
  if (request.dataState === "hourly_all") {
    const start = new Date(`${dateRange.startDate}T00:00:00Z`);
    const end = new Date(`${dateRange.endDate}T00:00:00Z`);
    const inclusiveDays = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
    if (Number.isFinite(inclusiveDays) && inclusiveDays > 10) {
      errors.push(`Hourly Search Analytics is available for at most 10 days; this range spans ${inclusiveDays} days.`);
    }
  }

  return {
    request,
    siteUrl: params.siteUrl,
    warnings,
    errors,
    calculatedMetrics,
    requestedMetrics,
  };
}
