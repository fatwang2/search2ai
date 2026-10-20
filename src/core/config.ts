/**
 * 网关配置: 代码里直接传对象, 或用 configFromEnv 从环境变量解析(兼容 0.2.x 的变量名)。
 */
import type { ProviderOptionsMap } from './providers/index.ts';
import type { Cache, Operation } from './types.ts';

export interface GatewayConfig {
  /** 各 provider 的凭据与选项, 只配置需要的 */
  providers: Partial<ProviderOptionsMap>;
  /** 默认 fallback 顺序(所有操作共用); 未指定则按已配置 provider 的默认优先级 */
  chain?: string[];
  /** 按操作覆盖 fallback 顺序 */
  chains?: Partial<Record<Operation, string[]>>;
  /** 默认返回条数, 默认 10 */
  maxResults?: number;
  /** 默认对前 N 条抓取正文, 默认 0 */
  crawlResults?: number;
  /** 空结果也切换下一家, 默认 false */
  fallbackOnEmpty?: boolean;
  /** 单个 provider 超时(毫秒), 默认 15000 */
  timeoutMs?: number;
  /** 自定义 fetch(测试或代理) */
  fetch?: typeof fetch;
  /** 结果缓存; 未提供且 cacheTtlSeconds > 0 时使用进程内缓存 */
  cache?: Cache;
  /** 缓存秒数, 默认 0(关闭) */
  cacheTtlSeconds?: number;
}

export type Env = Record<string, string | undefined>;

function pick(env: Env, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = env[n];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

export function parseList(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  const items = v
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return items.length ? items : undefined;
}

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function bool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/**
 * 支持的环境变量:
 * - SEARCH_SERVICE / NEWS_SERVICE / CRAWL_SERVICE: 逗号分隔的 provider 顺序
 * - SEARCH1API_KEY(+SEARCH1API_SERVICE), TAVILY_KEY, BRAVE_KEY, EXA_KEY, SERPER_KEY, SERPAPI_KEY,
 *   GOOGLE_KEY + GOOGLE_CX, SEARXNG_BASE_URL, JINA_KEY, FIRECRAWL_KEY / FIRECRAWL_BASE_URL
 *   (以上 *_KEY 也接受 *_API_KEY 写法)
 * - MAX_RESULTS, CRAWL_RESULTS, GL, HL, FALLBACK_ON_EMPTY, PROVIDER_TIMEOUT_MS, CACHE_TTL
 */
export function configFromEnv(env: Env, options: { defaultSearch?: boolean } = {}): GatewayConfig {
  const gl = pick(env, 'GL');
  const hl = pick(env, 'HL');
  const chain = parseList(pick(env, 'SEARCH_SERVICE'));
  const newsChain = parseList(pick(env, 'NEWS_SERVICE'));
  const crawlChain = parseList(pick(env, 'CRAWL_SERVICE'));
  const mentioned = new Set([...(chain ?? []), ...(newsChain ?? []), ...(crawlChain ?? [])]);

  const providers: Partial<ProviderOptionsMap> = {};

  const search1api = pick(env, 'SEARCH1API_KEY', 'SEARCH1API_API_KEY');
  if (search1api) providers.search1api = { apiKey: search1api, searchService: pick(env, 'SEARCH1API_SERVICE') };

  const tavily = pick(env, 'TAVILY_KEY', 'TAVILY_API_KEY');
  if (tavily) providers.tavily = { apiKey: tavily };

  const brave = pick(env, 'BRAVE_KEY', 'BRAVE_API_KEY');
  if (brave) providers.brave = { apiKey: brave, country: gl?.toUpperCase(), searchLang: hl };

  const exa = pick(env, 'EXA_KEY', 'EXA_API_KEY');
  if (exa) providers.exa = { apiKey: exa };

  const serper = pick(env, 'SERPER_KEY', 'SERPER_API_KEY');
  if (serper) providers.serper = { apiKey: serper, gl, hl };

  const serpapi = pick(env, 'SERPAPI_KEY', 'SERPAPI_API_KEY');
  if (serpapi) providers.serpapi = { apiKey: serpapi, gl, hl };

  const googleKey = pick(env, 'GOOGLE_KEY', 'GOOGLE_API_KEY');
  const googleCx = pick(env, 'GOOGLE_CX', 'GOOGLE_CSE_ID');
  if (googleKey && googleCx) providers.google = { apiKey: googleKey, cx: googleCx, gl, hl };

  const searxng = pick(env, 'SEARXNG_BASE_URL');
  if (searxng) providers.searxng = { baseUrl: searxng, language: hl };

  // 抓取类 provider 可免 key 使用, 但只有显式配置(key 或写进链里)才启用, 不做默认外呼
  const jinaKey = pick(env, 'JINA_KEY', 'JINA_API_KEY');
  if (jinaKey || mentioned.has('jina')) providers.jina = { apiKey: jinaKey };

  const firecrawlKey = pick(env, 'FIRECRAWL_KEY', 'FIRECRAWL_API_KEY');
  const firecrawlBase = pick(env, 'FIRECRAWL_BASE_URL');
  if (firecrawlKey || firecrawlBase || mentioned.has('firecrawl')) providers.firecrawl = { apiKey: firecrawlKey, baseUrl: firecrawlBase };

  // Explicit configuration always wins. An empty installation gets search only;
  // unlike search, keyless page fetching must still be explicitly enabled.
  if (mentioned.has('parallel')) providers.parallel = { crawl: crawlChain?.includes('parallel') ?? false };
  if (options.defaultSearch !== false && Object.keys(providers).length === 0 && !googleKey && !googleCx && !chain && !newsChain && !crawlChain) {
    providers.parallel = {};
  }

  const chains: Partial<Record<Operation, string[]>> = {};
  if (newsChain) chains.news = newsChain;
  if (crawlChain) chains.crawl = crawlChain;

  return {
    providers,
    chain,
    chains: Object.keys(chains).length ? chains : undefined,
    maxResults: num(pick(env, 'MAX_RESULTS')),
    crawlResults: num(pick(env, 'CRAWL_RESULTS')),
    fallbackOnEmpty: bool(pick(env, 'FALLBACK_ON_EMPTY')),
    timeoutMs: num(pick(env, 'PROVIDER_TIMEOUT_MS')),
    cacheTtlSeconds: num(pick(env, 'CACHE_TTL')),
  };
}
