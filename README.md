**English** · [简体中文](README-ZH.md)

# search2ai

**A self-hosted search gateway for AI agents and AI clients.**

Connect the search and page extraction services you configure through **MCP, an HTTP API, or a JavaScript / TypeScript library**. When a provider is rate limited, times out, or fails, the gateway tries the next one in your configured order and reports which service answered and why others failed.

Search endpoints return structured results and page content for your agent or application to use. An optional **chat proxy** also lets models that support tool calling search the web while answering.

- **Consistent results**: `title`, `url`, `snippet`, and optional fields such as `date` and `content`.
- **Search, news, and page content**: `search`, `news`, and `crawl`, depending on the configured providers.
- **Your choice of providers**: supply service URLs or credentials as needed; unconfigured providers are never enabled automatically.
- **Fallback and caching**: separate chains per operation, in-memory caching, and Cloudflare KV caching.
- **Flexible integration**: local MCP, a standalone HTTP service, direct library calls, and mountable Hono routes.
- **Existing API clients**: supported Exa, Tavily, Search1API, SearXNG and Firecrawl single-page calls can use dedicated [HTTP API / SDK compatibility endpoints](#compatibility).

**Looking for hosted search?** [Search1API](https://www.search1api.com/?utm_source=search2ai) is this project's companion hosted service for search, news, and page extraction. Use its API directly or configure it as a search2ai provider. The examples below use Search1API; you can choose any other [supported provider](#providers).

[Quick start](#quick-start) · [Choose an integration](#usage) · [Providers and configuration](#providers) · [HTTP API](#api) · [API / SDK compatibility](#compatibility) · [Deployment](#deployment) · [Chat proxy](#chat-proxy) · [Upgrading](#upgrading) · [Development and contributing](#development)

<a id="quick-start"></a>

## Quick start

The local CLI and npm package require **Node.js ≥ 22.18**. Configure at least one provider that supports the operation you need. In the current version, search requests return `503` when no search provider is configured.

Create `.env` in your working directory with your search provider key:

```dotenv
SEARCH1API_KEY=your_provider_key
```

Start a local HTTP service:

```bash
npx -y search2ai serve --host 127.0.0.1
```

Search from another terminal:

```bash
curl http://localhost:3014/v1/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"hono cloudflare workers","max_results":3}'
```

The response's `results` contain titles, URLs, and excerpts. This calls only the search provider and needs no model API key. The same service exposes `/v1/news`, `/v1/crawl`, and the remote MCP endpoint `/mcp`.

The CLI reads `.env.local` and `.env` from its working directory. Existing environment variables take priority, followed by `.env.local`, then `.env`. See [.env.template](.env.template) for the full configuration template.

<a id="usage"></a>

## Choose an integration

| Your use case | Integration | Who calls the model |
| --- | --- | --- |
| Give AI clients such as Claude Desktop or Cursor search tools | Local or remote MCP | The AI client |
| Supply search data to your agent, script, or backend | HTTP API or library | Your application, if needed |
| Add web access to a chat client with a custom API base URL | Optional chat proxy | search2ai calls your configured model upstream |

### For AI clients: MCP

For clients using the `mcpServers` configuration format, add:

```json
{
  "mcpServers": {
    "search2ai": {
      "command": "npx",
      "args": ["-y", "search2ai", "mcp"],
      "env": {
        "SEARCH1API_KEY": "your_provider_key"
      }
    }
  }
}
```

The client starts search2ai locally and accesses `search`, `news`, and `crawl` over stdio. Each tool needs a configured provider with the corresponding capability. Other MCP clients can use the same command, arguments, and environment variables in their own configuration format.

MCP uses one set of gateway tools with unified parameters and results across backends. Provider-specific compatibility endpoints are for existing HTTP API and SDK integrations; MCP clients use the gateway tools directly.

If you have deployed the HTTP service, connect a client that supports Streamable HTTP to `https://your-search2ai-host/mcp`. With `AUTH_KEYS` configured, the client also needs to send `Authorization: Bearer <gateway_key>`.

### For applications: HTTP API

Call `/v1/search`, `/v1/news`, and `/v1/crawl` on the standalone service to receive JSON data. See the [HTTP API](#api) for parameters and responses. The same service can serve applications over REST and AI clients over MCP at the same time.

### For applications: JavaScript / TypeScript library

```bash
npm i search2ai
```

```ts
import { createGateway } from 'search2ai/core';

const apiKey = process.env.SEARCH1API_KEY;
if (!apiKey) throw new Error('Set SEARCH1API_KEY before running this example.');

const gateway = createGateway({
  providers: {
    search1api: { apiKey },
  },
});

const { provider, results, warnings } = await gateway.search({
  query: 'hono cloudflare workers',
  max_results: 3,
});

console.log({ provider, results, warnings });
```

You can also call `gateway.news({ query })` and `gateway.crawl({ url })`. The library runs in your process, with no separate search gateway service to deploy.

`createGateway()` accepts explicit configuration. Alternatively, parse settings with `configFromEnv(env)` or import `createGatewayFromEnv(env)` from `search2ai/hono`. Library entry points do not load `.env` files; your application supplies the environment.

### Mount inside an existing Hono application

```ts
import { Hono } from 'hono';
import { createAppFromEnv } from 'search2ai/hono';

const app = new Hono();
app.route('/search', createAppFromEnv(process.env));

export default app;
```

This mounts routes such as `/search/v1/search`, `/search/v1/news`, `/search/v1/crawl`, and `/search/mcp`. The host application supplies the environment; on Workers, use the `env` passed to the request handler.

For regular chat clients, see the [chat proxy](#chat-proxy).

<a id="providers"></a>

## Providers and configuration

### Supported providers

Configure only the services you want to use. Keys usually come from the provider. SearXNG and self-hosted Firecrawl use your service URL; Jina can be explicitly enabled without a key.

| Provider | Search | News | Page extraction | Environment variables |
| --- | :-: | :-: | :-: | --- |
| `search1api` | ✓ | ✓ | ✓ | `SEARCH1API_KEY`; optional `SEARCH1API_SERVICE` selects the underlying engine |
| `tavily` | ✓ | ✓ | ✓ | `TAVILY_KEY` |
| `brave` | ✓ | ✓ | — | `BRAVE_KEY` |
| `exa` | ✓ | ✓ | ✓ | `EXA_KEY` |
| `serper` | ✓ | ✓ | — | `SERPER_KEY` |
| `serpapi` | ✓ | ✓ | — | `SERPAPI_KEY` |
| `google` | ✓ | Date-sorted¹ | — | `GOOGLE_KEY` + `GOOGLE_CX` |
| `searxng` | ✓ | ✓ | — | `SEARXNG_BASE_URL`, with JSON output enabled |
| `jina` | — | — | ✓ | `JINA_KEY`, or explicitly list `jina` in `CRAWL_SERVICE` |
| `firecrawl` | — | — | ✓ | `FIRECRAWL_KEY` or a self-hosted `FIRECRAWL_BASE_URL` |
| `parallel` | ✓ | — | Opt-in | No key; list `parallel` in `SEARCH_SERVICE`, and in `CRAWL_SERVICE` for page extraction |

¹ Google's `news` operation uses regular search with `sort=date`, not a dedicated news search endpoint.

All provider key variables above accept a `*_API_KEY` alias, such as `TAVILY_API_KEY`. The Google search engine ID also accepts `GOOGLE_CSE_ID`.

### Anonymous Parallel search

Run `npx search2ai mcp` or `npx search2ai serve` in a directory without provider settings to search immediately. Local `.env.local` and `.env` files are still loaded. To select Parallel explicitly, set `SEARCH_SERVICE=parallel`. Page extraction is opt-in with `CRAWL_SERVICE=parallel`. Set `SEARCH_SERVICE=none` to keep an installation with no provider keys from enabling search.

For the library, `createGateway()` selects the same search-only default. Explicit `createGateway({ providers: {} })` or an empty chain keeps search disabled. Configure `{ providers: { parallel: { crawl: true } } }` to opt into search and page extraction. Environment overrides that explicitly supply providers or chains also suppress the unconfigured default.

Parallel returns ranked excerpts and slices them to `max_results`; the anonymous service controls how many results it supplies. It does not implement `news` or strict country, language, domain or date filters. Such filter requests return an `unsupported` provider warning/error rather than silently ignoring the filters. Choose another configured provider when those features are needed. The free service is intended for exploration and light use and has rate limits; failures use the existing error/warning contract.

Search and crawl accept an optional opaque UUID `session_id`. Reuse the returned ID for related search, extraction, retries and follow-up calls in one conversation or research run; omit it for a new run or reset. Array queries and `crawl_results` enrichment share the run ID. Do not put personal data in it. Independent calls generate separate IDs even when they share a gateway. The chat proxy returns `X-Search2AI-Session-Id`; pass it back as `search_session_id` in later chat requests to continue that run. This field is consumed locally and is not forwarded to the model provider. A chat request without it starts a new research run. Library gateway methods also accept `{ signal }` as a second argument for cancellation.

### Configure fallback

For example, configure Search1API and Tavily and choose an order for each operation:

```dotenv
SEARCH1API_KEY=your_provider_key
TAVILY_KEY=your_backup_provider_key

SEARCH_SERVICE=search1api,tavily
NEWS_SERVICE=tavily,search1api
CRAWL_SERVICE=search1api,jina
```

This example also explicitly enables Jina as a fallback for page extraction. Each provider sets its own quotas, pricing, and usage limits.

- With no explicit chains, the gateway uses configured providers that support the operation, in the table's order.
- `SEARCH_SERVICE` sets the default chain. `NEWS_SERVICE` and `CRAWL_SERVICE` override it for news and extraction. Operations without an override inherit `SEARCH_SERVICE`, skipping providers without the required capability.
- Each query tries providers in order and returns the first success; it does not query every provider by default. Queries in an array run concurrently, then their results are merged and deduplicated.
- Auth failures, rate limits, HTTP errors, network errors, and timeouts trigger fallback, with reasons recorded in `warnings`.
- Empty results count as success unless `FALLBACK_ON_EMPTY=true`. If no provider finds results, the gateway can still return a successful empty response.
- A nonempty `providers` array overrides the order for one request, using only providers already configured in the gateway.

### Other settings

| Variable | Description |
| --- | --- |
| `MAX_RESULTS` | Default results per query: `10`; gateway maximum: `50` |
| `CRAWL_RESULTS` | Default number of top results to enrich with page content: `0`; maximum: `10` |
| `FALLBACK_ON_EMPTY` | Try the next provider on empty results; default: `false` |
| `PROVIDER_TIMEOUT_MS` | Timeout for each provider attempt in milliseconds; default: `15000` |
| `CACHE_TTL` | Search and extraction result cache lifetime in seconds; default: `0` (off) |
| `GL` / `HL` | Default country and language for providers whose adapters support these settings |
| `AUTH_KEYS` | Comma-separated bearer keys for gateway access, configured separately from provider credentials |
| `PORT` / `HOST` | Node listen port and address; defaults: `3014` / `0.0.0.0`; override with `--port` / `--host` |

With `AUTH_KEYS` set, search endpoints and `/mcp` require `Authorization: Bearer <gateway_key>`. `/`, `/v1/health`, and `/openapi.json` remain public. Without it, search endpoints require no authentication. Stdio MCP uses local process configuration and does not pass through HTTP bearer authentication.

A positive `CACHE_TTL` enables in-memory caching by default. On Workers, a KV namespace bound as `CACHE` switches to KV storage, with a minimum cache TTL of 60 seconds. Library users can also inject an implementation of the [`Cache`](src/core/types.ts) interface.

### Provider differences

The common interface standardizes calls and result fields. Filter support, result counts, and content quality still depend on the adapter and provider:

- Google returns at most 10 results per query; the current Brave and Tavily adapters cap results at 20. Other services can also return fewer results than requested.
- Some adapters use only the first requested language. Some implement domain filters through `site:` search operators.
- Time filters can be approximate, such as treating `hour` as a day. Currently, explicit date ranges are passed through by the Tavily, Brave, and Exa adapters.
- The current Exa adapter does not handle country or language filters; the Search1API adapter does not handle country or explicit date ranges. Unimplemented filters may be ignored without triggering fallback.

If your application needs strict filtering, select and verify a specific provider rather than relying on fallback across providers with different capabilities. See [`src/core/providers/`](src/core/providers) for the mappings.

<a id="api"></a>

## HTTP API

### Search: `POST /v1/search`

This is search2ai's stable unified HTTP interface. Its search fields originally followed the Perplexity Search API conventions, with gateway extensions; it does not promise full Perplexity compatibility. Choosing a backend does not change its format. Existing SDKs can use the separate [compatibility endpoints](#compatibility) available since v0.3.1.

| Field | Description |
| --- | --- |
| `query` | Required; a string or an array of up to 10 strings, each at most 2000 characters |
| `max_results` | Results per query, `1–50`, default `10`; provider limits apply, and merged array queries can exceed this count |
| `country` | Two-letter country code; support depends on the provider |
| `search_domain_filter` | Up to 20 domains |
| `search_language_filter` | Up to 20 two-letter language codes |
| `search_recency_filter` | `hour` / `day` / `week` / `month` / `year` |
| `search_after_date_filter` / `search_before_date_filter` | `YYYY-MM-DD` or `MM/DD/YYYY`; see provider differences for support |
| `max_tokens_per_page` | Approximate content truncation budget, estimated at 4 characters per token without a tokenizer |
| `search_type` | Only `web` is accepted; omitting it also performs web search |
| `providers` | Configured providers and attempt order for this request |
| `crawl_results` | Enrich the top `0–10` results with page content in `content`; default: `0` |

Example response after the first provider was rate limited and Tavily answered:

```json
{
  "object": "search",
  "id": "9f2c-example",
  "provider": "tavily",
  "results": [
    {
      "title": "Example article",
      "url": "https://example.com/article",
      "snippet": "An excerpt relevant to the query.",
      "date": "2026-09-01"
    }
  ],
  "warnings": [
    {
      "provider": "search1api",
      "code": "rate_limit",
      "message": "search1api: HTTP 429",
      "status": 429
    }
  ]
}
```

`provider` identifies the backend that returned search results. Array queries can use different backends, listed as comma-separated names. `warnings` appears for events such as fallback or failed content enrichment. `cached: true` indicates a cache hit. Fields such as `date`, `last_updated`, and `content` are optional and depend on the returned data.

`crawl_results` can add provider calls and costs. Extraction failures preserve search results and add a warning. `max_tokens_per_page` approximately truncates page content; it does not cap snippets or the entire response.

### News and page content

- `POST /v1/news`: the same parameters and response structure as search, using each provider's news capability or approximation. See the table for the Google exception.
- `POST /v1/crawl`: send `{ "url": "https://example.com/article" }`, optionally with a `providers` array. The response includes `object: "crawl"`, `id`, `provider`, `url`, `content`, and optional `title`, `links`, `warnings`, and `cached` fields.

<a id="compatibility"></a>

### HTTP API and SDK compatibility

Available since **v0.3.1**: dedicated bases for **SearXNG**, Exa, Tavily, Search1API, and Firecrawl single-page scrape. Upgrade with `npm install search2ai@latest`.

These adapters translate HTTP request parameters, authentication, response fields and errors for existing API clients and SDKs. MCP continues to expose the gateway's unified `search`, `news` and `crawl` tools across all configured backends.

| API base | Supported routes |
| --- | --- |
| `/compat/searxng` | GET/POST `/` and `/search`, JSON output |
| `/compat/exa` | POST `/search`, `/contents` |
| `/compat/tavily` | POST `/search`, `/extract` |
| `/compat/search1api` | POST `/search`, `/news`, `/crawl` |
| `/compat/firecrawl` | POST `/v2/scrape`, `/v1/scrape`; single page only |

Keep supported SDK calls and response parsing, and replace the API base and gateway credentials. Backend selection still follows the configured chains. Matching upstreams preserve native fields; translation to other backends maps available options and ignores unsupported ones, with response headers reporting adjustments. There is no strict rejection mode. Whole-site crawling and task APIs are outside scope.

See the [compatibility guide](docs/compatibility.md) for SDK examples, authentication, supported fields, errors, limits and tested client versions. SearXNG uses query parameters or form data rather than the JSON requests of `/v1/search`.

### Service information and errors

| Endpoint | Description |
| --- | --- |
| `GET /` | Version, configured providers, operation chains, and available endpoints |
| `GET /v1/health` | Service status and the same configuration information; does not probe provider availability |
| `GET /openapi.json` | OpenAPI 3.1 document |
| `/mcp` | MCP Streamable HTTP endpoint, accessed through an MCP client |

Errors from `/v1/*` have the shape `{ "error": { "message", "type", "code", "warnings?", "issues?" } }`, where `code` is the HTTP status. Common statuses: `400` for invalid parameters, `401` for failed gateway authentication, `502` when all available providers fail, and `503` when no configured provider supports the operation. Compatibility routes use their client protocol's error envelope.

<a id="deployment"></a>

## Deployment

### Node.js

You can use `npx -y search2ai serve` as in the quick start. To run from source:

```bash
git clone https://github.com/fatwang2/search2ai.git
cd search2ai
npm ci
cp .env.template .env
```

Edit `.env` with your provider settings, then build and start:

```bash
npm run build
npm start
```

The production entry point is `dist/cli.js`, listening on `0.0.0.0:3014` by default. Use `npm run dev` for development.

### Docker

From the repository root, with `.env` prepared:

```bash
docker build -t search2ai .
docker run --rm -p 3014:3014 --env-file .env search2ai
```

The container receives settings through `--env-file`. In-memory caches are cleared when the container restarts.

### Cloudflare Workers

From the repository root, install dependencies, add your chosen provider key as a Workers secret, and deploy:

```bash
npm ci
npx wrangler secret put SEARCH1API_KEY
npm run deploy
```

See [wrangler.toml](wrangler.toml), with [`src/worker.ts`](src/worker.ts) as the entry point. Workers receive variables and bindings through `env`; local CLI `.env` files do not automatically become production secrets. Configure `AUTH_KEYS` if you need gateway authentication. See [other settings](#providers) for the KV binding and `CACHE_TTL`.

Other Node hosting platforms can use the same build and start commands or Dockerfile. search2ai needs a backend runtime: `dist` contains server code, not a static website.

<a id="chat-proxy"></a>

## Optional: web access for chat clients

The original chat proxy remains available for clients with a custom OpenAI-compatible API base URL, such as NextChat, Cherry Studio, and Chatbox. **The upstream model must support `tools` / tool calling** and decides whether to search.

Configure a search provider, model upstream, and gateway access key in `.env`:

```dotenv
SEARCH1API_KEY=your_provider_key
APIBASE=https://api.openai.com/v1
OPENAI_API_KEY=your_model_key
AUTH_KEYS=your_gateway_key
```

Run `npx -y search2ai serve`, then set the chat client's:

- API Base URL to `http://localhost:3014/v1`, or your deployment URL plus `/v1`.
- API key to `your_gateway_key` from this example.
- Model to one provided by your upstream that supports tool calling.

search2ai supplies the available `search`, `news`, and `crawler` tools to the model, executes requested searches or extraction, and returns the data to the model to compose an answer. **This path uses both search and model services, which may incur separate costs.**

- Responses can stream, including the final answer after a search. Regular REST / MCP search calls still return data without generating an answer.
- `APIBASE` is the full upstream prefix, including its required version segment. `CHAT_PROXY=true` also enables the proxy with the default upstream address.
- With `AUTH_KEYS` configured, clients send a gateway key and the upstream uses `OPENAI_API_KEY`. Without `AUTH_KEYS`, the request key is used directly for the model upstream; setting `OPENAI_API_KEY` alone does not replace it.
- Azure uses `OPENAI_TYPE=azure`, `RESOURCE_NAME`, `DEPLOY_NAME`, `API_VERSION`, and `AZURE_API_KEY`; this mode also enables the proxy.
- Client tools are merged, and parameters such as `temperature` and `response_format` are preserved. Client tools remain the client's responsibility. Use `tool_choice: "none"` to disable model tool calls.
- Search tools are currently not injected when the latest user message has an array-valued `content`, including common multimodal message formats.
- Other `/v1/*` paths, such as `/v1/models`, embeddings, and audio, are forwarded to the model upstream. Actual support depends on that upstream.

<a id="upgrading"></a>

## Upgrading from older versions

v0.3 expands the original chat proxy into a search gateway that can be used independently, while retaining familiar model and search environment variables. Check these settings when upgrading:

- **Startup**: use `npx -y search2ai serve` for the npm package, or `npm run build && npm start` from source.
- **Workers entry point**: use `src/worker.ts` and `wrangler.toml`; the old single-file scripts are no longer the current deployment entry points.
- **Model upstream**: ensure `APIBASE` includes the full version prefix, such as `/v1`. Setting it enables the chat proxy; the other activation methods above are also available.
- **Search order**: `SEARCH_SERVICE` accepts a comma-separated fallback chain. Set `NEWS_SERVICE` and `CRAWL_SERVICE` separately when needed.
- **Removed providers**: `bing` and `duckduckgo` are no longer standalone providers and are skipped in environment-configured chains. Replace them if they are the only entries left. Search1API's underlying engine selection is a separate setting.

<a id="development"></a>

## Development and contributing

```bash
npm ci
npm run typecheck
npm test
npm run build
```

For local development, copy `.env.template` to `.env`, fill in your settings, and run `npm run dev`. For live end-to-end checks, copy `.env.local.example` to `.env.local`, fill in test credentials, and run `npm run test:e2e`. It calls real search services and optionally a model upstream.

Main entry points:

- [`src/core/`](src/core): configuration, normalization, fallback, caching, and provider adapters.
- [`src/server/app.ts`](src/server/app.ts): HTTP routes; [`src/mcp/server.ts`](src/mcp/server.ts): MCP tools.
- [`src/chat/`](src/chat): the optional chat proxy.
- [`tests/`](tests): provider mappings, fallback, HTTP, MCP, and chat proxy checks.

Issues and PRs are welcome. To add a provider, implement [`SearchProvider`](src/core/types.ts), update provider registration, environment configuration, and public exports, and add tests. Document the operations, filters, and limits it actually supports. Please keep both README languages in sync when changing usage.

<a id="roadmap"></a>

## Future directions

In-memory and Workers KV caching, per-operation fallback chains, and result deduplication are already available. Next areas of work:

- **Client API compatibility**: v0.3.1 includes the first SearXNG, Exa, Tavily, Search1API and Firecrawl single-page adapters. Expand cross-provider field coverage and client validation based on actual migration needs. Protocol choice remains separate from backend routing.
- **Reliability and operations**: multiple keys per provider, circuit breaking and health probes, Redis cache integration, and usage logging.
- **Search aggregation**: parallel searches across providers with result merging.

## Community and support

Follow [@fatwang2ai on X](https://x.com/fatwang2ai) for updates and discussion.

[MIT License](LICENSE)
