# Client API compatibility

[简体中文](compatibility.zh-CN.md)

**Endpoints available since v0.3.1; best-effort translation since v0.3.2.** Upgrade with `npm install search2ai@latest`.

Keep the SDK and supported application calls you already use, and change the service base URL and gateway credentials. Compatibility applies to the methods and options below. It does not imply identical rankings, every original feature, or every SDK version.

This guide covers HTTP API and SDK compatibility. MCP clients use search2ai's own `search`, `news` and `crawl` tools with unified parameters and results, independently of the selected backend. The HTTP adapters do not add separate provider-specific MCP tool formats.

## Service bases and routes

Replace `https://gateway.example.com` with your deployment, including any application mount prefix.

| Client protocol | API base | Routes appended by the client | Gateway authentication |
| --- | --- | --- | --- |
| SearXNG | `/compat/searxng` | `/` or `/search`; GET or POST | Bearer header when `AUTH_KEYS` is set |
| Exa | `/compat/exa` | `POST /search`, `POST /contents` | `x-api-key` or Bearer |
| Tavily | `/compat/tavily` | `POST /search`, `POST /extract` | Bearer; legacy body `api_key` also accepted |
| Search1API | `/compat/search1api` | `POST /search`, `POST /news`, `POST /crawl` | Bearer |
| Firecrawl | `/compat/firecrawl` | `POST /v2/scrape`, `POST /v1/scrape` | Bearer |

Use a gateway key from `AUTH_KEYS` in the client. Provider keys remain in deployment configuration. Compatibility keys are case sensitive; conflicting credentials are rejected. Without `AUTH_KEYS`, authentication is disabled, as with the existing gateway endpoints.

Do not append `/search` or `/v2` to the SDK base unless that particular client's configuration expects a complete endpoint. The tested SDKs append those segments themselves. SearXNG clients vary: some accept an instance base, others a complete search URL. A client with a fixed upstream hostname or no custom authentication headers needs suitable client configuration or a reverse proxy; a new endpoint cannot override its hardcoded URL.

## Backend routing and limits

The protocol does not select the backend. The existing `SEARCH_SERVICE`, `NEWS_SERVICE`, and `CRAWL_SERVICE` chains determine the attempt order. No configured provider for the operation means `503`, with no default outbound call.

- **Matching upstream:** when a chain reaches the matching provider, requests and responses retain native fields, metadata, scores and costs actually returned by that upstream. Gateway credentials are replaced with configured upstream credentials. Native options are validated by the upstream, subject to the search/single-page scope below. Exa's `Exa-Beta` header is preserved for native Exa calls.
- **Another upstream:** requests are translated on a best-effort basis. Available options are mapped; unknown or unavailable options are ignored. They do not cause `422` or skip an otherwise usable provider. There is no strict mode. For example, Tavily `include_domains` maps to the gateway's domain filter; `search_depth=advanced` is ignored when the chosen adapter has no equivalent.
- **Failures:** upstream failures continue through the configured chain, including translation of native-only options. A native error is retained if no fallback succeeds. Successful empty responses are returned as-is unless `FALLBACK_ON_EMPTY=true`; this also applies to native calls. Native responses bypass normalized result caching; translated calls use the core cache.
- **Scope:** search and explicitly given page URLs only. Recursive discovery, generated answers, structured extraction, streaming, browser actions and screenshots are ignored on these routes, including native calls. Whole-site crawl, jobs, polling, cancellation, map and webhook routes remain unavailable (`404`).

Response headers describe routing and adjustments without changing the client's response envelope:

- `X-Search2AI-Mode`: `native` or `translated`.
- `X-Search2AI-Provider`: providers actually used, including any content reader.
- `X-Search2AI-Skipped`: failed or empty attempts passed over during fallback.
- `X-Search2AI-Ignored`: comma-separated ignored option names, including nested paths such as `contents.highlights`. Names are percent-encoded; diagnostics are bounded to 50 names of at most 120 encoded characters each, with longer names replaced by `option_name_truncated`. Names, not option values, are included.
- `X-Search2AI-Warnings`: comma-separated adjustment codes: `result_limit_clamped`, `crawl_limit_clamped`, `language_normalized`, `markdown_fallback`, `content_unavailable`, or `content_partial`.

