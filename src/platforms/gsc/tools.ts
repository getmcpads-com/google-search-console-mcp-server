/**
 * google-search-console-mcp-server: an open-source MCP server for Google Search Console.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GSCConfig } from "../../config.js";
import { formatMcpToolError } from "../../core/errors.js";
import { RateLimiter } from "../../core/rate-limiter.js";
import { GSCClient, refreshAccessToken } from "./gscClient.js";
import { planGSCQuery } from "./queryPlanner.js";
import { enrichWithCalculatedMetrics } from "./calculatedMetrics.js";
import { validateGSCQuerySelection } from "./compatibilityRules.js";
import type { GSCDatePreset, GSCDimensionKey, GSCInspectUrlResponse, GSCSearchAnalyticsRow, GSCSearchType, GSCSitemap } from "./types.js";
import { flattenSearchAnalyticsResponse, GSC_OAUTH_SCOPE, resolveDatePreset } from "./types.js";

type SearchType = "web" | "image" | "video" | "news" | "discover" | "googleNews";
type ComparisonDimension = "query" | "page";
type SamplingObjective = "topTraffic" | "lowCtr" | "declining" | "sitemapRisk" | "staleSitemaps";
type MetricBucket = {
  clicks: number;
  impressions: number;
  weightedPosition: number;
  queryCount: number;
  topQueries: Array<{ query: string; clicks: number; impressions: number; ctr: number; position: number }>;
};
type SitemapSummary = {
  path: string;
  status: "healthy" | "pending" | "warning" | "error";
  lastSubmitted?: string;
  lastDownloaded?: string;
  isPending: boolean;
  isSitemapsIndex: boolean;
  type?: string;
  warnings: number;
  errors: number;
  contents: Array<{ type: string; submitted: number; indexed: number; indexRate: number | null }>;
  totals: { submitted: number; indexed: number; indexRate: number | null };
};
type MetricSummary = { clicks: number; impressions: number; ctr: number; position: number | null };
type PageSamplingRow = {
  page: string;
  current: MetricSummary;
  previous: MetricSummary;
  delta: { clicks: number; impressions: number; ctr: number; position: number | null };
};
type SamplingBucket = {
  objective: SamplingObjective;
  rationale: string;
  candidateUrls: string[];
  sitemapPaths: string[];
};

const siteUrlSchema = z.string().optional().describe("Search Console property URL, e.g. https://example.com/ or sc-domain:example.com. Uses GSC_SITE_URL when omitted.");
const datePresetSchema = z.enum(["today", "yesterday", "last7days", "last28days", "last3months", "last6months", "last12months", "last16months"]);
const searchTypeSchema = z.enum(["web", "image", "video", "news", "discover", "googleNews"]);
const dataStateSchema = z.enum(["final", "all", "hourly_all"]);
const aggregationTypeSchema = z.enum(["auto", "byPage", "byProperty", "byNewsShowcasePanel"]);
const limitSchema = z.number().int().min(1).max(25000).optional().default(1000);
const dateRangeSchema = z.object({
  startDate: z.string().describe("Start date YYYY-MM-DD"),
  endDate: z.string().describe("End date YYYY-MM-DD"),
});
const comparisonDimensionSchema = z.enum(["query", "page"]);
const sitemapBaselineSchema = z.object({
  path: z.string().describe("Sitemap URL/path returned by GSC."),
  submitted: z.number().int().min(0).optional().default(0),
  indexed: z.number().int().min(0).optional().default(0),
  warnings: z.number().int().min(0).optional().default(0),
  errors: z.number().int().min(0).optional().default(0),
  lastSubmitted: z.string().optional(),
  lastDownloaded: z.string().optional(),
});
const watchlistUrlSchema = z.object({
  url: z.string().url(),
  label: z.string().optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional().default("medium"),
  tags: z.array(z.string()).optional().default([]),
  expectedVerdict: z.enum(["PASS", "PARTIAL", "FAIL", "NEUTRAL", "VERDICT_UNSPECIFIED"]).optional().default("PASS"),
  expectedCanonical: z.string().url().optional(),
  expectedCoverageState: z.string().optional(),
});
const samplingObjectiveSchema = z.enum(["topTraffic", "lowCtr", "declining", "sitemapRisk", "staleSitemaps"]);
type SitemapSnapshot = z.infer<typeof sitemapBaselineSchema>;
type WatchlistUrl = z.infer<typeof watchlistUrlSchema>;
const BULK_URL_INSPECTION_LIMIT = 10;
const URL_INSPECTION_DAILY_QUOTA = 2000;
const DEFAULT_FRESHNESS_LAG_WARNING_DAYS = 3;
const STOP_WORDS = new Set([
  "a", "about", "after", "and", "are", "as", "at", "avec", "be", "by", "comment", "dans", "de", "des", "du",
  "en", "est", "et", "for", "from", "how", "in", "is", "la", "le", "les", "of", "on", "ou", "pour", "que",
  "qui", "the", "to", "un", "une", "what", "when", "where", "why", "with",
]);
const QUESTION_TOKENS = new Set([
  "comment", "combien", "est-ce", "how", "ou", "pourquoi", "quand", "que", "quel", "quelle", "quelles", "quels",
  "qui", "quoi", "what", "when", "where", "which", "who", "why",
]);
const COMMERCIAL_TOKENS = new Set([
  "avis", "best", "buy", "comparatif", "compare", "coupon", "discount", "meilleur", "price", "prix", "review",
  "tarif", "vs",
]);
const NAVIGATIONAL_TOKENS = new Set(["account", "app", "connexion", "dashboard", "login", "sign", "signin"]);
const GSC_RESPONSE_API_VERSION = "searchconsole_v1/webmasters_v3";

type AgentResponseRecord = Record<string, unknown>;

function isAgentResponseRecord(value: unknown): value is AgentResponseRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwnField(value: AgentResponseRecord, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function getDebugRecord(payload: AgentResponseRecord): AgentResponseRecord {
  return isAgentResponseRecord(payload["debug"]) ? payload["debug"] : {};
}

function getRequestCount(payload: AgentResponseRecord): number {
  const debug = getDebugRecord(payload);
  const requestCount = debug["requestCount"];
  return typeof requestCount === "number" ? requestCount : 1;
}

function getWarnings(payload: AgentResponseRecord): unknown[] {
  if (Array.isArray(payload["warnings"])) return payload["warnings"];

  const debug = getDebugRecord(payload);
  return Array.isArray(debug["warnings"]) ? debug["warnings"] : [];
}

function withAgentResponseContract(data: unknown): unknown {
  if (!isAgentResponseRecord(data)) return data;

  return {
    ...data,
    warnings: hasOwnField(data, "warnings") ? data["warnings"] : getWarnings(data),
    limitations: hasOwnField(data, "limitations") ? data["limitations"] : [],
    nextActions: hasOwnField(data, "nextActions") ? data["nextActions"] : [],
    debug: {
      ...getDebugRecord(data),
      source: "google_search_console",
      apiVersion: GSC_RESPONSE_API_VERSION,
      requestCount: getRequestCount(data),
    },
  };
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(withAgentResponseContract(data), null, 2) }] };
}

class AuthenticatedGSCClient {
  private accessToken: string | undefined;
  private tokenExpiresAt = 0;
  private rateLimiter = new RateLimiter();

  constructor(private readonly config: GSCConfig) {
    this.accessToken = config.accessToken;
    if (config.accessToken) {
      this.tokenExpiresAt = Date.now() + 45 * 60 * 1000;
    }
  }

  private async ensureAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }

    if (!this.config.refreshToken || !this.config.clientId || !this.config.clientSecret) {
      throw new Error("No valid GSC access token and refresh credentials are incomplete.");
    }

    const tokens = await this.rateLimiter.execute(() =>
      refreshAccessToken(this.config.refreshToken!, this.config.clientId!, this.config.clientSecret!),
    );

    this.accessToken = tokens.access_token;
    this.tokenExpiresAt = Date.now() + ((tokens.expires_in ?? 3600) - 60) * 1000;
    return this.accessToken;
  }

  async get(): Promise<GSCClient> {
    return new GSCClient(await this.ensureAccessToken());
  }
}

function resolveSiteUrl(inputSiteUrl: string | undefined, config: GSCConfig): string {
  const siteUrl = inputSiteUrl || config.defaultSiteUrl;
  if (!siteUrl) {
    throw new Error("Missing siteUrl. Pass siteUrl, or set GSC_SITE_URL in Claude Desktop config.");
  }
  return siteUrl;
}

function roundMetric(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function parseCount(value: string | number | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function addUtcDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function parseDateStrict(value: string, label: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must use YYYY-MM-DD format.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || formatDate(parsed) !== value) {
    throw new Error(`${label} is not a valid date.`);
  }
  return parsed;
}

function validateDateRange(dateRange: { startDate: string; endDate: string }): void {
  const start = parseDateStrict(dateRange.startDate, "startDate");
  const end = parseDateStrict(dateRange.endDate, "endDate");
  if (start > end) {
    throw new Error("startDate must be before or equal to endDate.");
  }
}

function inclusiveDayCount(dateRange: { startDate: string; endDate: string }): number {
  const start = parseDateStrict(dateRange.startDate, "startDate");
  const end = parseDateStrict(dateRange.endDate, "endDate");
  return Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
}

function derivePreviousDateRange(dateRange: { startDate: string; endDate: string }): { startDate: string; endDate: string } {
  const start = parseDateStrict(dateRange.startDate, "startDate");
  const days = inclusiveDayCount(dateRange);
  const previousEnd = addUtcDays(start, -1);
  const previousStart = addUtcDays(previousEnd, -(days - 1));
  return { startDate: formatDate(previousStart), endDate: formatDate(previousEnd) };
}

function daysBetween(fromDate: string, toDate: Date): number {
  const from = parseDateStrict(fromDate, "date");
  return Math.floor((toDate.getTime() - from.getTime()) / 86_400_000);
}

function safeDaysBetweenDatePrefix(fromDate: string | undefined, toDate: Date): number | null {
  if (!fromDate) return null;
  try {
    return daysBetween(fromDate.slice(0, 10), toDate);
  } catch {
    return null;
  }
}

function rowMetrics(row: GSCSearchAnalyticsRow | undefined) {
  if (!row) {
    return { clicks: 0, impressions: 0, ctr: 0, position: null as number | null };
  }
  return {
    clicks: roundMetric(row.clicks, 0),
    impressions: roundMetric(row.impressions, 0),
    ctr: roundMetric(row.ctr * 100),
    position: roundMetric(row.position),
  };
}

function summarizeRows(rows: GSCSearchAnalyticsRow[]) {
  const clicks = rows.reduce((sum, row) => sum + row.clicks, 0);
  const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
  const weightedPosition = rows.reduce((sum, row) => sum + row.position * row.impressions, 0);

  return {
    clicks: roundMetric(clicks, 0),
    impressions: roundMetric(impressions, 0),
    ctr: impressions > 0 ? roundMetric((clicks / impressions) * 100) : 0,
    position: impressions > 0 ? roundMetric(weightedPosition / impressions) : 0,
  };
}

function percentageChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return roundMetric(((current - previous) / previous) * 100);
}

function keyRowsByDimension(rows: GSCSearchAnalyticsRow[]): Map<string, GSCSearchAnalyticsRow> {
  const keyed = new Map<string, GSCSearchAnalyticsRow>();
  for (const row of rows) {
    const key = row.keys?.[0];
    if (key) keyed.set(key, row);
  }
  return keyed;
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function tokenizeQuery(query: string): string[] {
  return uniqueValues(
    normalizeText(query)
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .map((token) => token.replace(/^-+|-+$/g, ""))
      .filter((token) => token.length > 1 && !STOP_WORDS.has(token)),
  );
}

function deriveBrandTerms(siteUrl: string): string[] {
  let host = siteUrl;
  if (siteUrl.startsWith("sc-domain:")) {
    host = siteUrl.replace("sc-domain:", "");
  } else {
    try {
      host = new URL(siteUrl).hostname;
    } catch {
      host = siteUrl;
    }
  }

  const ignored = new Set(["www", "com", "fr", "io", "ai", "net", "org", "co", "uk"]);
  return uniqueValues(
    normalizeText(host)
      .split(/[.-]/)
      .filter((part) => part.length > 2 && !ignored.has(part)),
  );
}

function expandBrandTerms(terms: string[]): string[] {
  const expanded = new Set<string>();
  for (const term of terms.map(normalizeText).filter((value) => value.length > 1)) {
    expanded.add(term);
    const compacted = term.replace(/[\s-]+/g, "");
    expanded.add(compacted);

    const words = term.replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean);
    if (words.length > 1 && words[0].endsWith("s")) {
      expanded.add([words[0].slice(0, -1), ...words.slice(1)].join(" "));
    }

    if (compacted === "galerieslafayette" || compacted === "galerielafayette") {
      expanded.add("galeries lafayette");
      expanded.add("galerie lafayette");
      expanded.add("gallery lafayette");
      expanded.add("gallerie lafayette");
      expanded.add("lafayette");
    }
  }
  return uniqueValues([...expanded]);
}

function classifyQuery(query: string, tokens: string[], brandTerms: string[]) {
  const normalized = normalizeText(query);
  const compacted = normalized.replace(/[\s-]+/g, "");
  const normalizedWords = normalized
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const isBrand = brandTerms.some((term) => {
    const normalizedTerm = normalizeText(term);
    const compactedTerm = normalizedTerm.replace(/[\s-]+/g, "");
    return normalizedTerm.length > 1 && (normalized.includes(normalizedTerm) || compacted.includes(compactedTerm));
  });
  const isQuestion = normalizedWords.some((token) => QUESTION_TOKENS.has(token)) || normalized.endsWith("?");
  const hasCommercialIntent = tokens.some((token) => COMMERCIAL_TOKENS.has(token));
  const hasNavigationalIntent = tokens.some((token) => NAVIGATIONAL_TOKENS.has(token));

  return {
    brand: isBrand ? "brand" : "nonBrand",
    question: isQuestion ? "question" : "nonQuestion",
    intent: isQuestion ? "question" : hasCommercialIntent ? "commercial" : hasNavigationalIntent ? "navigational" : "informational",
  };
}

function resolveQueryCategory(query: string, tokens: string[], categoryRules: Record<string, string[]> | undefined): string {
  const normalized = normalizeText(query);
  for (const [category, terms] of Object.entries(categoryRules ?? {})) {
    const normalizedTerms = terms.map(normalizeText).filter(Boolean);
    if (normalizedTerms.some((term) => tokens.includes(term) || normalized.includes(term))) {
      return category;
    }
  }

  return tokens[0] ? `topic:${tokens[0]}` : "uncategorized";
}

function createMetricBucket(): MetricBucket {
  return { clicks: 0, impressions: 0, weightedPosition: 0, queryCount: 0, topQueries: [] };
}

function addQueryToBucket(bucket: MetricBucket, query: string, row: GSCSearchAnalyticsRow): void {
  bucket.clicks += row.clicks;
  bucket.impressions += row.impressions;
  bucket.weightedPosition += row.position * row.impressions;
  bucket.queryCount += 1;
  bucket.topQueries.push({
    query,
    clicks: roundMetric(row.clicks, 0),
    impressions: roundMetric(row.impressions, 0),
    ctr: roundMetric(row.ctr * 100),
    position: roundMetric(row.position),
  });
}

function getOrCreateBucket(map: Map<string, MetricBucket>, key: string): MetricBucket {
  const existing = map.get(key);
  if (existing) return existing;
  const created = createMetricBucket();
  map.set(key, created);
  return created;
}

function finalizeBucket(label: string, bucket: MetricBucket, topQueryLimit = 10) {
  return {
    cluster: label,
    queryCount: bucket.queryCount,
    clicks: roundMetric(bucket.clicks, 0),
    impressions: roundMetric(bucket.impressions, 0),
    ctr: bucket.impressions > 0 ? roundMetric((bucket.clicks / bucket.impressions) * 100) : 0,
    position: bucket.impressions > 0 ? roundMetric(bucket.weightedPosition / bucket.impressions) : 0,
    topQueries: bucket.topQueries
      .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
      .slice(0, topQueryLimit),
  };
}

function finalizeBuckets(map: Map<string, MetricBucket>, topQueryLimit = 10) {
  return [...map.entries()]
    .map(([label, bucket]) => finalizeBucket(label, bucket, topQueryLimit))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
}

function normalizeInspectionResult(url: string, response: GSCInspectUrlResponse) {
  const inspection = response.inspectionResult;
  const indexStatus = inspection.indexStatusResult;
  const mobileIssues = inspection.mobileUsabilityResult?.issues ?? [];
  const richIssues = (inspection.richResultsResult?.detectedItems ?? []).flatMap((detectedItem) =>
    (detectedItem.items ?? []).flatMap((item) =>
      (item.issues ?? []).map((issue) => ({
        richResultType: detectedItem.richResultType,
        itemName: item.name,
        message: issue.issueMessage,
        severity: issue.severity,
      })),
    ),
  );
  const ampIssues = inspection.ampResult?.issues ?? [];

  return {
    url,
    inspectionResultLink: inspection.inspectionResultLink,
    indexStatus: {
      verdict: indexStatus?.verdict,
      coverageState: indexStatus?.coverageState,
      indexingState: indexStatus?.indexingState,
      pageFetchState: indexStatus?.pageFetchState,
      robotsTxtState: indexStatus?.robotsTxtState,
      lastCrawlTime: indexStatus?.lastCrawlTime,
      crawledAs: indexStatus?.crawledAs,
      googleCanonical: indexStatus?.googleCanonical,
      userCanonical: indexStatus?.userCanonical,
    },
    mobileUsability: {
      verdict: inspection.mobileUsabilityResult?.verdict,
      issueCount: mobileIssues.length,
      issues: mobileIssues,
    },
    richResults: {
      verdict: inspection.richResultsResult?.verdict,
      itemCount: inspection.richResultsResult?.detectedItems?.length ?? 0,
      issueCount: richIssues.length,
      issues: richIssues,
    },
    amp: {
      verdict: inspection.ampResult?.verdict,
      ampUrl: inspection.ampResult?.ampUrl,
      ampIndexStatusVerdict: inspection.ampResult?.ampIndexStatusVerdict,
      issueCount: ampIssues.length,
      issues: ampIssues,
    },
  };
}

function normalizePerUrlError(error: unknown) {
  const apiError = error as { code?: number; status?: string; message?: string; suggestion?: string; isQuotaError?: boolean; isRateLimitError?: boolean };
  return {
    error: apiError.message ?? (error instanceof Error ? error.message : String(error)),
    code: apiError.code,
    status: apiError.status,
    isRateLimit: Boolean(apiError.isRateLimitError || apiError.isQuotaError),
    suggestion: apiError.suggestion,
  };
}

type NormalizedInspectionResult = ReturnType<typeof normalizeInspectionResult>;

function summarizeSitemapForP2(sitemap: GSCSitemap): SitemapSummary {
  const warningCount = parseCount(sitemap.warnings);
  const errorCount = parseCount(sitemap.errors);
  const contents = (sitemap.contents || []).map((content) => {
    const submitted = parseCount(content.submitted);
    const indexed = parseCount(content.indexed);
    return {
      type: content.type,
      submitted,
      indexed,
      indexRate: submitted > 0 ? roundMetric((indexed / submitted) * 100) : null,
    };
  });
  const submitted = contents.reduce((sum, content) => sum + content.submitted, 0);
  const indexed = contents.reduce((sum, content) => sum + content.indexed, 0);
  const status = sitemap.isPending
    ? "pending"
    : errorCount > 0 ? "error" : warningCount > 0 ? "warning" : "healthy";

  return {
    path: sitemap.path,
    status,
    lastSubmitted: sitemap.lastSubmitted,
    lastDownloaded: sitemap.lastDownloaded,
    isPending: Boolean(sitemap.isPending),
    isSitemapsIndex: Boolean(sitemap.isSitemapsIndex),
    type: sitemap.type,
    warnings: warningCount,
    errors: errorCount,
    contents,
    totals: {
      submitted,
      indexed,
      indexRate: submitted > 0 ? roundMetric((indexed / submitted) * 100) : null,
    },
  };
}

function summarizeSitemapCollection(sitemaps: SitemapSummary[]) {
  const submitted = sitemaps.reduce((sum, sitemap) => sum + sitemap.totals.submitted, 0);
  const indexed = sitemaps.reduce((sum, sitemap) => sum + sitemap.totals.indexed, 0);
  const statusCounts = {
    healthy: sitemaps.filter((sitemap) => sitemap.status === "healthy").length,
    pending: sitemaps.filter((sitemap) => sitemap.status === "pending").length,
    warning: sitemaps.filter((sitemap) => sitemap.status === "warning").length,
    error: sitemaps.filter((sitemap) => sitemap.status === "error").length,
  };

  return {
    count: sitemaps.length,
    statusCounts,
    warnings: sitemaps.reduce((sum, sitemap) => sum + sitemap.warnings, 0),
    errors: sitemaps.reduce((sum, sitemap) => sum + sitemap.errors, 0),
    sitemapIndexes: sitemaps.filter((sitemap) => sitemap.isSitemapsIndex).length,
    submitted,
    indexed,
    indexRate: submitted > 0 ? roundMetric((indexed / submitted) * 100) : null,
    newestLastSubmitted: latestStringDate(sitemaps.map((sitemap) => sitemap.lastSubmitted)),
    newestLastDownloaded: latestStringDate(sitemaps.map((sitemap) => sitemap.lastDownloaded)),
  };
}

function latestStringDate(values: Array<string | undefined>): string | null {
  const sorted = values
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => a.localeCompare(b));
  return sorted[sorted.length - 1] ?? null;
}

function sitemapSnapshot(summary: SitemapSummary): SitemapSnapshot {
  return {
    path: summary.path,
    submitted: summary.totals.submitted,
    indexed: summary.totals.indexed,
    warnings: summary.warnings,
    errors: summary.errors,
    lastSubmitted: summary.lastSubmitted,
    lastDownloaded: summary.lastDownloaded,
  };
}

function analyzeDailyFreshness(rows: GSCSearchAnalyticsRow[], endDate: Date, lagWarningDays: number) {
  const sortedRows = rows
    .filter((row) => row.keys?.[0])
    .sort((a, b) => String(a.keys?.[0]).localeCompare(String(b.keys?.[0])));
  const rowsWithData = sortedRows.filter((row) => row.clicks > 0 || row.impressions > 0);
  const latestRow = rowsWithData[rowsWithData.length - 1];
  const latestDataDate = latestRow?.keys?.[0] ?? null;
  const dataLagDays = latestDataDate ? daysBetween(latestDataDate, endDate) : null;
  const status = latestDataDate === null
    ? "noData"
    : dataLagDays !== null && dataLagDays <= lagWarningDays ? "fresh"
      : dataLagDays !== null && dataLagDays <= lagWarningDays + 2 ? "delayed" : "stale";

  return {
    latestDataDate,
    dataLagDays,
    status,
    hasRecentData: dataLagDays !== null && dataLagDays <= lagWarningDays,
    rowCount: sortedRows.length,
    dailyRows: sortedRows.map((row) => ({
      date: row.keys?.[0],
      ...rowMetrics(row),
    })),
  };
}

function assessInspectionResult(result: NormalizedInspectionResult, watch?: WatchlistUrl) {
  const issues: string[] = [];
  const verdict = result.indexStatus.verdict;
  const coverageState = result.indexStatus.coverageState;
  const pageFetchState = result.indexStatus.pageFetchState;
  const robotsTxtState = result.indexStatus.robotsTxtState;
  const expectedVerdict = watch?.expectedVerdict ?? "PASS";

  if (!verdict) {
    issues.push("URL Inspection did not return an index status verdict.");
  } else if (verdict !== expectedVerdict) {
    issues.push(`Expected index verdict ${expectedVerdict}, got ${verdict}.`);
  }
  if (watch?.expectedCoverageState && coverageState !== watch.expectedCoverageState) {
    issues.push(`Expected coverage state '${watch.expectedCoverageState}', got '${coverageState ?? "unknown"}'.`);
  }
  if (pageFetchState && !/successful/i.test(pageFetchState)) {
    issues.push(`Page fetch state is '${pageFetchState}'.`);
  }
  if (robotsTxtState && /disallow|blocked/i.test(robotsTxtState)) {
    issues.push(`robots.txt state is '${robotsTxtState}'.`);
  }
  if (
    watch?.expectedCanonical &&
    result.indexStatus.googleCanonical &&
    result.indexStatus.googleCanonical !== watch.expectedCanonical
  ) {
    issues.push(`Google canonical differs from expected canonical '${watch.expectedCanonical}'.`);
  }
  if (result.mobileUsability.verdict && !["PASS", "NEUTRAL"].includes(result.mobileUsability.verdict)) {
    issues.push(`Mobile usability verdict is ${result.mobileUsability.verdict}.`);
  }
  if (result.richResults.issueCount > 0) {
    issues.push(`${result.richResults.issueCount} rich result issue(s) detected.`);
  }

  const priority = watch?.priority ?? "medium";
  const status = issues.length === 0
    ? "ok"
    : priority === "critical" || priority === "high" ? "alert" : "review";

  return {
    status,
    indexed: verdict === "PASS",
    priority,
    issues,
  };
}

function rowCompositeKey(row: GSCSearchAnalyticsRow, dimensionCount: number): string {
  return JSON.stringify((row.keys ?? []).slice(0, dimensionCount));
}

function dedupeUrlList(urls: string[], limit: number): string[] {
  return uniqueValues(urls).slice(0, limit);
}

export function registerGSCTools(server: McpServer, config: GSCConfig): void {
  const clientFactory = new AuthenticatedGSCClient(config);

  server.tool(
    "gsc_list_sites",
    "List all Google Search Console properties accessible with the current credentials.",
    {},
    async () => {
      try {
        const client = await clientFactory.get();
        const sites = await client.listSites();
        return ok({ sites, count: sites.length });
      } catch (e) { return formatMcpToolError(e); }
    },
  );

  server.tool(
    "gsc_get_site",
    "Get one Search Console property and its exact permission level (read-only sites.get).",
    { siteUrl: siteUrlSchema },
    async ({ siteUrl }) => {
      try {
        const resolvedSiteUrl = resolveSiteUrl(siteUrl, config);
        const client = await clientFactory.get();
        const site = await client.getSite(resolvedSiteUrl);
        return ok({ site });
      } catch (e) { return formatMcpToolError(e); }
    },
  );

  server.tool(
    "gsc_health_check",
    "Verify Google Search Console read-only authentication, visible properties, configured default site, and permission levels without exposing tokens.",
    { siteUrl: siteUrlSchema },
    async ({ siteUrl }) => {
      try {
        const warnings: string[] = [];
        const targetSiteUrl = siteUrl || config.defaultSiteUrl;
        const hasRefreshCredentials = Boolean(config.refreshToken && config.clientId && config.clientSecret);
        const client = await clientFactory.get();
        const sites = await client.listSites();
        const visibleSites = sites.map((site) => ({
          siteUrl: site.siteUrl,
          permissionLevel: site.permissionLevel,
          status: site.permissionLevel === "siteUnverifiedUser" ? "unverified" : "verified",
          canRead: site.permissionLevel !== "siteUnverifiedUser",
        }));
        const targetSite = targetSiteUrl
          ? visibleSites.find((site) => site.siteUrl === targetSiteUrl)
          : undefined;

        if (sites.length === 0) {
          warnings.push("No Search Console properties are visible to these credentials.");
        }
        if (!targetSiteUrl) {
          warnings.push("No default site is configured. Set GSC_SITE_URL or pass siteUrl to property-specific tools.");
        }
        if (targetSiteUrl && !targetSite) {
          warnings.push(`Configured/requested site '${targetSiteUrl}' is not visible in listSites(). Check exact URL/property format and permissions.`);
        }
        if (targetSite?.permissionLevel === "siteUnverifiedUser") {
          warnings.push(`Site '${targetSite.siteUrl}' is visible but unverified for this account.`);
        }
        if (targetSite?.permissionLevel === "siteRestrictedUser") {
          warnings.push(`Site '${targetSite.siteUrl}' has restricted permissions; some GSC reports may be unavailable.`);
        }
        if (!hasRefreshCredentials && config.accessToken) {
          warnings.push("Using a static access token without refresh credentials; re-authentication may be required when it expires.");
        }

        return ok({
          ok: true,
          authentication: {
            status: "authenticated",
            credentialMode: config.accessToken
              ? hasRefreshCredentials ? "access_token_with_refresh_fallback" : "access_token"
              : "refresh_token",
            requiredScope: GSC_OAUTH_SCOPE,
          },
          defaultSite: {
            configured: Boolean(config.defaultSiteUrl),
            requestedSiteUrl: targetSiteUrl,
            found: Boolean(targetSite),
            permissionLevel: targetSite?.permissionLevel,
            status: targetSite?.status,
          },
          sites: {
            count: visibleSites.length,
            entries: visibleSites,
          },
          warnings,
        });
      } catch (e) { return formatMcpToolError(e); }
    },
  );

  server.tool(
    "gsc_query_search_analytics",
    `Query Google Search Console Search Analytics. Returns clicks, impressions, CTR, and average position for queries, pages, countries, devices, dates, and search appearances.
Use gsc://metrics, gsc://dimensions, gsc://filters, and gsc://compatibility for available fields and rules.`,
    {
      siteUrl: siteUrlSchema,
      metrics: z.array(z.string()).optional().describe("Native: clicks, impressions, ctr, position. Calculated: ctrOpportunity, clicksPerImpression, impressionShare, clickShare."),
      dimensions: z.array(z.string()).max(5).optional().describe("Up to 5 dimensions selected from query, page, country, device, date, hour, searchAppearance."),
      filters: z.array(z.object({
        field: z.string(),
        operator: z.enum(["contains", "equals", "notContains", "notEquals", "includingRegex", "excludingRegex"]),
        value: z.union([z.string(), z.number(), z.boolean()]),
      })).optional(),
      searchType: searchTypeSchema.optional().default("web"),
      dataState: dataStateSchema.optional().default("all").describe("final=stable data, all=fresh daily data, hourly_all=fresh hourly data (use hour dimension)."),
      aggregationType: aggregationTypeSchema.optional().default("auto").describe("Official GSC aggregation. byProperty is incompatible with page grouping/filtering and Discover/Google News. byNewsShowcasePanel requires discover/googleNews plus searchAppearance equals NEWS_SHOWCASE, and forbids page grouping/filtering or another searchAppearance filter."),
      datePreset: datePresetSchema.optional().default("last28days"),
      dateRange: z.object({
        startDate: z.string().describe("Start date YYYY-MM-DD"),
        endDate: z.string().describe("End date YYYY-MM-DD"),
      }).optional(),
      orderBy: z.enum(["clicks", "impressions", "ctr", "position", "ctrOpportunity", "clicksPerImpression", "impressionShare", "clickShare"]).optional().default("clicks"),
      orderDirection: z.enum(["ASC", "DESC"]).optional().default("DESC"),
      limit: limitSchema,
      startRow: z.number().int().min(0).optional().describe("Optional 0-based row offset for explicit pagination."),
      autoPaginate: z.boolean().optional().default(false).describe("When true, omit rowLimit so the GSC client auto-paginates until exhaustion."),
    },
    async ({ siteUrl, metrics, dimensions, filters, searchType, dataState, aggregationType, datePreset, dateRange, orderBy, orderDirection, limit, startRow, autoPaginate }) => {
      try {
        const startTime = Date.now();
        const resolvedSiteUrl = resolveSiteUrl(siteUrl, config);
        const plan = planGSCQuery({
          siteUrl: resolvedSiteUrl,
          metrics,
          dimensions,
          filters,
          searchType,
          datePreset,
          dateRange,
          orderBy,
          limit: autoPaginate ? undefined : limit,
          aggregationType,
          dataState,
        });
        if (typeof startRow === "number") plan.request.startRow = startRow;

        if (plan.errors.length > 0) {
          return ok({ error: "Query validation failed", errors: plan.errors, warnings: plan.warnings });
        }

        const client = await clientFactory.get();
        const response = await client.querySearchAnalytics(plan.siteUrl, plan.request);
        const flatData = flattenSearchAnalyticsResponse(response, plan.request.dimensions);
        const enrichedData = plan.calculatedMetrics.length > 0
          ? enrichWithCalculatedMetrics(flatData, plan.calculatedMetrics)
          : flatData;
        // Preserve native API precision, especially CTR ratios and average position.
        const data = enrichedData;

        if (orderBy && data.length > 0) {
          data.sort((a, b) => {
            const aVal = Number(a[orderBy]) || 0;
            const bVal = Number(b[orderBy]) || 0;
            const asc = orderDirection === "ASC" || orderBy === "position";
            return asc ? aVal - bVal : bVal - aVal;
          });
        }

        return ok({
          data,
          rowCount: data.length,
          responseAggregationType: response.responseAggregationType,
          metadata: response.metadata,
          debug: {
            executionTimeMs: Date.now() - startTime,
            warnings: plan.warnings,
            calculatedMetrics: plan.calculatedMetrics,
            requestedMetrics: plan.requestedMetrics,
            pagination: {
              mode: autoPaginate ? "auto_startRow" : "single_page",
              autoPaginate,
              startRow: startRow ?? 0,
              limit: autoPaginate ? null : limit,
            },
            dataState,
            aggregationType,
          },
        });
      } catch (e) { return formatMcpToolError(e); }
    },
  );

  server.tool(
    "gsc_inspect_url",
    "Inspect a URL for Google indexing status, crawl info, mobile usability, AMP, and rich results. Quota: 2000 requests/day/property.",
    {
      siteUrl: siteUrlSchema,
      url: z.string().url().describe("Full URL to inspect."),
      languageCode: z.string().optional().describe("Optional IETF language tag, e.g. en-US or fr-FR."),
    },
    async ({ siteUrl, url, languageCode }) => {
      try {
        const client = await clientFactory.get();
        const result = await client.inspectUrl(url, resolveSiteUrl(siteUrl, config), languageCode);
        const inspection = result.inspectionResult;
        return ok({
          url,
          inspectionResultLink: inspection.inspectionResultLink,
          indexStatus: inspection.indexStatusResult,
          mobileUsability: inspection.mobileUsabilityResult,
          richResults: inspection.richResultsResult,
          amp: inspection.ampResult,
        });
      } catch (e) { return formatMcpToolError(e); }
    },
  );

  server.tool(
    "gsc_bulk_inspect_urls",
    "Inspect multiple URLs with a conservative sequential limit and normalized URL Inspection results. Quota: 2000 requests/day/property.",
    {
      siteUrl: siteUrlSchema,
      urls: z.array(z.string().url()).min(1).max(BULK_URL_INSPECTION_LIMIT).describe(`Full URLs to inspect. Maximum ${BULK_URL_INSPECTION_LIMIT} per call to protect URL Inspection quota.`),
      languageCode: z.string().optional().describe("Optional IETF language tag, e.g. en-US or fr-FR."),
      continueOnError: z.boolean().optional().default(true).describe("When true, returns per-URL errors instead of failing the entire batch."),
    },
    async ({ siteUrl, urls, languageCode, continueOnError }) => {
      try {
        const resolvedSiteUrl = resolveSiteUrl(siteUrl, config);
        const client = await clientFactory.get();
        const uniqueUrls = uniqueValues(urls);
        const warnings = [
          `URL Inspection API quota is limited to ${URL_INSPECTION_DAILY_QUOTA} requests/day/property; this tool caps each call at ${BULK_URL_INSPECTION_LIMIT} URLs and runs sequentially.`,
        ];

        if (uniqueUrls.length < urls.length) {
          warnings.push(`${urls.length - uniqueUrls.length} duplicate URL(s) were skipped before inspection.`);
        }

        const results = [];
        for (const url of uniqueUrls) {
          try {
            const response = await client.inspectUrl(url, resolvedSiteUrl, languageCode);
            results.push({ ok: true, ...normalizeInspectionResult(url, response) });
          } catch (error) {
            if (!continueOnError) throw error;
            results.push({ ok: false, url, ...normalizePerUrlError(error) });
          }
        }

        return ok({
          siteUrl: resolvedSiteUrl,
          inspectedCount: results.length,
          failedCount: results.filter((result) => !result.ok).length,
          warnings,
          results,
        });
      } catch (e) { return formatMcpToolError(e); }
    },
  );

  server.tool(
    "gsc_list_sitemaps",
    "List sitemaps submitted for a Search Console property, including processing status and submitted/indexed counts.",
    {
      siteUrl: siteUrlSchema,
      sitemapIndex: z.string().url().optional().describe("Optional sitemap index URL used to return only its child sitemaps."),
    },
    async ({ siteUrl, sitemapIndex }) => {
      try {
        const client = await clientFactory.get();
        const result = await client.listSitemaps(resolveSiteUrl(siteUrl, config), sitemapIndex);
        const sitemaps = (result.sitemap || []).map((s) => ({
          path: s.path,
          lastSubmitted: s.lastSubmitted,
          isPending: s.isPending,
          isSitemapsIndex: s.isSitemapsIndex,
          type: s.type,
          lastDownloaded: s.lastDownloaded,
          warnings: s.warnings,
          errors: s.errors,
          contents: s.contents,
        }));
        return ok({ sitemaps, count: sitemaps.length });
      } catch (e) { return formatMcpToolError(e); }
    },
  );

  server.tool(
    "gsc_get_sitemap",
    "Get one submitted sitemap by full feed path, including type, fetch state, warnings/errors, and submitted/indexed content totals.",
    {
      siteUrl: siteUrlSchema,
      feedpath: z.string().url().describe("Full sitemap URL exactly as submitted to Search Console."),
    },
    async ({ siteUrl, feedpath }) => {
      try {
        const resolvedSiteUrl = resolveSiteUrl(siteUrl, config);
        const client = await clientFactory.get();
        const sitemap = await client.getSitemap(resolvedSiteUrl, feedpath);
        return ok({ siteUrl: resolvedSiteUrl, sitemap });
      } catch (e) { return formatMcpToolError(e); }
    },
  );

  server.tool(
    "gsc_get_sitemap_health",
    "Return an enriched read-only sitemap health summary with status totals, submitted/indexed content counts, warnings, and errors.",
    { siteUrl: siteUrlSchema },
    async ({ siteUrl }) => {
      try {
        const resolvedSiteUrl = resolveSiteUrl(siteUrl, config);
        const client = await clientFactory.get();
        const result = await client.listSitemaps(resolvedSiteUrl);
        const sitemaps = (result.sitemap || []).map((sitemap) => {
          const warningCount = parseCount(sitemap.warnings);
          const errorCount = parseCount(sitemap.errors);
          const submitted = (sitemap.contents || []).reduce((sum, content) => sum + parseCount(content.submitted), 0);
          const indexed = (sitemap.contents || []).reduce((sum, content) => sum + parseCount(content.indexed), 0);
          const status = sitemap.isPending
            ? "pending"
            : errorCount > 0 ? "error" : warningCount > 0 ? "warning" : "healthy";

          return {
            path: sitemap.path,
            status,
            lastSubmitted: sitemap.lastSubmitted,
            lastDownloaded: sitemap.lastDownloaded,
            isPending: Boolean(sitemap.isPending),
            isSitemapsIndex: Boolean(sitemap.isSitemapsIndex),
            type: sitemap.type,
            warnings: warningCount,
            errors: errorCount,
            contents: sitemap.contents || [],
            totals: {
              submitted,
              indexed,
              indexRate: submitted > 0 ? roundMetric((indexed / submitted) * 100) : null,
            },
          };
        });

        const totals = {
          sitemaps: sitemaps.length,
          healthy: sitemaps.filter((sitemap) => sitemap.status === "healthy").length,
          pending: sitemaps.filter((sitemap) => sitemap.status === "pending").length,
          warnings: sitemaps.reduce((sum, sitemap) => sum + sitemap.warnings, 0),
          errors: sitemaps.reduce((sum, sitemap) => sum + sitemap.errors, 0),
          sitemapIndexes: sitemaps.filter((sitemap) => sitemap.isSitemapsIndex).length,
          submitted: sitemaps.reduce((sum, sitemap) => sum + sitemap.totals.submitted, 0),
          indexed: sitemaps.reduce((sum, sitemap) => sum + sitemap.totals.indexed, 0),
        };

        const overallStatus = totals.errors > 0
          ? "error"
          : totals.pending > 0 ? "pending" : totals.warnings > 0 ? "warning" : "healthy";

        return ok({
          siteUrl: resolvedSiteUrl,
          overallStatus,
          totals: {
            ...totals,
            indexRate: totals.submitted > 0 ? roundMetric((totals.indexed / totals.submitted) * 100) : null,
          },
          sitemaps,
          warnings: sitemaps.length === 0 ? ["No submitted sitemaps returned for this property."] : [],
        });
      } catch (e) { return formatMcpToolError(e); }
    },
  );

  server.tool(
    "gsc_compare_search_types",
    "Compare performance across Search Console search types: web, image, video, news, discover, and Google News.",
    {
      siteUrl: siteUrlSchema,
      searchTypes: z.array(searchTypeSchema).optional().default(["web", "image", "video", "discover"]),
      datePreset: datePresetSchema.optional().default("last28days"),
      dateRange: z.object({ startDate: z.string(), endDate: z.string() }).optional(),
    },
    async ({ siteUrl, searchTypes, datePreset, dateRange }) => {
      try {
        const resolvedSiteUrl = resolveSiteUrl(siteUrl, config);
        const resolvedDateRange = dateRange || resolveDatePreset(datePreset as GSCDatePreset);
        const client = await clientFactory.get();
        const data = await Promise.all(
          (searchTypes as SearchType[]).map(async (type) => {
            try {
              const response = await client.querySearchAnalytics(resolvedSiteUrl, {
                startDate: resolvedDateRange.startDate,
                endDate: resolvedDateRange.endDate,
                type: type as GSCSearchType,
                dataState: "all",
              });
              const rows = response.rows || [];
              const clicks = rows.reduce((sum, row) => sum + row.clicks, 0);
              const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
              const weightedPosition = rows.reduce((sum, row) => sum + row.position * row.impressions, 0);
              return {
                searchType: type,
                clicks,
                impressions,
                ctr: impressions > 0 ? Math.round((clicks / impressions) * 10000) / 100 : 0,
                position: impressions > 0 ? Math.round((weightedPosition / impressions) * 100) / 100 : 0,
              };
            } catch (error) {
              return {
                searchType: type,
                clicks: 0,
                impressions: 0,
                ctr: 0,
                position: 0,
                error: error instanceof Error ? error.message : "No data available",
              };
            }
          }),
        );
        return ok({ data, rowCount: data.length });
      } catch (e) { return formatMcpToolError(e); }
    },
  );

  server.tool(
    "gsc_get_data_freshness",
    "Detect the most recent date with Search Analytics data by querying recent daily rows.",
    {
      siteUrl: siteUrlSchema,
      searchType: searchTypeSchema.optional().default("web"),
      lookbackDays: z.number().int().min(3).max(30).optional().default(14).describe("Recent days to scan for daily data. Max 30."),
    },
    async ({ siteUrl, searchType, lookbackDays }) => {
      try {
        const resolvedSiteUrl = resolveSiteUrl(siteUrl, config);
        const end = todayUtc();
        const dateRange = {
          startDate: formatDate(addUtcDays(end, -(lookbackDays - 1))),
          endDate: formatDate(end),
        };
        const validation = validateGSCQuerySelection(["date"], searchType as GSCSearchType, dateRange);
        if (validation.errors.length > 0) {
          return ok({ error: "Query validation failed", errors: validation.errors, warnings: validation.warnings });
        }

        const client = await clientFactory.get();
        const response = await client.querySearchAnalytics(resolvedSiteUrl, {
          startDate: dateRange.startDate,
          endDate: dateRange.endDate,
          dimensions: ["date"],
          type: searchType as GSCSearchType,
          dataState: "all",
          rowLimit: lookbackDays,
        });
        const rows = (response.rows || [])
          .filter((row) => row.keys?.[0])
          .sort((a, b) => String(a.keys?.[0]).localeCompare(String(b.keys?.[0])));
        const rowsWithData = rows.filter((row) => row.clicks > 0 || row.impressions > 0);
        const latestRow = rowsWithData[rowsWithData.length - 1];
        const latestDataDate = latestRow?.keys?.[0] ?? null;
        const dataLagDays = latestDataDate ? daysBetween(latestDataDate, end) : null;
        const warnings = [...validation.warnings];

        if (!latestDataDate) {
          warnings.push(`No daily rows with clicks or impressions were found in the last ${lookbackDays} days.`);
        } else if (dataLagDays !== null && dataLagDays > 3) {
          warnings.push(`Latest visible data is ${dataLagDays} days old; GSC normally lags by about 2-3 days.`);
        }

        return ok({
          siteUrl: resolvedSiteUrl,
          searchType,
          checkedRange: dateRange,
          latestDataDate,
          dataLagDays,
          hasRecentData: dataLagDays !== null && dataLagDays <= 3,
          rowCount: rows.length,
          dailyRows: rows.map((row) => ({
            date: row.keys?.[0],
            ...rowMetrics(row),
          })),
          warnings,
        });
      } catch (e) { return formatMcpToolError(e); }
    },
  );

  server.tool(
    "gsc_monitor_indexation_freshness",
    "Read-only monitoring snapshot for Search Analytics freshness, sitemap indexation totals, and an optional small URL Inspection sample.",
    {
      siteUrl: siteUrlSchema,
      searchTypes: z.array(searchTypeSchema).min(1).max(6).optional().default(["web"]),
      lookbackDays: z.number().int().min(3).max(30).optional().default(14).describe("Recent days to scan for Search Analytics freshness."),
      freshnessLagWarningDays: z.number().int().min(1).max(14).optional().default(DEFAULT_FRESHNESS_LAG_WARNING_DAYS).describe("Maximum acceptable lag in days before freshness is marked delayed/stale."),
      inspectUrls: z.array(z.string().url()).max(BULK_URL_INSPECTION_LIMIT).optional().default([]).describe(`Optional URLs to inspect. Maximum ${BULK_URL_INSPECTION_LIMIT} to protect URL Inspection quota.`),
      languageCode: z.string().optional().describe("Optional IETF language tag for URL Inspection, e.g. en-US or fr-FR."),
    },
    async ({ siteUrl, searchTypes, lookbackDays, freshnessLagWarningDays, inspectUrls, languageCode }) => {
      try {
        const resolvedSiteUrl = resolveSiteUrl(siteUrl, config);
        const client = await clientFactory.get();
        const end = todayUtc();
        const checkedRange = {
          startDate: formatDate(addUtcDays(end, -(lookbackDays - 1))),
          endDate: formatDate(end),
        };
        const uniqueSearchTypes = uniqueValues(searchTypes) as SearchType[];
        const sitemapPromise = client.listSitemaps(resolvedSiteUrl);
        const freshnessPromise = Promise.all(uniqueSearchTypes.map(async (type) => {
          const validation = validateGSCQuerySelection(["date"], type as GSCSearchType, checkedRange);
          if (validation.errors.length > 0) {
            return {
              searchType: type,
              checkedRange,
              status: "error",
              errors: validation.errors,
              warnings: validation.warnings,
            };
          }

          try {
            const response = await client.querySearchAnalytics(resolvedSiteUrl, {
              startDate: checkedRange.startDate,
              endDate: checkedRange.endDate,
              dimensions: ["date"],
              type: type as GSCSearchType,
              dataState: "all",
              rowLimit: lookbackDays,
            });
            const analysis = analyzeDailyFreshness(response.rows || [], end, freshnessLagWarningDays);
            const warnings = [...validation.warnings];
            if (analysis.status === "noData") {
              warnings.push(`No ${type} daily rows with clicks or impressions were found in the last ${lookbackDays} days.`);
            } else if (analysis.status === "stale" || analysis.status === "delayed") {
              warnings.push(`Latest ${type} data is ${analysis.dataLagDays} days old; threshold is ${freshnessLagWarningDays} day(s).`);
            }
            return {
              searchType: type,
              checkedRange,
              ...analysis,
              warnings,
            };
          } catch (error) {
            return {
              searchType: type,
              checkedRange,
              status: "error",
              error: normalizePerUrlError(error),
            };
          }
        }));

        const [sitemapResult, freshness] = await Promise.all([sitemapPromise, freshnessPromise]);
        const sitemapSummaries = (sitemapResult.sitemap || []).map(summarizeSitemapForP2);
        const sitemapTotals = summarizeSitemapCollection(sitemapSummaries);
        const urlsToInspect = dedupeUrlList(inspectUrls, BULK_URL_INSPECTION_LIMIT);
        const inspections: Array<Record<string, unknown>> = [];
        let inspectionAlertCount = 0;

        for (const url of urlsToInspect) {
          try {
            const response = await client.inspectUrl(url, resolvedSiteUrl, languageCode);
            const normalized = normalizeInspectionResult(url, response);
            const assessment = assessInspectionResult(normalized);
            if (assessment.status === "alert") inspectionAlertCount += 1;
            inspections.push({ ok: true, ...normalized, assessment });
          } catch (error) {
            inspectionAlertCount += 1;
            inspections.push({ ok: false, url, ...normalizePerUrlError(error) });
          }
        }

        const freshnessAlertCount = freshness.filter((item) => ["noData", "stale", "error"].includes(String(item.status))).length;
        const sitemapAlertCount = sitemapTotals.statusCounts.error + sitemapTotals.statusCounts.pending;
        const overallStatus = freshnessAlertCount > 0 || sitemapAlertCount > 0 || inspectionAlertCount > 0
          ? "attention"
          : sitemapTotals.statusCounts.warning > 0 ? "warning" : "ok";

        return ok({
          siteUrl: resolvedSiteUrl,
          overallStatus,
          generatedAt: new Date().toISOString(),
          freshness,
          sitemapIndexation: {
            totals: sitemapTotals,
            atRiskSitemaps: sitemapSummaries
              .filter((sitemap) => sitemap.status !== "healthy")
              .sort((a, b) => b.errors - a.errors || b.warnings - a.warnings)
              .slice(0, 25),
          },
          optionalUrlInspectionSample: {
            requestedCount: inspectUrls.length,
            inspectedCount: inspections.length,
            skippedDuplicates: inspectUrls.length - urlsToInspect.length,
            dailyQuotaNote: `${URL_INSPECTION_DAILY_QUOTA} requests/day/property; this monitor caps optional samples at ${BULK_URL_INSPECTION_LIMIT} URLs.`,
            results: inspections,
          },
        });
      } catch (e) { return formatMcpToolError(e); }
    },
  );

  server.tool(
    "gsc_track_sitemap_deltas",
    "Read-only sitemap delta tracker. Fetches the current sitemap snapshot and compares it to an agent-provided baseline; no state is written.",
    {
      siteUrl: siteUrlSchema,
      baseline: z.array(sitemapBaselineSchema).optional().default([]).describe("Previous snapshot entries from this tool's snapshot output."),
      includeUnchanged: z.boolean().optional().default(false),
      minAbsIndexedDelta: z.number().int().min(0).optional().default(1).describe("Minimum absolute indexed URL delta to include otherwise unchanged sitemaps."),
    },
    async ({ siteUrl, baseline, includeUnchanged, minAbsIndexedDelta }) => {
      try {
        const resolvedSiteUrl = resolveSiteUrl(siteUrl, config);
        const client = await clientFactory.get();
        const result = await client.listSitemaps(resolvedSiteUrl);
        const current = (result.sitemap || []).map(summarizeSitemapForP2);
        const currentSnapshot = current.map(sitemapSnapshot);
        const baselineMap = new Map((baseline as SitemapSnapshot[]).map((entry) => [entry.path, entry]));
        const currentPaths = new Set(current.map((sitemap) => sitemap.path));
        const changes = [];

        for (const sitemap of current) {
          const previous = baselineMap.get(sitemap.path);
          if (!previous) {
            changes.push({
              path: sitemap.path,
              changeType: "new",
              current: sitemapSnapshot(sitemap),
              previous: null,
              delta: {
                submitted: sitemap.totals.submitted,
                indexed: sitemap.totals.indexed,
                warnings: sitemap.warnings,
                errors: sitemap.errors,
              },
            });
            continue;
          }

          const currentEntry = sitemapSnapshot(sitemap);
          const delta = {
            submitted: currentEntry.submitted - previous.submitted,
            indexed: currentEntry.indexed - previous.indexed,
            warnings: currentEntry.warnings - previous.warnings,
            errors: currentEntry.errors - previous.errors,
          };
          const dateChanged = currentEntry.lastSubmitted !== previous.lastSubmitted
            || currentEntry.lastDownloaded !== previous.lastDownloaded;
          const changed = dateChanged
            || Math.abs(delta.indexed) >= minAbsIndexedDelta
            || delta.submitted !== 0
            || delta.warnings !== 0
            || delta.errors !== 0;

          if (includeUnchanged || changed) {
            changes.push({
              path: sitemap.path,
              changeType: changed ? "changed" : "unchanged",
              current: currentEntry,
              previous,
              delta,
              dateChanged,
            });
          }
        }

        for (const previous of baseline as SitemapSnapshot[]) {
          if (currentPaths.has(previous.path)) continue;
          changes.push({
            path: previous.path,
            changeType: "missing",
            current: null,
            previous,
            delta: {
              submitted: -previous.submitted,
              indexed: -previous.indexed,
              warnings: -previous.warnings,
              errors: -previous.errors,
            },
          });
        }

        const totals = summarizeSitemapCollection(current);
        return ok({
          siteUrl: resolvedSiteUrl,
          generatedAt: new Date().toISOString(),
          baselineCount: baseline.length,
          currentCount: current.length,
          totals,
          changeSummary: {
            new: changes.filter((change) => change.changeType === "new").length,
            changed: changes.filter((change) => change.changeType === "changed").length,
            missing: changes.filter((change) => change.changeType === "missing").length,
            unchangedIncluded: changes.filter((change) => change.changeType === "unchanged").length,
          },
          changes,
          snapshot: currentSnapshot,
          usage: "Persist snapshot in the calling agent/workflow if you want the next read-only delta comparison.",
        });
      } catch (e) { return formatMcpToolError(e); }
    },
  );

  server.tool(
    "gsc_analyze_search_appearance_trends",
    "Analyze structured data and rich-result trend signals via the Search Analytics searchAppearance dimension when GSC exposes it.",
    {
      siteUrl: siteUrlSchema,
      searchType: searchTypeSchema.optional().default("web"),
      datePreset: datePresetSchema.optional().default("last28days"),
      currentDateRange: dateRangeSchema.optional().describe("Current period. Defaults to datePreset."),
      previousDateRange: dateRangeSchema.optional().describe("Previous period. Defaults to the immediately preceding period with the same length."),
      includePages: z.boolean().optional().default(false).describe("When true, groups by searchAppearance + page for page-level rich result trends."),
      limit: z.number().int().min(1).max(25000).optional().default(5000),
      topN: z.number().int().min(1).max(100).optional().default(50),
      minImpressions: z.number().int().min(0).optional().default(0),
      sortBy: z.enum(["currentClicks", "currentImpressions", "clicksDelta", "impressionsDelta", "positionDelta"]).optional().default("impressionsDelta"),
    },
    async ({ siteUrl, searchType, datePreset, currentDateRange, previousDateRange, includePages, limit, topN, minImpressions, sortBy }) => {
      try {
        const resolvedSiteUrl = resolveSiteUrl(siteUrl, config);
        const currentRange = currentDateRange || resolveDatePreset(datePreset as GSCDatePreset);
        const previousRange = previousDateRange || derivePreviousDateRange(currentRange);
        validateDateRange(currentRange);
        validateDateRange(previousRange);

        const dimensions = (includePages ? ["searchAppearance", "page"] : ["searchAppearance"]) as GSCDimensionKey[];
        const validation = validateGSCQuerySelection(dimensions, searchType as GSCSearchType, currentRange);
        if (validation.errors.length > 0) {
          return ok({ error: "Query validation failed", errors: validation.errors, warnings: validation.warnings });
        }

        const client = await clientFactory.get();
        const buildRequest = (dateRange: { startDate: string; endDate: string }) => ({
          startDate: dateRange.startDate,
          endDate: dateRange.endDate,
          dimensions,
          type: searchType as GSCSearchType,
          dataState: "all" as const,
          rowLimit: limit,
        });
        const [currentResponse, previousResponse] = await Promise.all([
          client.querySearchAnalytics(resolvedSiteUrl, buildRequest(currentRange)),
          client.querySearchAnalytics(resolvedSiteUrl, buildRequest(previousRange)),
        ]);
        const currentRows = currentResponse.rows || [];
        const previousRows = previousResponse.rows || [];
        const currentByKey = new Map(currentRows.map((row) => [rowCompositeKey(row, dimensions.length), row]));
        const previousByKey = new Map(previousRows.map((row) => [rowCompositeKey(row, dimensions.length), row]));
        const allKeys = uniqueValues([...currentByKey.keys(), ...previousByKey.keys()]);
        const warnings = [...validation.warnings];

        if (currentRows.length === 0 && previousRows.length === 0) {
          warnings.push("No searchAppearance rows were returned. This property/search type/date range may not expose structured data or rich-result appearance data.");
        }
        if (currentRows.length === limit || previousRows.length === limit) {
          warnings.push("At least one period reached the row limit; lower-volume search appearance rows may be omitted.");
        }

        const trends = allKeys.map((key) => {
          const keys = JSON.parse(key) as string[];
          const current = rowMetrics(currentByKey.get(key));
          const previous = rowMetrics(previousByKey.get(key));
          const clicksDelta = current.clicks - previous.clicks;
          const impressionsDelta = current.impressions - previous.impressions;
          const ctrDelta = roundMetric(current.ctr - previous.ctr);
          const positionDelta = current.position !== null && previous.position !== null
            ? roundMetric(current.position - previous.position)
            : null;

          return {
            searchAppearance: keys[0] ?? "unknown",
            page: includePages ? keys[1] ?? null : undefined,
            current,
            previous,
            delta: {
              clicks: clicksDelta,
              impressions: impressionsDelta,
              ctr: ctrDelta,
              position: positionDelta,
              positionDirection: positionDelta === null ? "unknown" : positionDelta < 0 ? "improved" : positionDelta > 0 ? "declined" : "unchanged",
            },
            changePercent: {
              clicks: percentageChange(current.clicks, previous.clicks),
              impressions: percentageChange(current.impressions, previous.impressions),
            },
          };
        }).filter((row) => row.current.impressions >= minImpressions || row.previous.impressions >= minImpressions);

        const sortTrendRows = (rows: typeof trends) => rows.sort((a, b) => {
          switch (sortBy) {
            case "currentClicks": return b.current.clicks - a.current.clicks;
            case "currentImpressions": return b.current.impressions - a.current.impressions;
            case "clicksDelta": return Math.abs(b.delta.clicks) - Math.abs(a.delta.clicks);
            case "positionDelta": return Math.abs(b.delta.position ?? 0) - Math.abs(a.delta.position ?? 0);
            case "impressionsDelta":
            default: return Math.abs(b.delta.impressions) - Math.abs(a.delta.impressions);
          }
        });

        return ok({
          siteUrl: resolvedSiteUrl,
          searchType,
          dimensions,
          currentRange,
          previousRange,
          fetchedRows: {
            current: currentRows.length,
            previous: previousRows.length,
          },
          totals: {
            current: summarizeRows(currentRows),
            previous: summarizeRows(previousRows),
          },
          trends: sortTrendRows(trends).slice(0, topN),
          warnings,
        });
      } catch (e) { return formatMcpToolError(e); }
    },
  );

  server.tool(
    "gsc_plan_large_site_sampling",
    "Build a read-only URL Inspection sampling plan for large sites from sitemap risk signals and Search Analytics page performance.",
    {
      siteUrl: siteUrlSchema,
      searchType: searchTypeSchema.optional().default("web"),
      datePreset: datePresetSchema.optional().default("last28days"),
      dateRange: dateRangeSchema.optional(),
      objectives: z.array(samplingObjectiveSchema).min(1).max(5).optional().default(["topTraffic", "lowCtr", "declining", "sitemapRisk", "staleSitemaps"]),
      pageLimit: z.number().int().min(1).max(25000).optional().default(5000),
      maxInspectionUrls: z.number().int().min(1).max(BULK_URL_INSPECTION_LIMIT).optional().default(BULK_URL_INSPECTION_LIMIT),
      minImpressionsForLowCtr: z.number().int().min(1).optional().default(100),
      staleSitemapDays: z.number().int().min(1).max(180).optional().default(14),
    },
    async ({ siteUrl, searchType, datePreset, dateRange, objectives, pageLimit, maxInspectionUrls, minImpressionsForLowCtr, staleSitemapDays }) => {
      try {
        const resolvedSiteUrl = resolveSiteUrl(siteUrl, config);
        const resolvedDateRange = dateRange || resolveDatePreset(datePreset as GSCDatePreset);
        const previousRange = derivePreviousDateRange(resolvedDateRange);
        validateDateRange(resolvedDateRange);
        const validation = validateGSCQuerySelection(["page"], searchType as GSCSearchType, resolvedDateRange);
        if (validation.errors.length > 0) {
          return ok({ error: "Query validation failed", errors: validation.errors, warnings: validation.warnings });
        }

        const client = await clientFactory.get();
        const [sitemapResult, currentResponse, previousResponse] = await Promise.all([
          client.listSitemaps(resolvedSiteUrl),
          client.querySearchAnalytics(resolvedSiteUrl, {
            startDate: resolvedDateRange.startDate,
            endDate: resolvedDateRange.endDate,
            dimensions: ["page"],
            type: searchType as GSCSearchType,
            dataState: "all",
            rowLimit: pageLimit,
          }),
          client.querySearchAnalytics(resolvedSiteUrl, {
            startDate: previousRange.startDate,
            endDate: previousRange.endDate,
            dimensions: ["page"],
            type: searchType as GSCSearchType,
            dataState: "all",
            rowLimit: pageLimit,
          }),
        ]);
        const sitemapSummaries = (sitemapResult.sitemap || []).map(summarizeSitemapForP2);
        const previousByPage = keyRowsByDimension(previousResponse.rows || []);
        const pageRows: PageSamplingRow[] = (currentResponse.rows || [])
          .flatMap((row) => {
            const page = row.keys?.[0];
            if (!page) return [];
            const previous = page ? rowMetrics(previousByPage.get(page)) : rowMetrics(undefined);
            const current = rowMetrics(row);
            return [{
              page,
              current,
              previous,
              delta: {
                clicks: current.clicks - previous.clicks,
                impressions: current.impressions - previous.impressions,
                ctr: roundMetric(current.ctr - previous.ctr),
                position: current.position !== null && previous.position !== null ? roundMetric(current.position - previous.position) : null,
              },
            }];
          });
        const selectedObjectives = objectives as SamplingObjective[];
        const buckets: SamplingBucket[] = [];
        const addBucket = (objective: SamplingObjective, rationale: string, candidateUrls: string[], sitemapPaths: string[] = []) => {
          if (!selectedObjectives.includes(objective)) return;
          buckets.push({
            objective,
            rationale,
            candidateUrls: dedupeUrlList(candidateUrls, maxInspectionUrls),
            sitemapPaths,
          });
        };

        addBucket(
          "topTraffic",
          "Protect the pages carrying the most organic clicks.",
          pageRows
            .slice()
            .sort((a, b) => b.current.clicks - a.current.clicks || b.current.impressions - a.current.impressions)
            .map((row) => row.page),
        );
        addBucket(
          "lowCtr",
          "Sample high-impression pages with weak CTR that may have snippet or rich-result problems.",
          pageRows
            .filter((row) => row.current.impressions >= minImpressionsForLowCtr)
            .sort((a, b) => a.current.ctr - b.current.ctr || b.current.impressions - a.current.impressions)
            .map((row) => row.page),
        );
        addBucket(
          "declining",
          "Sample pages with the largest click losses versus the previous equivalent period.",
          pageRows
            .filter((row) => row.delta.clicks < 0 || row.delta.impressions < 0)
            .sort((a, b) => a.delta.clicks - b.delta.clicks || a.delta.impressions - b.delta.impressions)
            .map((row) => row.page),
        );
        addBucket(
          "sitemapRisk",
          "Inspect representative URLs from sitemaps that currently report errors, warnings, pending status, or low index rates.",
          [],
          sitemapSummaries
            .filter((sitemap) => sitemap.status !== "healthy" || (sitemap.totals.indexRate !== null && sitemap.totals.indexRate < 90))
            .sort((a, b) => b.errors - a.errors || b.warnings - a.warnings || (a.totals.indexRate ?? 100) - (b.totals.indexRate ?? 100))
            .map((sitemap) => sitemap.path)
            .slice(0, 25),
        );
        addBucket(
          "staleSitemaps",
          `Inspect representative URLs from sitemaps not downloaded in the last ${staleSitemapDays} day(s).`,
          [],
          sitemapSummaries
            .filter((sitemap) => {
              const daysSinceDownload = safeDaysBetweenDatePrefix(sitemap.lastDownloaded, todayUtc());
              return daysSinceDownload === null || daysSinceDownload > staleSitemapDays;
            })
            .map((sitemap) => sitemap.path)
            .slice(0, 25),
        );

        const recommendedInspectionUrls = dedupeUrlList(
          buckets.flatMap((bucket) => bucket.candidateUrls),
          maxInspectionUrls,
        );
        const warnings = [...validation.warnings];
        if ((currentResponse.rows || []).length === pageLimit) {
          warnings.push("The page query reached pageLimit; sampling is based on the highest-returned Search Analytics rows.");
        }
        if (buckets.some((bucket) => bucket.sitemapPaths.length > 0 && bucket.candidateUrls.length === 0)) {
          warnings.push("Sitemaps API exposes sitemap paths and counts, not child URLs. Use these sitemap paths to choose representative URLs from your own sitemap inventory before calling URL Inspection.");
        }

        return ok({
          siteUrl: resolvedSiteUrl,
          searchType,
          dateRange: resolvedDateRange,
          previousRange,
          pageRowsAnalyzed: pageRows.length,
          sitemapTotals: summarizeSitemapCollection(sitemapSummaries),
          inspectionBudget: {
            dailyQuota: URL_INSPECTION_DAILY_QUOTA,
            maxPerToolCall: BULK_URL_INSPECTION_LIMIT,
            recommendedNow: recommendedInspectionUrls.length,
          },
          recommendedInspectionUrls,
          samplingBuckets: buckets,
          warnings,
        });
      } catch (e) { return formatMcpToolError(e); }
    },
  );

  server.tool(
    "gsc_indexation_watchlist",
    "Read-only URL Inspection watchlist for critical URLs. Inspects up to 10 URLs and returns alert/review/ok assessments without storing state.",
    {
      siteUrl: siteUrlSchema,
      urls: z.array(watchlistUrlSchema).min(1).max(BULK_URL_INSPECTION_LIMIT).describe(`Watchlist entries. Maximum ${BULK_URL_INSPECTION_LIMIT} per call to protect URL Inspection quota.`),
      languageCode: z.string().optional().describe("Optional IETF language tag, e.g. en-US or fr-FR."),
      continueOnError: z.boolean().optional().default(true),
    },
    async ({ siteUrl, urls, languageCode, continueOnError }) => {
      try {
        const resolvedSiteUrl = resolveSiteUrl(siteUrl, config);
        const client = await clientFactory.get();
        const dedupedWatchlist: WatchlistUrl[] = [];
        const seenUrls = new Set<string>();
        for (const entry of urls as WatchlistUrl[]) {
          if (seenUrls.has(entry.url)) continue;
          seenUrls.add(entry.url);
          dedupedWatchlist.push(entry);
        }

        const results: Array<Record<string, unknown>> = [];
        const summary = { ok: 0, review: 0, alert: 0, failed: 0 };
        for (const entry of dedupedWatchlist) {
          try {
            const response = await client.inspectUrl(entry.url, resolvedSiteUrl, languageCode);
            const normalized = normalizeInspectionResult(entry.url, response);
            const assessment = assessInspectionResult(normalized, entry);
            summary[assessment.status as keyof typeof summary] += 1;
            results.push({
              ok: true,
              label: entry.label,
              tags: entry.tags,
              expected: {
                verdict: entry.expectedVerdict,
                canonical: entry.expectedCanonical,
                coverageState: entry.expectedCoverageState,
              },
              ...normalized,
              assessment,
            });
          } catch (error) {
            summary.failed += 1;
            if (!continueOnError) throw error;
            results.push({ ok: false, url: entry.url, label: entry.label, priority: entry.priority, tags: entry.tags, ...normalizePerUrlError(error) });
          }
        }

        return ok({
          siteUrl: resolvedSiteUrl,
          generatedAt: new Date().toISOString(),
          inspectedCount: results.length,
          skippedDuplicates: urls.length - dedupedWatchlist.length,
          summary,
          quota: {
            dailyQuota: URL_INSPECTION_DAILY_QUOTA,
            maxPerToolCall: BULK_URL_INSPECTION_LIMIT,
            note: "URL Inspection is read-only but quota-limited; run watchlists in small batches.",
          },
          results,
        });
      } catch (e) { return formatMcpToolError(e); }
    },
  );

  server.tool(
    "gsc_find_losses_gains",
    "Compare two periods for query or page performance and return click/impression/CTR/position deltas.",
    {
      siteUrl: siteUrlSchema,
      dimension: comparisonDimensionSchema.optional().default("query"),
      searchType: searchTypeSchema.optional().default("web"),
      datePreset: datePresetSchema.optional().default("last28days"),
      currentDateRange: dateRangeSchema.optional().describe("Current period. Defaults to datePreset."),
      previousDateRange: dateRangeSchema.optional().describe("Previous period. Defaults to the immediately preceding period with the same length."),
      limit: z.number().int().min(1).max(25000).optional().default(5000).describe("Rows to fetch for each period."),
      topN: z.number().int().min(1).max(100).optional().default(25),
      minAbsClickDelta: z.number().min(0).optional().default(0).describe("Filter out rows with smaller absolute click delta."),
      sortBy: z.enum(["clicksDelta", "impressionsDelta", "ctrDelta", "positionDelta"]).optional().default("clicksDelta"),
    },
    async ({ siteUrl, dimension, searchType, datePreset, currentDateRange, previousDateRange, limit, topN, minAbsClickDelta, sortBy }) => {
      try {
        const resolvedSiteUrl = resolveSiteUrl(siteUrl, config);
        const currentRange = currentDateRange || resolveDatePreset(datePreset as GSCDatePreset);
        const previousRange = previousDateRange || derivePreviousDateRange(currentRange);
        validateDateRange(currentRange);
        validateDateRange(previousRange);

        const validation = validateGSCQuerySelection([dimension as GSCDimensionKey], searchType as GSCSearchType, currentRange);
        if (validation.errors.length > 0) {
          return ok({ error: "Query validation failed", errors: validation.errors, warnings: validation.warnings });
        }

        const client = await clientFactory.get();
        const buildRequest = (dateRange: { startDate: string; endDate: string }) => ({
          startDate: dateRange.startDate,
          endDate: dateRange.endDate,
          dimensions: [dimension as GSCDimensionKey],
          type: searchType as GSCSearchType,
          dataState: "all" as const,
          rowLimit: limit,
        });
        const [currentResponse, previousResponse] = await Promise.all([
          client.querySearchAnalytics(resolvedSiteUrl, buildRequest(currentRange)),
          client.querySearchAnalytics(resolvedSiteUrl, buildRequest(previousRange)),
        ]);
        const currentRows = currentResponse.rows || [];
        const previousRows = previousResponse.rows || [];
        const currentByKey = keyRowsByDimension(currentRows);
        const previousByKey = keyRowsByDimension(previousRows);
        const allKeys = uniqueValues([...currentByKey.keys(), ...previousByKey.keys()]);

        const deltas = allKeys.map((key) => {
          const current = rowMetrics(currentByKey.get(key));
          const previous = rowMetrics(previousByKey.get(key));
          const clicksDelta = current.clicks - previous.clicks;
          const impressionsDelta = current.impressions - previous.impressions;
          const ctrDelta = roundMetric(current.ctr - previous.ctr);
          const positionDelta = current.position !== null && previous.position !== null
            ? roundMetric(current.position - previous.position)
            : null;

          return {
            entity: { type: dimension as ComparisonDimension, value: key },
            current,
            previous,
            delta: {
              clicks: clicksDelta,
              impressions: impressionsDelta,
              ctr: ctrDelta,
              position: positionDelta,
              positionDirection: positionDelta === null ? "unknown" : positionDelta < 0 ? "improved" : positionDelta > 0 ? "declined" : "unchanged",
            },
            changePercent: {
              clicks: percentageChange(current.clicks, previous.clicks),
              impressions: percentageChange(current.impressions, previous.impressions),
            },
          };
        }).filter((row) => Math.abs(row.delta.clicks) >= minAbsClickDelta);

        const getSortValue = (row: typeof deltas[number]): number => {
          switch (sortBy) {
            case "clicksDelta": return row.delta.clicks;
            case "impressionsDelta": return row.delta.impressions;
            case "ctrDelta": return row.delta.ctr;
            case "positionDelta": return row.delta.position ?? 0;
            default: return row.delta.clicks;
          }
        };

        const sortDeltaRows = (rows: typeof deltas, direction: "gain" | "loss") => rows.sort((a, b) => {
          const aValue = getSortValue(a);
          const bValue = getSortValue(b);
          if (sortBy === "positionDelta") {
            return direction === "gain" ? aValue - bValue : bValue - aValue;
          }
          return direction === "gain" ? Number(bValue) - Number(aValue) : Number(aValue) - Number(bValue);
        });

        const gains = sortDeltaRows(
          deltas.filter((row) => row.delta.clicks > 0 || row.delta.impressions > 0),
          "gain",
        ).slice(0, topN);
        const losses = sortDeltaRows(
          deltas.filter((row) => row.delta.clicks < 0 || row.delta.impressions < 0),
          "loss",
        ).slice(0, topN);

        return ok({
          siteUrl: resolvedSiteUrl,
          dimension,
          searchType,
          currentRange,
          previousRange,
          fetchedRows: {
            current: currentRows.length,
            previous: previousRows.length,
          },
          totals: {
            current: summarizeRows(currentRows),
            previous: summarizeRows(previousRows),
          },
          gains,
          losses,
          warnings: validation.warnings,
        });
      } catch (e) { return formatMcpToolError(e); }
    },
  );

  server.tool(
    "gsc_cluster_queries",
    "Cluster Search Console queries by simple tokens and intent signals: brand/non-brand, question, category, and topic tokens.",
    {
      siteUrl: siteUrlSchema,
      searchType: searchTypeSchema.optional().default("web"),
      datePreset: datePresetSchema.optional().default("last28days"),
      dateRange: dateRangeSchema.optional(),
      brandTerms: z.array(z.string()).optional().default([]).describe("Optional brand terms. Defaults to terms derived from the property domain."),
      categoryRules: z.record(z.array(z.string())).optional().describe("Optional map of category name to matching tokens/phrases."),
      limit: z.number().int().min(1).max(25000).optional().default(5000),
      maxClusters: z.number().int().min(1).max(100).optional().default(25),
      topQueriesPerCluster: z.number().int().min(1).max(25).optional().default(10),
    },
    async ({ siteUrl, searchType, datePreset, dateRange, brandTerms, categoryRules, limit, maxClusters, topQueriesPerCluster }) => {
      try {
        const resolvedSiteUrl = resolveSiteUrl(siteUrl, config);
        const resolvedDateRange = dateRange || resolveDatePreset(datePreset as GSCDatePreset);
        validateDateRange(resolvedDateRange);

        const validation = validateGSCQuerySelection(["query"], searchType as GSCSearchType, resolvedDateRange);
        if (validation.errors.length > 0) {
          return ok({ error: "Query validation failed", errors: validation.errors, warnings: validation.warnings });
        }

        const client = await clientFactory.get();
        const response = await client.querySearchAnalytics(resolvedSiteUrl, {
          startDate: resolvedDateRange.startDate,
          endDate: resolvedDateRange.endDate,
          dimensions: ["query"],
          type: searchType as GSCSearchType,
          dataState: "all",
          rowLimit: limit,
        });
        const rows = response.rows || [];
        const resolvedBrandTerms = expandBrandTerms(brandTerms.length > 0 ? brandTerms : deriveBrandTerms(resolvedSiteUrl));
        const brandClusters = new Map<string, MetricBucket>();
        const questionClusters = new Map<string, MetricBucket>();
        const intentClusters = new Map<string, MetricBucket>();
        const categoryClusters = new Map<string, MetricBucket>();
        const tokenClusters = new Map<string, MetricBucket>();
        const warnings = [...validation.warnings];

        if (resolvedBrandTerms.length === 0) {
          warnings.push("No brand terms were provided or derived; all queries may be classified as nonBrand.");
        }
        if (rows.length === limit) {
          warnings.push("The response reached the row limit; lower-volume queries may be missing from clusters.");
        }

        for (const row of rows) {
          const query = row.keys?.[0];
          if (!query) continue;
          const tokens = tokenizeQuery(query);
          const classification = classifyQuery(query, tokens, resolvedBrandTerms);
          const category = resolveQueryCategory(query, tokens, categoryRules);

          addQueryToBucket(getOrCreateBucket(brandClusters, classification.brand), query, row);
          addQueryToBucket(getOrCreateBucket(questionClusters, classification.question), query, row);
          addQueryToBucket(getOrCreateBucket(intentClusters, classification.intent), query, row);
          addQueryToBucket(getOrCreateBucket(categoryClusters, category), query, row);
          for (const token of tokens) {
            addQueryToBucket(getOrCreateBucket(tokenClusters, token), query, row);
          }
        }

        return ok({
          siteUrl: resolvedSiteUrl,
          searchType,
          dateRange: resolvedDateRange,
          rowCount: rows.length,
          brandTerms: resolvedBrandTerms,
          totals: summarizeRows(rows),
          clusters: {
            brand: finalizeBuckets(brandClusters, topQueriesPerCluster),
            question: finalizeBuckets(questionClusters, topQueriesPerCluster),
            intent: finalizeBuckets(intentClusters, topQueriesPerCluster),
            category: finalizeBuckets(categoryClusters, topQueriesPerCluster).slice(0, maxClusters),
            tokens: finalizeBuckets(tokenClusters, topQueriesPerCluster).slice(0, maxClusters),
          },
          warnings,
        });
      } catch (e) { return formatMcpToolError(e); }
    },
  );

  server.tool(
    "gsc_detect_cannibalization",
    "Detect queries where multiple pages compete for clicks/impressions in Search Analytics query-page rows.",
    {
      siteUrl: siteUrlSchema,
      searchType: searchTypeSchema.optional().default("web"),
      datePreset: datePresetSchema.optional().default("last28days"),
      dateRange: dateRangeSchema.optional(),
      limit: z.number().int().min(1).max(25000).optional().default(5000),
      minPages: z.number().int().min(2).max(10).optional().default(2),
      minImpressions: z.number().int().min(0).optional().default(100),
      maxTopPageClickShare: z.number().min(0.1).max(0.99).optional().default(0.8).describe("Only flag queries where the top page owns less than or equal to this click share."),
      topN: z.number().int().min(1).max(100).optional().default(25),
    },
    async ({ siteUrl, searchType, datePreset, dateRange, limit, minPages, minImpressions, maxTopPageClickShare, topN }) => {
      try {
        const resolvedSiteUrl = resolveSiteUrl(siteUrl, config);
        const resolvedDateRange = dateRange || resolveDatePreset(datePreset as GSCDatePreset);
        validateDateRange(resolvedDateRange);

        const validation = validateGSCQuerySelection(["query", "page"], searchType as GSCSearchType, resolvedDateRange);
        if (validation.errors.length > 0) {
          return ok({ error: "Query validation failed", errors: validation.errors, warnings: validation.warnings });
        }

        const client = await clientFactory.get();
        const response = await client.querySearchAnalytics(resolvedSiteUrl, {
          startDate: resolvedDateRange.startDate,
          endDate: resolvedDateRange.endDate,
          dimensions: ["query", "page"],
          type: searchType as GSCSearchType,
          dataState: "all",
          rowLimit: limit,
        });
        const rows = response.rows || [];
        const grouped = new Map<string, Map<string, { page: string; clicks: number; impressions: number; weightedPosition: number }>>();
        const warnings = [...validation.warnings];

        if (rows.length === limit) {
          warnings.push("The query-page response reached the row limit; cannibalization candidates may be incomplete.");
        }

        for (const row of rows) {
          const query = row.keys?.[0];
          const page = row.keys?.[1];
          if (!query || !page) continue;

          const pageMap = grouped.get(query) || new Map<string, { page: string; clicks: number; impressions: number; weightedPosition: number }>();
          const pageStats = pageMap.get(page) || { page, clicks: 0, impressions: 0, weightedPosition: 0 };
          pageStats.clicks += row.clicks;
          pageStats.impressions += row.impressions;
          pageStats.weightedPosition += row.position * row.impressions;
          pageMap.set(page, pageStats);
          grouped.set(query, pageMap);
        }

        const candidates = [];
        for (const [query, pageMap] of grouped.entries()) {
          const pages = [...pageMap.values()]
            .map((pageStats) => ({
              page: pageStats.page,
              clicks: roundMetric(pageStats.clicks, 0),
              impressions: roundMetric(pageStats.impressions, 0),
              ctr: pageStats.impressions > 0 ? roundMetric((pageStats.clicks / pageStats.impressions) * 100) : 0,
              position: pageStats.impressions > 0 ? roundMetric(pageStats.weightedPosition / pageStats.impressions) : 0,
            }))
            .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);

          const totalClicks = pages.reduce((sum, page) => sum + page.clicks, 0);
          const totalImpressions = pages.reduce((sum, page) => sum + page.impressions, 0);
          if (pages.length < minPages || totalImpressions < minImpressions) continue;

          const topPage = pages[0];
          if (!topPage) continue;
          const topClickShare = totalClicks > 0 ? topPage.clicks / totalClicks : 0;
          const topImpressionShare = totalImpressions > 0 ? topPage.impressions / totalImpressions : 0;
          const competitionShare = totalClicks > 0 ? topClickShare : topImpressionShare;
          if (competitionShare > maxTopPageClickShare) continue;

          const dispersion = 1 - competitionShare;
          const pageFactor = Math.min(pages.length / 5, 1);
          const volumeFactor = Math.min(totalImpressions / 10_000, 1);
          const severityScore = roundMetric((dispersion * 70) + (pageFactor * 20) + (volumeFactor * 10));

          candidates.push({
            query,
            pageCount: pages.length,
            totalClicks: roundMetric(totalClicks, 0),
            totalImpressions: roundMetric(totalImpressions, 0),
            ctr: totalImpressions > 0 ? roundMetric((totalClicks / totalImpressions) * 100) : 0,
            topPage: topPage.page,
            topPageClickShare: roundMetric(topClickShare * 100),
            topPageImpressionShare: roundMetric(topImpressionShare * 100),
            severityScore,
            competingPages: pages.slice(0, 10),
          });
        }

        return ok({
          siteUrl: resolvedSiteUrl,
          searchType,
          dateRange: resolvedDateRange,
          analyzedRows: rows.length,
          candidateCount: candidates.length,
          candidates: candidates
            .sort((a, b) => b.severityScore - a.severityScore || b.totalImpressions - a.totalImpressions)
            .slice(0, topN),
          thresholds: {
            minPages,
            minImpressions,
            maxTopPageClickShare: roundMetric(maxTopPageClickShare * 100),
          },
          warnings,
        });
      } catch (e) { return formatMcpToolError(e); }
    },
  );

  server.tool(
    "gsc_validate_query",
    "Validate a Search Console metric/dimension/search type combination before executing it.",
    {
      dimensions: z.array(z.string()).optional().describe("Dimensions to validate."),
      searchType: searchTypeSchema.optional().default("web"),
      dateRange: z.object({ startDate: z.string(), endDate: z.string() }).optional(),
    },
    async ({ dimensions, searchType, dateRange }) => {
      try {
        const result = validateGSCQuerySelection(
          (dimensions ?? []) as import("./types.js").GSCDimensionKey[],
          searchType as GSCSearchType,
          dateRange,
        );
        return ok(result);
      } catch (e) { return formatMcpToolError(e); }
    },
  );
}
