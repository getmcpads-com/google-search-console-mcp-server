/**
 * google-search-console-mcp-server: an open-source MCP server for Google Search Console.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 */
// ============================================
// GSC CALCULATED METRICS
// Derived metrics computed client-side from the 4 native GSC metrics
// ============================================

import type { GSCMetricDefinition, GSCInsightRow } from "./types.js";

// ============================================
// CALCULATED METRIC DEFINITIONS
// ============================================

export const GSC_CALCULATED_METRIC_DEFINITIONS: GSCMetricDefinition[] = [
  {
    key: "ctrOpportunity",
    name: "CTR Opportunity",
    description: "Potential CTR improvement: pages with high impressions but low CTR (positions 1-10). Score = impressions * (expectedCTR - actualCTR). Higher score = bigger opportunity.",
    category: "calculated",
    format: "number",
    apiField: "",
    type: "calculated",
    formula: "impressions * (expectedCTR(position) - ctr)",
    dependencies: ["impressions", "ctr", "position"],
  },
  {
    key: "clicksPerImpression",
    name: "Clicks per 1K Impressions",
    description: "Number of clicks per 1,000 impressions. Alternative view of CTR.",
    category: "calculated",
    format: "number",
    apiField: "",
    type: "calculated",
    formula: "(clicks / impressions) * 1000",
    dependencies: ["clicks", "impressions"],
  },
  {
    key: "impressionShare",
    name: "Impression Share %",
    description: "This row's share of total impressions (percentage). Useful for distribution analysis.",
    category: "calculated",
    format: "percent",
    apiField: "",
    type: "calculated",
    formula: "(rowImpressions / totalImpressions) * 100",
    dependencies: ["impressions"],
  },
  {
    key: "clickShare",
    name: "Click Share %",
    description: "This row's share of total clicks (percentage). Useful for distribution analysis.",
    category: "calculated",
    format: "percent",
    apiField: "",
    type: "calculated",
    formula: "(rowClicks / totalClicks) * 100",
    dependencies: ["clicks"],
  },
];

// ============================================
// EXPECTED CTR BY POSITION
// Average CTR benchmarks by position (approximate)
// ============================================

function expectedCTRByPosition(position: number): number {
  if (position <= 1) return 30;
  if (position <= 2) return 15;
  if (position <= 3) return 10;
  if (position <= 4) return 7;
  if (position <= 5) return 5;
  if (position <= 6) return 4;
  if (position <= 7) return 3;
  if (position <= 8) return 2.5;
  if (position <= 9) return 2;
  if (position <= 10) return 1.5;
  return 0.5; // Below first page
}

// ============================================
// INDIVIDUAL CALCULATORS
// ============================================

function calcCtrOpportunity(row: GSCInsightRow): number | null {
  const impressions = row.impressions;
  const ctr = row.ctr;
  const position = row.position;
  if (typeof impressions !== "number" || typeof ctr !== "number" || typeof position !== "number") return null;
  if (position > 20) return 0; // Only relevant for top 20 positions

  const expected = expectedCTRByPosition(position);
  const gap = expected - ctr; // ctr is already in 0-100% from flattenResponse
  if (gap <= 0) return 0; // Already at or above expected CTR

  return Math.round(impressions * gap / 100);
}

function calcClicksPerImpression(row: GSCInsightRow): number | null {
  const clicks = row.clicks;
  const impressions = row.impressions;
  if (typeof clicks !== "number" || typeof impressions !== "number" || impressions === 0) return null;
  return (clicks / impressions) * 1000;
}

// ============================================
// MAIN CALCULATION FUNCTION
// ============================================

/**
 * Calculate all derived metrics for a single row
 */
export function calculateMetrics(row: GSCInsightRow): Record<string, number | null> {
  return {
    ctrOpportunity: calcCtrOpportunity(row),
    clicksPerImpression: calcClicksPerImpression(row),
    // impressionShare and clickShare need totals, computed in enrichWithCalculatedMetrics
  };
}

/**
 * Enrich rows with calculated metrics
 * Handles both per-row calculations and total-dependent calculations
 */
export function enrichWithCalculatedMetrics(
  rows: GSCInsightRow[],
  requestedCalculated?: string[]
): GSCInsightRow[] {
  if (rows.length === 0) return rows;

  // Compute totals for share calculations
  let totalImpressions = 0;
  let totalClicks = 0;
  for (const row of rows) {
    if (typeof row.impressions === "number") totalImpressions += row.impressions;
    if (typeof row.clicks === "number") totalClicks += row.clicks;
  }

  return rows.map((row) => {
    const calculated = calculateMetrics(row);

    // Add share metrics that depend on totals
    if (typeof row.impressions === "number" && totalImpressions > 0) {
      calculated.impressionShare = (row.impressions as number / totalImpressions) * 100;
    }
    if (typeof row.clicks === "number" && totalClicks > 0) {
      calculated.clickShare = (row.clicks as number / totalClicks) * 100;
    }

    // Filter to requested metrics if specified
    const enriched = { ...row };
    for (const [key, value] of Object.entries(calculated)) {
      if (value === null) continue;
      if (requestedCalculated && !requestedCalculated.includes(key)) continue;
      enriched[key] = Math.round(value * 100) / 100;
    }

    return enriched;
  });
}

/**
 * Check if a metric key is a calculated metric
 */
export function isCalculatedMetric(key: string): boolean {
  return GSC_CALCULATED_METRIC_DEFINITIONS.some((m) => m.key === key);
}

/**
 * Get all API metric dependencies for a set of calculated metric keys
 */
export function getCalculatedMetricDependencies(metricKeys: string[]): string[] {
  const deps = new Set<string>();
  for (const key of metricKeys) {
    const def = GSC_CALCULATED_METRIC_DEFINITIONS.find((m) => m.key === key);
    if (def?.dependencies) {
      for (const dep of def.dependencies) {
        deps.add(dep);
      }
    }
  }
  return Array.from(deps);
}
