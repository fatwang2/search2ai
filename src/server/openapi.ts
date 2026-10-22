/**
 * 从 zod schema 生成 OpenAPI 3.1 文档, 供 /openapi.json 使用。
 */
import { z } from 'zod';
import {
  CrawlRequestSchema,
  CrawlResponseSchema,
  ErrorResponseSchema,
  SearchRequestSchema,
  SearchResponseSchema,
} from '../core/schema.ts';

const json = (schema: z.ZodType) => z.toJSONSchema(schema, { target: 'openapi-3.0', unrepresentable: 'any' });

export function buildOpenApi(opts: { version: string; serverUrl?: string; chatProxy: boolean; secured: boolean }): Record<string, unknown> {
  const security = opts.secured ? [{ bearerAuth: [] }] : [];
  const errorRef = { $ref: '#/components/schemas/ErrorResponse' };
  const errorResponses = {
    '400': { description: 'Invalid request', content: { 'application/json': { schema: errorRef } } },
    '401': { description: 'Unauthorized', content: { 'application/json': { schema: errorRef } } },
    '502': { description: 'All providers failed', content: { 'application/json': { schema: errorRef } } },
    '503': { description: 'No provider configured', content: { 'application/json': { schema: errorRef } } },
  };
  const searchOp = (summary: string, description: string, tag: string) => ({
    summary,
    description,
    tags: [tag],
    security,
    requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/SearchRequest' } } } },
    responses: {
      '200': { description: 'Search results', content: { 'application/json': { schema: { $ref: '#/components/schemas/SearchResponse' } } } },
      ...errorResponses,
    },
  });

  const paths: Record<string, unknown> = {
    '/v1/search': {
      post: searchOp(
        'Web search',
        'Search using the gateway request and response format. Each query tries configured providers in order; skipped providers are listed in `warnings`.',
        'search'
      ),
    },
    '/v1/news': { post: searchOp('News search', 'Same request and response shape as /v1/search, using the configured provider news capability. Google approximates this with date-sorted web search.', 'search') },
    '/v1/crawl': {
      post: {
        summary: 'Fetch page content',
        tags: ['crawl'],
        security,
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CrawlRequest' } } } },
        responses: {
          '200': { description: 'Extracted page content', content: { 'application/json': { schema: { $ref: '#/components/schemas/CrawlResponse' } } } },
          ...errorResponses,
        },
      },
    },
    '/v1/health': {
      get: {
        summary: 'Health and configured providers',
        tags: ['meta'],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/mcp': {
      post: {
        summary: 'MCP endpoint (Streamable HTTP)',
        description: 'Model Context Protocol server exposing search, news and crawl tools.',
        tags: ['mcp'],
        security,
        responses: { '200': { description: 'MCP response' } },
      },
    },
  };
  const compatibility = (protocol: string, summary: string, schema: Record<string, unknown>, form = false) => ({
    summary,
    description: 'Client protocol compatibility for search and explicitly specified pages only. Matching upstreams preserve native payloads; translation accepts a smaller, documented subset and rejects unsupported options with 422. No recursive crawling or asynchronous jobs.',
    tags: [`compat/${protocol}`],
    security: opts.secured ? protocol === 'exa' ? [{ exaKey: [] }, { bearerAuth: [] }] : [{ bearerAuth: [] }] : [],
    requestBody: { required: true, content: { [form ? 'application/x-www-form-urlencoded' : 'application/json']: { schema } } },
    responses: Object.fromEntries([
      ['200', 'Protocol response; Exa contents and Tavily extract can contain per-URL failures'],
      ['400', 'Invalid request'], ['401', 'Gateway authentication failed'], ['404', 'Unsupported route'],
      ['422', 'No configured upstream can honor these options'], ['429', 'Native upstream rate limit'],
      ['502', 'Upstream failure'], ['503', 'No provider configured'], ['504', 'Upstream timeout'],
    ].map(([status, description]) => [status, { description }])),
  });
  const object = (required: string[], properties: Record<string, unknown>) => ({ type: 'object', required, properties, additionalProperties: true });
  const query = { type: 'string', minLength: 1, maxLength: 2000 };
  const url = { type: 'string', format: 'uri', description: 'Absolute HTTP(S) URL' };
  const urls = { type: 'array', items: url, minItems: 1, maxItems: 10 };
  for (const [protocol, path, schema] of [
    ['exa', '/search', object(['query'], { query, numResults: { type: 'integer', minimum: 1, maximum: 50 }, contents: { description: 'Native contents options; translated mode supports text and text.maxCharacters, not highlights or summary' } })],
    ['exa', '/contents', object(['urls'], { urls, text: { description: 'true or an object with maxCharacters in translated mode' } })],
    ['tavily', '/search', object(['query'], { query, max_results: { type: 'integer', minimum: 1, maximum: 20 }, topic: { type: 'string', enum: ['general', 'news'] }, include_raw_content: { type: 'boolean' } })],
    ['tavily', '/extract', object(['urls'], { urls: { oneOf: [url, urls] } })],
    ['search1api', '/search', object(['query'], { query, max_results: { type: 'integer', minimum: 1, maximum: 50 }, crawl_results: { type: 'integer', minimum: 0, maximum: 10 } })],
    ['search1api', '/news', object(['query'], { query, max_results: { type: 'integer', minimum: 1, maximum: 50 } })],
    ['search1api', '/crawl', object(['url'], { url, enableFallback: { type: 'boolean', default: true } })],
    ['firecrawl', '/v1/scrape', object(['url'], { url, formats: { type: 'array', items: { type: 'string' }, default: ['markdown'] } })],
    ['firecrawl', '/v2/scrape', object(['url'], { url, formats: { type: 'array', items: { type: 'string' }, default: ['markdown'] } })],
  ] as const) paths[`/compat/${protocol}${path}`] = { post: compatibility(protocol, `${protocol} ${path}`, schema) };
  const searxSchema = object(['q'], {
    q: query, format: { type: 'string', enum: ['json'], default: 'json' },
    categories: { type: 'string', description: 'general/news in translated mode; native categories depend on SearXNG' },
    language: { type: 'string' }, pageno: { type: 'integer', minimum: 1, default: 1 },
    engines: { type: 'string', description: 'SearXNG engine names, not gateway providers; native upstream required' },
    time_range: { type: 'string', enum: ['day', 'month', 'year'] }, safesearch: { type: 'integer', enum: [0, 1, 2] },
  });
  const { requestBody: _body, ...searxGet } = compatibility('searxng', 'SearXNG JSON search', searxSchema, true);
  for (const path of ['/compat/searxng', '/compat/searxng/', '/compat/searxng/search']) paths[path] = {
    get: { ...searxGet, parameters: Object.entries(searxSchema.properties).map(([name, schema]) => ({ name, in: 'query', required: name === 'q', schema })) },
    post: { ...compatibility('searxng', 'SearXNG JSON search (form or empty body with query parameters)', searxSchema, true), requestBody: { required: false, content: { 'application/x-www-form-urlencoded': { schema: searxSchema } } }, parameters: Object.entries(searxSchema.properties).map(([name, schema]) => ({ name, in: 'query', required: false, schema })) },
  };
  if (opts.chatProxy) {
    paths['/v1/chat/completions'] = {
      post: {
        summary: 'OpenAI-compatible chat completions with web search tools injected (legacy mode)',
        tags: ['chat'],
        security,
        responses: { '200': { description: 'Chat completion (JSON or SSE)' } },
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'search2ai',
      version: opts.version,
      description: 'Self-hosted search gateway for AI agents. Search, news and page extraction across configured providers with fallback.',
    },
    servers: opts.serverUrl ? [{ url: opts.serverUrl }] : undefined,
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' }, exaKey: { type: 'apiKey', in: 'header', name: 'x-api-key' } },
      schemas: {
        SearchRequest: json(SearchRequestSchema),
        SearchResponse: json(SearchResponseSchema),
        CrawlRequest: json(CrawlRequestSchema),
        CrawlResponse: json(CrawlResponseSchema),
        ErrorResponse: json(ErrorResponseSchema),
      },
    },
  };
}
