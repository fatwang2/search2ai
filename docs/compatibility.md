# Client API compatibility

[简体中文](compatibility.zh-CN.md)

**Available since v0.3.1.** Upgrade with `npm install search2ai@latest`.

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

The protocol does not select the backend. The existing `SEARCH_SERVICE`, `NEWS_SERVICE`, and `CRAWL_SERVICE` chains determine the attempt order. No configured provider means `503`, with no default outbound call.

- **Matching upstream:** when a chain reaches the matching provider, requests and responses retain native fields, metadata, scores and costs actually returned by that upstream. Gateway credentials are replaced with configured upstream credentials. Validation of native options is performed by the upstream, subject to the single-page scope and limits below. Exa's `Exa-Beta` header is preserved for native Exa calls.
- **Another upstream:** only the subset below is translated. Unsupported options skip that provider without a request. A later matching provider can still handle the native options. When none can, the gateway returns `422`.
- **Failures:** upstream failures can continue to another provider only when that provider can honor the request. A native error is retained if no fallback succeeds. Successful empty responses are returned as-is unless `FALLBACK_ON_EMPTY=true`; this policy also applies to native calls. Native responses bypass normalized result caching; translated calls use the core cache.
- **Scope:** search and explicitly given page URLs only. No recursive discovery, whole-site crawl, crawl jobs, polling, cancellation endpoints, webhooks, screenshots, browser actions, generated answers or structured extraction.

`X-Search2AI-Mode` is `native` or `translated`. `X-Search2AI-Provider` lists providers actually used; content enrichment can use another provider. `X-Search2AI-Skipped` lists skipped attempts. These headers keep gateway routing information outside the original response schema.

Native calls preserve the upstream's error status and payload. Gateway errors use the client protocol's envelope: Exa `error`/`tag`, Tavily `detail.error`, Search1API `ok: false`/`error`/`message`, Firecrawl `success: false`/`error`, SearXNG `error`. Invalid requests return `400`, authentication failures `401`, unsupported translation `422`, missing providers `503`, native timeouts `504`. Other upstream failures may return `502` or a retained native error. Client cancellation aborts provider calls and does not trigger fallback.

## Supported translation subset

The following describes **cross-provider translation**. Matching native providers can handle additional options within scope. Unknown or meaningful unsupported fields are rejected, rather than silently discarded. Conventional disabled/empty defaults are accepted where they make no additional capability request.

### SearXNG — priority integration

- JSON output only; `format=json`, or omit it. No HTML interface, CSV or RSS.
- GET query parameters and POST `application/x-www-form-urlencoded` bodies; an empty POST with URL parameters also works.
- `q`, `categories=general|news`, page 1, and two-letter `language` codes. The language filter requires Search1API or SearXNG.
- Existing LangChain JS parameters `numResults` (1–50), `pageNumber` (alias for `pageno`), `imageProxy=true` and `safesearch=0` are accepted. `numResults` limits translated searches; the client can also limit the returned list. `imageProxy` has no effect on JSON page results.
- SearXNG bang/language query syntax, page 2+, nonempty `engines`, `time_range`, and safe-search levels 1/2 require a native SearXNG backend. Engine names such as `google` refer to SearXNG engines, not gateway providers. Unsupported pagination never repeats page 1.
- Translated responses include `query`, `results[].title/url/content` and empty answer/infobox/suggestion arrays. They omit unknown total counts, engine names and scores. Native responses retain all original metadata and pagination fields without a gateway default-10 truncation.

If SearXNG is the backend, configure `SEARXNG_BASE_URL` with the instance base, and enable `json` under `search.formats` in its `settings.yml`.

### Exa

- Search: `query`, `numResults` (1–50, default 10), `type=auto`, optional `category=news`.
- `contents=false` returns search metadata. Otherwise, text contents are supported with `contents.text=true` or `contents.text.maxCharacters`. Omitting `contents` follows the tested SDK's default: fetch text, truncated to 10,000 characters. This requires a crawl provider and adds page reads.
- Contents: 1–10 explicit `urls`, optional `text=true` or `text.maxCharacters`. Per-URL failures appear in `statuses`.
- Highlights, domain/date filters, other search modes, beta options and summaries need a matching native upstream or are outside scope. A snippet is never labeled as an Exa highlight. Subpage crawling is rejected even with an Exa upstream.
- Translated results include `id`, `url`, `title`, and available `text`/`publishedDate`; scores, author metadata and `costDollars` are not fabricated.

### Tavily

- Search: `query`, `max_results` (1–20, default 5), `topic=general|news`, optional `include_raw_content=true|markdown`. Requested raw content requires a crawl provider and is read for every returned result.
- Extract: one URL or up to 10 explicit `urls`, basic depth and Markdown output. Successes appear in `results`, failures in `failed_results`; HTTP 200 can contain only per-URL failures, matching this method's contract.
- Advanced search/extraction, filters and HTML output require the matching upstream. Generated answers are outside scope. Translated results omit unavailable scores and usage. Applications that depend on these values must use an upstream that actually provides them.

### Search1API

- Search/news: `query`, `max_results` (1–50, default 5), `crawl_results` (0–10, default 0). Requested content is required, not replaced with a success response that only has a warning.
- Single-page crawl: `url`, optional `enableFallback`. Setting it to `false` restricts the attempt to the first crawl provider.
- Response envelopes retain `searchParameters`/`crawlParameters` and `results`, including `link`, `snippet`, `content`, and available `published_date`.
- Nonempty `search_service`, page 2+, language/time/domain filters and images require native Search1API. `search_service` is its engine selector, not a gateway provider override. Search/news request arrays and other Search1API methods are outside this initial coverage.

### Firecrawl — single-page scrape only

- `url`, Markdown `formats` (default `['markdown']`), SDK attribution `origin`.
- Returns `success`, `data.markdown` and available `data.metadata.title/sourceURL`.
- Explicit main-content filtering, HTML, links and other page-specific options need a native Firecrawl provider. Browser actions, screenshots and generated output formats are rejected even with Firecrawl configured.
- No `/crawl`, `/map`, batch jobs or task endpoints. A request to those routes returns `404` and does not execute a single-page scrape instead.

All explicit URL lists are limited to 10, translated reads run with concurrency 4, and request bodies are limited to 256 KiB, and native upstream responses to 4 MiB. Search result limits are also constrained by the selected provider: for example, translated Tavily/Brave queries accept at most 20 and Google 10. Configure a provider that supports the requested count rather than expecting silent clamping.

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
