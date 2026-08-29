/**
 * google-search-console-mcp-server: an open-source MCP server for Google Search Console.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 */
// ============================================
// GOOGLE SEARCH CONSOLE API TYPES
// Complete TypeScript interfaces for GSC integration
// ============================================

// ============================================
// CORE ENUMS & TYPE ALIASES
// ============================================

export type GSCMetricCategory = "performance" | "calculated";

export type GSCDimensionCategory =
  | "query"
  | "page"
  | "geography"
  | "device"
  | "time"
  | "appearance";

export type GSCMetricFormat = "number" | "percent" | "position";

export type GSCFilterOperator =
  | "contains"
  | "equals"
  | "notContains"
  | "notEquals"
  | "includingRegex"
  | "excludingRegex";

export type GSCSearchType =
  | "web"
  | "image"
  | "video"
  | "news"
  | "discover"
  | "googleNews";

export type GSCDatePreset =
  | "today"
  | "yesterday"
  | "last7days"
  | "last28days"
  | "last3months"
  | "last6months"
  | "last12months"
  | "last16months";

export type GSCDimensionKey =
  | "query"
  | "page"
  | "country"
  | "device"
  | "date"
  | "hour"
  | "searchAppearance";

export type GSCAggregationType = "auto" | "byPage" | "byProperty" | "byNewsShowcasePanel";

// ============================================
// AUTHENTICATION TYPES
// ============================================

export interface GSCTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

export interface GSCRefreshTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

// ============================================
// SITE TYPES
// ============================================

export interface GSCSite {
  siteUrl: string; // e.g. "https://example.com/" or "sc-domain:example.com"
  permissionLevel: "siteOwner" | "siteFullUser" | "siteRestrictedUser" | "siteUnverifiedUser";
}

export interface GSCSiteEntry {
  siteUrl: string;
  permissionLevel: string;
}

// ============================================
// SEARCH ANALYTICS REQUEST TYPES
// ============================================

export interface GSCSearchAnalyticsFilter {
  dimension: GSCDimensionKey;
  operator: GSCFilterOperator;
  expression: string;
}

export interface GSCSearchAnalyticsRequest {
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  dimensions?: GSCDimensionKey[];
  type?: GSCSearchType;
  dimensionFilterGroups?: Array<{
    groupType: "and";
    filters: GSCSearchAnalyticsFilter[];
  }>;
  aggregationType?: GSCAggregationType;
  rowLimit?: number;   // max 25000
  startRow?: number;   // 0-based offset
  dataState?: "all" | "final" | "hourly_all";
}

export interface GSCDateRange {
  startDate: string; // YYYY-MM-DD
  endDate: string;
}

// ============================================
// SEARCH ANALYTICS RESPONSE TYPES
// ============================================

export interface GSCSearchAnalyticsRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;       // 0.0 - 1.0 from API
  position: number;  // 1-based average position
}

export interface GSCSearchAnalyticsResponse {
  rows?: GSCSearchAnalyticsRow[];
  responseAggregationType?: string;
  metadata?: {
    firstIncompleteDate?: string;
    firstIncompleteHour?: string;
  };
}

export interface GSCInsightRow {
  [key: string]: string | number | null;
}

// ============================================
// URL INSPECTION TYPES
// ============================================

export interface GSCInspectUrlRequest {
  inspectionUrl: string;
  siteUrl: string;
  languageCode?: string;
}

export interface GSCInspectUrlResponse {
  inspectionResult: {
    inspectionResultLink?: string;
    indexStatusResult?: {
      verdict: "PASS" | "PARTIAL" | "FAIL" | "NEUTRAL" | "VERDICT_UNSPECIFIED";
      coverageState?: string;
      robotsTxtState?: string;
      indexingState?: string;
      lastCrawlTime?: string;
      pageFetchState?: string;
      googleCanonical?: string;
      userCanonical?: string;
      referringUrls?: string[];
      crawledAs?: string;
    };
    mobileUsabilityResult?: {
      verdict: "PASS" | "PARTIAL" | "FAIL" | "NEUTRAL" | "VERDICT_UNSPECIFIED";
      issues?: Array<{
        issueType: string;
        severity: string;
        message: string;
      }>;
    };
    richResultsResult?: {
      verdict: "PASS" | "PARTIAL" | "FAIL" | "NEUTRAL" | "VERDICT_UNSPECIFIED";
      detectedItems?: Array<{
        richResultType: string;
        items?: Array<{
          name?: string;
          issues?: Array<{ issueMessage: string; severity: string }>;
        }>;
      }>;
    };
    ampResult?: {
      verdict: "PASS" | "PARTIAL" | "FAIL" | "NEUTRAL" | "VERDICT_UNSPECIFIED";
      ampUrl?: string;
      ampIndexStatusVerdict?: string;
      issues?: Array<{
        issueMessage: string;
        severity: string;
      }>;
    };
  };
}

