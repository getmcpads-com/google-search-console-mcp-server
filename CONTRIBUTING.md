# Contributing

Thanks for considering a contribution. This project is maintained by
[GetMCPAds](https://www.getmcpads.com) and is open to outside patches.

## Getting set up

```bash
git clone https://github.com/getmcpads-com/google-search-console-mcp-server.git
cd google-search-console-mcp-server
npm install
cp .env.example .env
```

Then run the checks:

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

All four must pass. CI runs them on Node 18, 20 and 22.

## Ground rules

**Never commit a token.** `.env` is gitignored. Before opening a PR, re-read
your diff for anything starting with `1//`, which is the prefix of a Google
refresh token.

**Tests use recorded or synthetic data.** Do not add a test that needs live
credentials to pass; CI has none.

**Metric and dimension catalogues are the load-bearing part.** If you add or
change an entry in `metricCatalog.ts`, `dimensionCatalog.ts`,
`filterCatalog.ts` or `compatibilityRules.ts`, say in the PR description
where the rule comes from: a link to the Search Console documentation, or the
API error you observed. A plausible-looking rule that is wrong is worse than a
missing one, because the query planner trusts it.

**This server stays read-only.** Every tool must call a read method of the
Search Console API. A pull request adding a tool that submits a sitemap, adds a
property or requests indexing will not be merged, whatever it is guarded by.
The OAuth scope is `webmasters.readonly`, and it stays that way.

**Keep the URL Inspection cap.** Inspection tools cap a single call at 10 URLs
so a model cannot exhaust a property's daily quota in one exploratory request.
Raising or removing that cap needs to say why in the PR.

**Keep it self-contained.** Runtime dependencies are `@modelcontextprotocol/sdk`
and `zod`. Adding a third needs a good reason.

## Credentials never reach the logs or a host beyond Google

Two tests enforce this: one fails if any `fetch` omits `redirect: "error"`, and
one fails if a host other than the four Google endpoints appears in the source.
Both are load-bearing, not decoration. If your change needs a new host, say why
in the PR.

## Commit and PR style

- One logical change per PR.
- Explain *why*, not just *what*. The diff already says what.
- If you fix a bug, add the test that would have caught it.

## Reporting bugs

Open an issue with: what you called, what you expected, what you got, and the
API version in use. Redact IDs and tokens.

For anything security-related, do not open an issue. See [SECURITY.md](SECURITY.md).

## Licence

By contributing, you agree that your contributions are licensed under the
Apache License 2.0, as stated in [LICENSE](LICENSE).
