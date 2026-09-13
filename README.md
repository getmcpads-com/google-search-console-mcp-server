# google-search-console-mcp-server

[![CI](https://github.com/getmcpads-com/google-search-console-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/getmcpads-com/google-search-console-mcp-server/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](package.json)

An open-source [Model Context Protocol](https://modelcontextprotocol.io) server for
**Google Search Console**. It lets Claude, ChatGPT, Cursor or any MCP client query your
search performance, inspect indexing, and analyse sitemaps.

**Read-only, with no way to turn that off.** You run it, and your credentials stay on your
machine.

```bash
npx -y @getmcpads/google-search-console-mcp-server
```

Also listed in the [MCP Registry](https://registry.modelcontextprotocol.io) as **`com.getmcpads/google-search-console`**, so clients that read the registry can install it by name.

> **Prefer a hosted connection?** [Get MCP Ads for Search Console](https://www.getmcpads.com/tools/search-console?utm_source=github&utm_medium=readme&utm_campaign=search_console_hosted)
> handles the server and OAuth flow. Create a workspace, connect the platform and
> select the accounts or properties your assistant may read. Free is read only;
> paid limits and supported writes are described on the site. Hosted and npm
> releases can differ: check the current catalogue for the operation you need.

---

## What you get

| | |
|---|---|
| **20 read tools** | Search Analytics, sites, sitemaps, URL Inspection, and analyses built on top of them |
| **SEO analyses, not just an API wrapper** | Cannibalisation detection, query clustering, wins and losses between periods, indexation watchlists, large-site sampling plans |
| **7 resources** | Live catalogues the model can read: metrics, dimensions, filters, compatibility rules, 8 workflow recipes, read-only playbooks |
| **Quota guardrails** | Every URL Inspection call is capped at 10 URLs, so one exploratory question cannot burn a day of quota |
| **No writes at all** | Not a flag, a property of the code. See below |

### What it does beyond fetching rows

Search Console answers questions about rows. Most real questions are about **change**: which
queries did we lose, which pages compete for the same term, is indexing drifting.

These tools do that work rather than leaving it to the model:

| Tool | Question it answers |
|---|---|
| `gsc_detect_cannibalization` | Which pages compete for the same query |
| `gsc_find_losses_gains` | What we won and lost between two periods |
| `gsc_cluster_queries` | Which queries belong to the same intent |
| `gsc_compare_search_types` | How web, image, video and news differ |
| `gsc_analyze_search_appearance_trends` | How rich results evolve |
| `gsc_indexation_watchlist` | Which URLs changed indexing verdict |
| `gsc_plan_large_site_sampling` | Which URLs to inspect, when you cannot inspect them all |

---

## One thing to know before you trust a number

**Search Console returns a top N, not a site total.**

When you query with a dimension such as `query` or `page`, the API returns the highest
ranked rows up to your row limit, ordered by clicks. Summing the clicks of those rows does
**not** give you the site total: the long tail is missing, and on a large site it can be most
of the traffic.

To get a real total, query **without dimensions**. To compare periods, compare like with
like: same dimensions, same row limit, same search type.

`gsc_query_search_analytics` reports what it actually returned, and `gsc_validate_query`
checks a combination before it runs. But the arithmetic mistake is yours to avoid, and it is
the most common one in Search Console analysis.

Two other limits worth carrying in your head:

- **Roughly 16 months of history.** Anything older is gone, not slow.
- **Data settles over about three days.** `gsc_get_data_freshness` tells you what is final.

---

## Read-only, and why it stays that way

There are no write tools, and no environment variable that adds any. The Search Console API
can submit and delete sitemaps, add and remove properties, and request indexing. **This
server exposes none of that.**

The scope it asks for reflects that: `webmasters.readonly`, not `webmasters`. Even if the
model tried, the token cannot write.

Our ad platform servers, where writes make sense, do have them, guarded by a mandatory
preview:
[Meta Ads](https://github.com/getmcpads-com/meta-ads-mcp-server) ·
[Google Ads](https://github.com/getmcpads-com/google-ads-mcp-server) ·
[TikTok Ads](https://github.com/getmcpads-com/tiktok-ads-mcp-server)

The hosted version at [getmcpads.com](https://www.getmcpads.com) keeps the same rule: Search
Console stays read-only there too.

---

## Getting credentials

Three values, obtained once.

### 1. OAuth client

In a [Google Cloud project](https://console.cloud.google.com/), enable the **Google Search
Console API**, then create an OAuth client under **APIs & Services → Credentials**. Choose
**Desktop app** for local use. Note the **client ID** and **client secret**.

### 2. Refresh token

Run the OAuth consent flow once, signed in as a Google account that owns or can read your
properties, and keep the **refresh token**. Request `webmasters.readonly` and nothing more.

📖 [Google OAuth for installed apps](https://developers.google.com/identity/protocols/oauth2/native-app)

**The refresh token does not expire.** Use an OAuth client dedicated to this server so you
can revoke it on its own.

For a quick trial you can set `GSC_ACCESS_TOKEN` to a short-lived token instead, but it
expires within the hour and is useless for daily work.

If setting up an OAuth client is more than you want to do for one property,
[getmcpads.com](https://www.getmcpads.com) handles the consent flow for you and gives you the
same tools behind a hosted endpoint.

### 3. Site URL, optional

Set `GSC_SITE_URL` to avoid passing it on every call. Both property forms work:

| Property type | Value |
|---|---|
| URL-prefix | `https://example.com/` (the trailing slash matters) |
| Domain | `sc-domain:example.com` |

List what you can reach with `gsc_list_sites`, and run **`gsc_health_check`** as your first
call. It verifies the credentials without printing any secret.

---

## Setup

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "search-console": {
      "command": "npx",
      "args": ["-y", "@getmcpads/google-search-console-mcp-server"],
      "env": {
        "GSC_CLIENT_ID": "your-client-id",
        "GSC_CLIENT_SECRET": "your-client-secret",
        "GSC_REFRESH_TOKEN": "your-refresh-token"
      }
    }
  }
}
```

Restart Claude Desktop. Ask it: *"which queries did we lose last month?"*.

### Claude Code

```bash
claude mcp add search-console --env GSC_CLIENT_ID=... --env GSC_CLIENT_SECRET=... --env GSC_REFRESH_TOKEN=... -- npx -y @getmcpads/google-search-console-mcp-server
```

### Cursor

`.cursor/mcp.json` in your project, same shape as the Claude Desktop config above.

### From source

```bash
git clone https://github.com/getmcpads-com/google-search-console-mcp-server.git
cd google-search-console-mcp-server
npm install && npm run build
cp .env.example .env   # then fill in your credentials
npm start
```

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GSC_CLIENT_ID` | none | OAuth client ID |
| `GSC_CLIENT_SECRET` | none | OAuth client secret |
| `GSC_REFRESH_TOKEN` | none | From the consent flow |
| `GSC_ACCESS_TOKEN` | none | Alternative to the three above, expires within the hour |
| `GSC_SITE_URL` | none | Optional default property |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

Either the three OAuth values, or `GSC_ACCESS_TOKEN`. The server refuses to start with neither.

```bash
npm run doctor
```

---

## Tools

<details>
<summary><b>20 read tools</b></summary>

### Discovery and health
| Tool | Purpose |
|---|---|
| `gsc_health_check` | Validates credentials and reachable properties |
| `gsc_list_sites` / `gsc_get_site` | Properties you can reach, and their permission level |
| `gsc_get_data_freshness` | How settled the most recent data is |

### Search Analytics
| Tool | Purpose |
|---|---|
| `gsc_query_search_analytics` | The main reporting tool. Dimensions, filters, date ranges |
| `gsc_validate_query` | Check a combination *before* running it |
| `gsc_compare_search_types` | Web, image, video, news and discover side by side |
| `gsc_analyze_search_appearance_trends` | How rich results evolve over time |

### SEO analysis
| Tool | Purpose |
|---|---|
| `gsc_detect_cannibalization` | Pages competing for the same query |
| `gsc_find_losses_gains` | Queries and pages won or lost between two periods |
| `gsc_cluster_queries` | Group queries by shared intent |

### Indexing
| Tool | Purpose |
|---|---|
| `gsc_inspect_url` | Crawl and index status for one URL |
| `gsc_bulk_inspect_urls` | Up to 10 URLs per call, to protect your quota |
| `gsc_indexation_watchlist` | Track URLs whose verdict changed |
| `gsc_monitor_indexation_freshness` | Freshness and indexation drift together |
| `gsc_plan_large_site_sampling` | Build an inspection sample when you cannot inspect everything |

### Sitemaps
| Tool | Purpose |
|---|---|
| `gsc_list_sitemaps` / `gsc_get_sitemap` | Submitted sitemaps and their status |
| `gsc_get_sitemap_health` | Errors, warnings and pending states |
| `gsc_track_sitemap_deltas` | What changed against a baseline you supply |

</details>

<details>
<summary><b>7 resources</b></summary>

| URI | Contents |
|---|---|
| `gsc://manifest` | What this server exposes, and which tool to run first |
| `gsc://metrics` | The 8 Search Analytics metrics, raw and derived |
| `gsc://dimensions` | The 7 dimensions and where they are valid |
| `gsc://filters` | The 5 filter operators and their accepted values |
| `gsc://compatibility` | Which dimensions work with which search types and data states |
| `gsc://recipes` | 8 step-by-step workflows |
| `gsc://p2-readonly-playbooks` | Monitoring playbooks and their invariants |

</details>

---

## Security

- **The client secret and refresh token are never logged**, at any log level, or written to disk.
- **Four hosts are contacted, and only four**: `searchconsole.googleapis.com` and
  `www.googleapis.com` for the API, `oauth2.googleapis.com` and `accounts.google.com` for
  OAuth. *A test fails the build if a fifth host appears in the source.*
- **No fetch follows a redirect.** Every outbound call sets `redirect: "error"`, so a redirect
  cannot forward a bearer token or client secret to another host. *A test fails the build if
  any fetch omits this.*
- **The scope is `webmasters.readonly`.** The token itself cannot write.
- **No telemetry.** The server makes no network call other than to Google.

Full policy: [SECURITY.md](SECURITY.md).

---

## Looking for a managed, multi-platform version?

[Try hosted Search Console](https://www.getmcpads.com/tools/search-console?utm_source=github&utm_medium=readme&utm_campaign=search_console_hosted) if you want to use this source without operating a local server.
Get MCP Ads also connects advertising, Search Console and GA4 through one MCP URL.
Source availability and plan limits are listed on the site; connecting an account is still required.

1. Follow the [Search Console connection guide](https://www.getmcpads.com/guides/sources/search-console).
2. Select the account or property your assistant may read.
3. Connect [Claude](https://www.getmcpads.com/guides/setup/claude),
   [ChatGPT](https://www.getmcpads.com/guides/setup/chatgpt) or
   [Codex](https://www.getmcpads.com/guides/setup/codex).
4. Try a read-only review: “Find which pages and queries account for a change in organic clicks. State missing data and do not change anything.”

See the [current hosted tool catalogue](https://www.getmcpads.com/tools/search-console)
and [pricing](https://www.getmcpads.com/pricing) before choosing a paid plan.
This Apache 2.0 adapter remains independently useful with your own credentials.

---

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
Please read [SECURITY.md](SECURITY.md) before reporting anything security-related.

## Licence

[Apache License 2.0](LICENSE). See also [NOTICE](NOTICE).

Google and Google Search Console are trademarks of Google LLC.
**This project is not affiliated with, endorsed by, or sponsored by Google LLC.**
It is an independent client of a public API.

## Version 1.1: platform updates and MCP contracts

Every tool now declares read/write annotations, parameter descriptions and a structured output schema. Successful calls retain their original text and expose the same payload as `structuredContent.result`; provider fields depend on the selected report. Errors retain `isError: true`. The generated [server card](server-card.json) contains definitions only, with no account credentials.


The hosted GetMCPAds service additionally provides OAuth account selection and interactive review workspaces. Local servers use your own platform credentials and return native report data and media references.

### Desktop bundle

Run `npm run bundle -- /path/to/output` to build a `.mcpb` desktop bundle from the current catalogue. The bundle contains production dependencies, documented local configuration, and complete tool definitions. Provider credentials are entered locally during installation; write tools remain disabled unless explicitly enabled.