// ============================================
// SITEMAP TYPES
// ============================================

export interface GSCSitemap {
  path: string;
  lastSubmitted?: string;
  isPending?: boolean;
  isSitemapsIndex?: boolean;
  type?: string;
  lastDownloaded?: string;
  warnings?: string;
  errors?: string;
  contents?: Array<{
    type: string;
    submitted?: string;
    indexed?: string;
  }>;
}

export interface GSCSitemapListResponse {
  sitemap?: GSCSitemap[];
}

// ============================================
// METRIC CATALOG TYPES
// ============================================

export interface GSCMetricDefinition {
  key: string;
  name: string;
  description: string;
  category: GSCMetricCategory;
  format: GSCMetricFormat;
  apiField: string;
  type: "api" | "calculated";
  formula?: string;
  dependencies?: string[];
}

// ============================================
// DIMENSION CATALOG TYPES
// ============================================

export interface GSCDimensionDefinition {
  key: GSCDimensionKey;
  name: string;
  description: string;
  category: GSCDimensionCategory;
  apiField: string;
}

// ============================================
// FILTER CATALOG TYPES
// ============================================

export interface GSCFilterDefinition {
  key: string;
  name: string;
  description: string;
  dimension: GSCDimensionKey;
  operators: GSCFilterOperator[];
}

// ============================================
// QUERY PLAN TYPES
// ============================================

export interface GSCQueryPlan {
  request: GSCSearchAnalyticsRequest;
  siteUrl: string;
  warnings: string[];
  errors: string[];
  calculatedMetrics: string[];
  requestedMetrics: string[];
}

// ============================================
// API ERROR TYPES
// ============================================

export class GSCApiException extends Error {
  code: number;
  status: string;

  constructor(message: string, code: number, status?: string) {
    super(message);
    this.name = "GSCApiException";
    this.code = code;
    this.status = status || "UNKNOWN";
  }

  get isAuthError(): boolean {
    return this.code === 401 || this.code === 403;
  }

  get isRateLimitError(): boolean {
    return this.code === 429;
  }

  get isQuotaError(): boolean {
    return this.code === 429 || this.status === "RESOURCE_EXHAUSTED";
  }

  get suggestion(): string {
    if (this.isAuthError) return "Re-authenticate with Google Search Console";
    if (this.isRateLimitError) return "Wait and retry. Rate limit exceeded";
    if (this.isQuotaError) return "Quota exceeded. Reduce query frequency";
    return "Check the error details for more information";
  }
}

// ============================================
// CONSTANTS
// ============================================

export const GSC_API_BASE = "https://searchconsole.googleapis.com";
export const GSC_WEBMASTERS_API_BASE = "https://www.googleapis.com/webmasters/v3";
export const GOOGLE_OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GSC_OAUTH_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Resolve a GSC date preset to start/end date strings (YYYY-MM-DD)
 * Presets are literal calendar windows. Use dataState=final for finalized rows,
 * or all/hourly_all when recent partial rows are required.
 */
export function resolveDatePreset(preset: GSCDatePreset): GSCDateRange {
  const now = new Date();
  const today = now.toISOString().split("T")[0];
  const daysAgo = (n: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() - n);
    return d.toISOString().split("T")[0];
  };

  switch (preset) {
    case "today": return { startDate: today, endDate: today };
    case "yesterday": return { startDate: daysAgo(1), endDate: daysAgo(1) };
    case "last7days": return { startDate: daysAgo(6), endDate: today };
    case "last28days": return { startDate: daysAgo(27), endDate: today };
    case "last3months": return { startDate: daysAgo(89), endDate: today };
    case "last6months": return { startDate: daysAgo(179), endDate: today };
    case "last12months": return { startDate: daysAgo(364), endDate: today };
    case "last16months": return { startDate: daysAgo(489), endDate: today };
    default: return { startDate: daysAgo(30), endDate: today };
  }
}

/**
 * Flatten a GSC Search Analytics response into GSCInsightRow[]
 * Maps dimension keys to column names and includes all 4 metrics
 */
export function flattenSearchAnalyticsResponse(
  response: GSCSearchAnalyticsResponse,
  dimensions?: GSCDimensionKey[]
): GSCInsightRow[] {
  if (!response.rows || response.rows.length === 0) {
    return [];
  }

  return response.rows.map((row) => {
    const flat: GSCInsightRow = {};

    // Map dimension keys
    if (dimensions && row.keys) {
      for (let i = 0; i < dimensions.length; i++) {
        flat[dimensions[i]] = row.keys[i] ?? null;
      }
    }

    // Always include all 4 metrics
    flat.clicks = row.clicks;
    flat.impressions = row.impressions;
    flat.ctr = Math.round(row.ctr * 10000) / 100; // Convert 0.0-1.0 to 0-100%
    flat.position = Math.round(row.position * 100) / 100;

    return flat;
  });
}
