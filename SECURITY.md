# Security Policy

This server reads Search Console data for properties you own. We take reports
seriously.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting on this repository:
[Report a vulnerability](https://github.com/getmcpads-com/google-search-console-mcp-server/security/advisories/new).

We aim to acknowledge a report within 3 business days and to ship a fix or a
documented mitigation within 30 days. We will credit you in the advisory unless
you ask us not to.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.x     | ✅        |

## This server cannot write

There are no write tools, and no flag that adds any. Every tool calls a read
method. It cannot submit or delete a sitemap, add or remove a property, or
request indexing. The Search Console API can do those things; this server does
not expose them.

The scope it asks for reflects that: `webmasters.readonly`, not `webmasters`.

## What this server does with your credentials

- The OAuth client secret, refresh token and any access token are read once
  from the environment at startup and kept in memory. None is ever written to
  disk or logged, at any log level.
- **Four hosts are contacted, and only four**: `searchconsole.googleapis.com`
  and `www.googleapis.com` for the API, `oauth2.googleapis.com` and
  `accounts.google.com` for the OAuth flow. *A test fails the build if a fifth
  host appears in the source.*
- **No fetch follows a redirect.** Every outbound call sets `redirect: "error"`,
  so a redirect cannot forward a bearer token or client secret to another host.
  *A test fails the build if any fetch omits this.*
- No telemetry, no analytics, no phone-home.

## URL Inspection quota

URL Inspection is rate limited by Google per property and per day. Every tool
in this server that inspects URLs caps a single call at 10 URLs, so a model
cannot exhaust a day of quota in one exploratory request. That cap is a
deliberate guardrail, not a technical limit of the API.

## Handling your credentials safely

- The refresh token does not expire and can mint access tokens indefinitely.
  Treat it like a password.
- Use an OAuth client dedicated to this server, so you can revoke it alone.
- `webmasters.readonly` is the only scope needed. Do not grant `webmasters`.
- Your MCP client config file is usually plain text on disk. Check its
  permissions, and never commit it.
- Revoke from [Google account permissions](https://myaccount.google.com/permissions)
  if you suspect exposure.

## Scope

Vulnerabilities in the Search Console API itself are not in scope here; report
those to Google.