These headers are exposed through CORS. Check them if your application depends on a particular filter or feature: ignored options may broaden results or repeat the first page. Compatibility preserves the client format, not every original service's behavior, ranking or field availability.

Invalid request values still return `400`, authentication failures `401`, missing providers `503`, native timeouts `504`, and other upstream failures `502` or a retained native error. Native upstreams may return their own validation errors, including `422`; the gateway does not generate `422` for unavailable translation features. Errors use each client's envelope: Exa `error`/`tag`, Tavily `detail.error`, Search1API `ok: false`/`error`/`message`, Firecrawl `success: false`/`error`, SearXNG `error`. Client cancellation aborts calls without triggering fallback.

## Cross-provider translation

Matching native providers support more options within scope. Across providers, the following mappings are implemented; additional options are ignored with the header above. Unavailable scores, costs, author metadata and generated outputs are not fabricated.

### SearXNG

- GET query parameters, POST `application/x-www-form-urlencoded` bodies, or an empty POST with URL parameters. Responses always use JSON; another `format` is ignored.
- `q`, `categories=general|news`, `numResults` (default 10), `language`, and `time_range`. Language codes such as `en-US` are normalized to two letters for translation. Language is sent to Search1API, SearXNG, Serper, Brave and Google; unsupported adapters ignore it. Language and time semantics depend on the backend.
- `pageNumber` aliases `pageno`. Non-default pagination, `engines`, safe-search levels and unsupported categories are ignored during translation. SearXNG bang/language query tokens are stripped when an ordinary search query remains. Native SearXNG retains pagination and engine selection. Engine names do not select gateway providers.
- Translated responses include `query`, `results[].title/url/content` and empty answer/infobox/suggestion arrays. Unknown totals, engine metadata and scores are omitted. Native results are not truncated to the gateway default.

For a SearXNG backend, configure `SEARXNG_BASE_URL` with the instance base and enable `json` under `search.formats` in its `settings.yml`.

### Exa

- Search: `query`, `numResults` (default 10), `category=news`, `includeDomains`, `excludeDomains`, `startPublishedDate`, and `endPublishedDate`. Other search types and categories are ignored during translation.
- `contents=false` returns search metadata. Text is requested with `contents.text=true` or `contents.text.maxCharacters`. Omitting `contents` attempts text enrichment with a 10,000-character limit, matching the tested SDK default. Missing or failed readers leave the search results usable and add a warning; snippets are not relabeled as full text or highlights.
- Contents: 1–10 explicit `urls`, optional `text=true|false` or `text.maxCharacters`. Per-URL failures appear in `statuses`.
- Unsupported nested content options, highlights and beta features are ignored during translation. Summaries, streaming and recursive subpages are ignored even on native routes.

### Tavily

- Search: `query`, `max_results` (default 5), `topic=general|news`, `include_domains`, `exclude_domains`, `time_range`, `start_date`, `end_date`, and two-letter `country` where the backend supports them.
- `include_raw_content=true|markdown|text` attempts page reads for all returned results. Missing content is `null` and reported in the warning header; it does not fail the search.
- Extract: one URL or up to 10 explicit `urls`, with Markdown output. Unsupported depth/format options are ignored. Successes appear in `results`, failures in `failed_results`; HTTP 200 can contain only per-URL failures, matching this method's contract.
- Advanced search options, images and usage fields are ignored during translation. Generated answers are ignored on native routes as well.

### Search1API

- Search/news: `query`, `max_results` (default 5), `crawl_results` (default 0, clamped to 10), `include_sites`, `exclude_sites`, `language`, and `time_range`.
- Requested text is enriched where possible; unavailable or failed page reads produce warnings while retaining search results.
- Single-page crawl: `url`, optional `enableFallback`. Setting it to `false` restricts the attempt to the first crawl provider.
- Response envelopes retain `searchParameters`/`crawlParameters` and `results`, including available `link`, `snippet`, `content`, and `published_date`.
- Engine selection (`search_service`), pagination, images and other unavailable options are ignored during translation. `search_service` is not a gateway provider override. Search/news request arrays remain outside the supported request envelope.

