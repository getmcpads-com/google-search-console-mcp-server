/**
 * google-search-console-mcp-server: an open-source MCP server for Google Search Console.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 */
// ============================================
// GSC COMPATIBILITY RULES
// Validation logic for GSC Search Analytics queries
// ============================================

import type { GSCDimensionKey, GSCSearchType } from "./types.js";

// ============================================
// CONSTANTS
// ============================================

/** Maximum dimensions per Search Analytics request */
export const MAX_DIMENSIONS = 5;

/** Maximum historical data (approximately 16 months) */
export const MAX_HISTORY_DAYS = 490;

/** Search types that do NOT support the 'query' dimension */
export const SEARCH_TYPES_WITHOUT_QUERY = new Set<GSCSearchType>([
  "discover",
  "googleNews",
]);

/** High-cardinality dimension combinations that may produce very large result sets */
export const HIGH_CARDINALITY_COMBINATIONS = new Set<string>([
  "query+page",
]);

// ============================================
// VALIDATION
// ============================================

export interface GSCValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate a GSC query selection for compatibility
 */
export function validateGSCQuerySelection(
  dimensions: GSCDimensionKey[],
  searchType?: GSCSearchType,
  dateRange?: { startDate: string; endDate: string }
): GSCValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Max 5 dimensions
  if (dimensions.length > MAX_DIMENSIONS) {
    errors.push(
      `GSC supports a maximum of ${MAX_DIMENSIONS} dimensions per request. You selected ${dimensions.length}.`
    );
  }

  // 2. 'query' dimension not available for discover/googleNews
  if (
    searchType &&
    SEARCH_TYPES_WITHOUT_QUERY.has(searchType) &&
    dimensions.includes("query")
  ) {
    errors.push(
      `The 'query' dimension is not available for '${searchType}' search type. Discover and Google News do not expose search queries.`
    );
  }

  // 3. searchAppearance may inflate results
  if (dimensions.includes("searchAppearance")) {
    warnings.push(
      "The 'searchAppearance' dimension can inflate results: a single page URL may appear multiple times with different search features (e.g., AMP, review snippet). Totals may exceed what you see without this dimension."
    );
  }

  // 4. High-cardinality warning for query + page
  if (dimensions.includes("query") && dimensions.includes("page")) {
    warnings.push(
      "Combining 'query' and 'page' dimensions produces high-cardinality results (each unique query-page pair is a row). Consider using a limit or filtering to keep results manageable."
    );
  }

  // 5. Date range validation (max ~16 months)
  if (dateRange) {
    const start = new Date(dateRange.startDate);
    const end = new Date(dateRange.endDate);
    const daysDiff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));

    if (daysDiff > MAX_HISTORY_DAYS) {
      errors.push(
        `GSC data is available for a maximum of ~16 months. Your date range spans ${daysDiff} days (max ${MAX_HISTORY_DAYS}).`
      );
    }

    if (start > end) {
      errors.push("Start date must be before end date.");
    }
  }

  // 6. No time dimension warning
  if (!dimensions.includes("date") && !dimensions.includes("hour")) {
    if (dimensions.length > 0) {
      // Only warn if there are other dimensions (aggregated totals are fine)
      warnings.push(
        "No 'date' dimension selected. Results will be aggregated over the entire date range."
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
