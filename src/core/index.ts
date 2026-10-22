/**
 * search2ai/core: 零框架依赖的搜索网关核心。
 *
 * ```ts
 * import { createGateway } from 'search2ai/core';
 * const gateway = createGateway({ providers: { search1api: { apiKey: '...' }, tavily: { apiKey: '...' } } });
 * const { results, provider } = await gateway.search({ query: 'hono cloudflare workers' });
 * ```
 */
export { createGateway, type Gateway } from './gateway.ts';
export { configFromEnv, parseList, type GatewayConfig, type Env } from './config.ts';
export { GatewayError, ProviderError, codeFromStatus, toProviderError } from './errors.ts';
export { runChain, type ChainOptions, type ChainResult } from './fallback.ts';
export { MemoryCache, kvCache, type KVLike } from './cache.ts';
export {
  providerFactories,
  defaultPriority,
  createProvider,
  isProviderName,
  capabilitiesOf,
  describeProvider,
  createBrave,
  createExa,
  createFirecrawl,
  createGoogle,
  createJina,
  createSearch1api,
  createSearxng,
  createSerpapi,
  createSerper,
  createTavily,
  type ProviderName,
  type ProviderOptionsMap,
  type BraveOptions,
  type ExaOptions,
  type FirecrawlOptions,
  type GoogleOptions,
  type JinaOptions,
  type Search1apiOptions,
  type SearxngOptions,
  type SerpapiOptions,
  type SerperOptions,
  type TavilyOptions,
} from './providers/index.ts';
export {
  SearchRequestSchema,
  CrawlRequestSchema,
  SearchResponseSchema,
  CrawlResponseSchema,
  SearchResultSchema,
  ProviderWarningSchema,
  ErrorResponseSchema,
  RecencyFilterSchema,
  type SearchRequestInput,
  type CrawlRequestInput,
} from './schema.ts';
export { fetchJson, toIsoDate, cleanText, withSiteFilter } from './http.ts';
export type * from './types.ts';
export type { ClientProtocol, ProtocolRequest } from './protocol.ts';