### Firecrawl — single-page scrape

- `url`, Markdown `formats` (default `['markdown']`), SDK attribution `origin`.
- Returns `success`, `data.markdown`, available links and `data.metadata.title/sourceURL`.
- HTML, raw HTML and links formats pass through to native Firecrawl. Across providers, unsupported formats fall back to Markdown with a warning; Markdown is never mislabeled as HTML. Page-specific options are ignored if unavailable.
- Browser actions, screenshots and generated formats are ignored, including native calls. If no supported format remains, Markdown is requested. Separate `/crawl`, `/map`, batch and job routes return `404`.

Domain inclusion uses native fields or `site:` operators; exclusions use `-site:` operators. Absolute date filters map to Exa, Tavily and Brave; other adapters ignore them with a header. Recency and language mappings use the backend's available semantics rather than promising exact equivalence.

Explicit URL lists are limited to 10, translated reads run with concurrency 4, request bodies are limited to 256 KiB, and native responses to 4 MiB. Positive integer search limits are clamped in translated mode to the selected adapter's limit: Tavily/Brave 20, Google 10, others 50, with a warning. Invalid types, nonpositive counts and malformed URLs still fail validation.

## Existing SDK examples

These use a gateway key and API base; upstream credentials are configured on the gateway. The gateway needs suitable search/news/crawl providers for the selected methods.

```ts
import Exa from 'exa-js';

const exa = new Exa(process.env.GATEWAY_KEY, 'https://gateway.example.com/compat/exa');
const search = await exa.search('AI agent frameworks');
const pages = await exa.getContents(['https://example.com/article'], { text: true });
```

```ts
import { tavily } from '@tavily/core';

const client = tavily({
  apiKey: process.env.GATEWAY_KEY,
  apiBaseURL: 'https://gateway.example.com/compat/tavily',
});
const search = await client.search('AI agent frameworks');
const pages = await client.extract(['https://example.com/article']);
```

```ts
import { Search1API } from '@search1api/client';

const client = new Search1API({
  apiKey: process.env.GATEWAY_KEY,
  baseUrl: 'https://gateway.example.com/compat/search1api',
});
const search = await client.search('AI agent frameworks');
const news = await client.news('AI agents');
const page = await client.crawl('https://example.com/article');
```

```ts
import Firecrawl from '@mendable/firecrawl-js';

const client = new Firecrawl({
  apiKey: process.env.GATEWAY_KEY,
  apiUrl: 'https://gateway.example.com/compat/firecrawl',
});
const page = await client.scrape('https://example.com/article', { formats: ['markdown'] });
```

```ts
import { SearxngSearch } from '@langchain/community/tools/searxng_search';

const search = new SearxngSearch({
  apiBase: 'https://gateway.example.com/compat/searxng',
  headers: { Authorization: `Bearer ${process.env.GATEWAY_KEY}` },
});
const result = await search.invoke('AI agent frameworks');
```

## Verification

Tested with `exa-js@2.26.0`, `@tavily/core@0.7.14`, `@search1api/client@0.4.0`, `@mendable/firecrawl-js@4.50.1`, and SearXNG via `@langchain/community@1.1.29` with `@langchain/core@1.1.38`. This records tested versions, not a guarantee for all past or future versions.

The SDK smoke check runs unchanged SDK methods over a real localhost HTTP server mounted under path prefixes. It verifies request routes, authentication and response parsing in both native and translated modes. Upstreams are mocked: no paid key is needed, and this does not verify live upstream availability or search quality. SDK packages are isolated from runtime dependencies:

```bash
npm ci
npm install --prefix tests/sdk --ignore-scripts --legacy-peer-deps --no-package-lock
npm run test:sdk
```

`--legacy-peer-deps` avoids unrelated optional LangChain integrations resolving conflicting peer versions; the SearXNG test uses the explicitly pinned compatible core version. The LangChain package currently carries a deprecation notice; it is retained here to verify an existing integration, not recommended as a new application dependency.

Run `npm run typecheck`, `npm test` and `npm run build` for the main checks.
