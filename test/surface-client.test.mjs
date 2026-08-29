import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { GSCClient } from "../src/platforms/gsc/gscClient.ts";
import { planGSCQuery } from "../src/platforms/gsc/queryPlanner.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

test("GSC sites.get, sitemaps.get, and sitemap-index filtering use encoded official routes", async () => {
  const urls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/sites/") && !url.includes("/sitemaps")) {
      return jsonResponse({ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" });
    }
    if (url.includes("/sitemaps/") && !url.includes("?")) return jsonResponse({ path: "https://example.com/sitemap.xml" });
    return jsonResponse({ sitemap: [] });
  };

  const client = new GSCClient("token");
  await client.getSite("sc-domain:example.com");
  await client.listSitemaps("sc-domain:example.com", "https://example.com/index.xml");
  await client.getSitemap("sc-domain:example.com", "https://example.com/sitemap.xml");

  assert.deepEqual(urls, [
    "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com",
    "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/sitemaps?sitemapIndex=https%3A%2F%2Fexample.com%2Findex.xml",
    "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/sitemaps/https%3A%2F%2Fexample.com%2Fsitemap.xml",
  ]);
});

test("GSC query planner preserves hourly freshness and aggregation controls", () => {
  const plan = planGSCQuery({
    siteUrl: "sc-domain:example.com",
    dimensions: ["hour"],
    searchType: "web",
    dataState: "hourly_all",
    aggregationType: "byPage",
    dateRange: { startDate: "2026-07-15", endDate: "2026-07-16" },
  });
  assert.equal(plan.errors.length, 0);
  assert.deepEqual(plan.request.dimensions, ["hour"]);
  assert.equal(plan.request.dataState, "hourly_all");
  assert.equal(plan.request.aggregationType, "byPage");

  const invalid = planGSCQuery({
    siteUrl: "sc-domain:example.com",
    dimensions: ["page"],
    aggregationType: "byProperty",
  });
  assert.match(invalid.errors.join(" "), /cannot be used when grouping or filtering by page/);
});

test("GSC auto-pagination continues from a non-zero startRow", async () => {
  const requestBodies = [];
  const row = { keys: ["example"], clicks: 1, impressions: 2, ctr: 0.5, position: 1 };
  let requestCount = 0;
  globalThis.fetch = async (_input, init = {}) => {
    requestBodies.push(JSON.parse(String(init.body)));
    requestCount += 1;
    return jsonResponse({ rows: requestCount === 1 ? Array(25000).fill(row) : [row] });
  };

  const client = new GSCClient("token");
  const response = await client.querySearchAnalytics("sc-domain:example.com", {
    startDate: "2026-07-01",
    endDate: "2026-07-16",
    startRow: 50000,
  });

  assert.equal(response.rows?.length, 25001);
  assert.deepEqual(requestBodies.map((body) => body.startRow), [50000, 75000]);
});

test("GSC query planner enforces the complete News Showcase aggregation contract", () => {
  for (const searchType of ["discover", "googleNews"]) {
    const valid = planGSCQuery({
      siteUrl: "sc-domain:example.com",
      searchType,
      aggregationType: "byNewsShowcasePanel",
      filters: [{ field: "searchAppearance", operator: "equals", value: "NEWS_SHOWCASE" }],
    });
    assert.deepEqual(valid.errors, []);
  }

  const wrongSearchType = planGSCQuery({
    siteUrl: "sc-domain:example.com",
    searchType: "web",
    aggregationType: "byNewsShowcasePanel",
    filters: [{ field: "searchAppearance", operator: "equals", value: "NEWS_SHOWCASE" }],
  });
  assert.match(wrongSearchType.errors.join(" "), /requires searchType=discover or googleNews/);

  const missingAppearance = planGSCQuery({
    siteUrl: "sc-domain:example.com",
    searchType: "discover",
    aggregationType: "byNewsShowcasePanel",
  });
  assert.match(missingAppearance.errors.join(" "), /requires a searchAppearance equals NEWS_SHOWCASE filter/);

  const pageDimension = planGSCQuery({
    siteUrl: "sc-domain:example.com",
    searchType: "discover",
    aggregationType: "byNewsShowcasePanel",
    dimensions: ["page"],
    filters: [{ field: "searchAppearance", operator: "equals", value: "NEWS_SHOWCASE" }],
  });
  assert.match(pageDimension.errors.join(" "), /cannot be used when grouping or filtering by page/);

  const pageFilter = planGSCQuery({
    siteUrl: "sc-domain:example.com",
    searchType: "googleNews",
    aggregationType: "byNewsShowcasePanel",
    filters: [
      { field: "searchAppearance", operator: "equals", value: "NEWS_SHOWCASE" },
      { field: "page", operator: "contains", value: "/news/" },
    ],
  });
  assert.match(pageFilter.errors.join(" "), /cannot be used when grouping or filtering by page/);

  const otherAppearance = planGSCQuery({
    siteUrl: "sc-domain:example.com",
    searchType: "discover",
    aggregationType: "byNewsShowcasePanel",
    filters: [
      { field: "searchAppearance", operator: "equals", value: "NEWS_SHOWCASE" },
      { field: "searchAppearance", operator: "notEquals", value: "AMP_BLUE_LINK" },
    ],
  });
  assert.match(otherAppearance.errors.join(" "), /cannot filter to a searchAppearance other than NEWS_SHOWCASE/);
});
