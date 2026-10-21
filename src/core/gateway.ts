/**
 * 网关核心: 归一化请求 → 解析 fallback 链 → 逐家尝试 → 合并去重 → 可选抓取正文 → 缓存。
 * 与运行时无关, 可直接 import 到任何 JS 进程中使用。
 */
import { MemoryCache } from './cache.ts';
import type { GatewayConfig } from './config.ts';
import { GatewayError } from './errors.ts';
import { runChain, type ChainOptions } from './fallback.ts';
import { normalizeDateInput, truncate } from './http.ts';
import { createProvider, defaultPriority, describeProvider, isProviderName } from './providers/index.ts';
import { createProtocolTransport, type ProtocolRequest } from './protocol.ts';
import type {
  CrawlRequest,
  CrawlResponse,
  CrawlResult,
  Operation,
  ProviderInfo,
  ProviderSearchParams,
  ProviderWarning,
  SearchProvider,
  SearchRequest,
  SearchResponse,
  SearchResult,
} from './types.ts';

export interface GatewayRunOptions {
  signal?: AbortSignal;
}

export function searchSessionId(value?: string): string {
  if (value !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new GatewayError(400, 'invalid_request', 'session_id must be an opaque UUID');
  }
  return value ?? crypto.randomUUID();
}

/** Only a run that can reach a session-aware provider carries the ID; other chains keep the untouched error shape. */
async function withSearchSession<T>(sessionId: string, run: (claim: () => void) => Promise<T>): Promise<T> {
  let claimed = false;
  try {
    return await run(() => {
      claimed = true;
    });
  } catch (error) {
    if (claimed && error instanceof GatewayError) error.session_id = sessionId;
    throw error;
  }
}

export interface Gateway {
  search(req: SearchRequest, options?: GatewayRunOptions): Promise<SearchResponse>;
  news(req: SearchRequest, options?: GatewayRunOptions): Promise<SearchResponse>;
  crawl(req: CrawlRequest, options?: GatewayRunOptions): Promise<CrawlResponse>;
  /** Supported raw client-protocol calls, using only configured upstream credentials. */
  protocol?(req: ProtocolRequest): Promise<Response>;
  /** Shared empty-result policy for HTTP protocol adapters. */
  readonly fallbackOnEmpty?: boolean;
  /** 已配置的 provider 及其能力 */
  providers(): ProviderInfo[];
  /** 某操作实际生效的 fallback 顺序 */
  chain(op: Operation): string[];
}

const MAX_RESULTS_LIMIT = 50;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function urlKey(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

export function createGateway(config: GatewayConfig): Gateway {
  const instances = new Map<string, SearchProvider>();
  for (const name of defaultPriority) {
    const opts = config.providers[name];
    if (opts) instances.set(name, createProvider(name, opts as never));
  }

  const fetchFn: typeof fetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const chainOpts: ChainOptions = {
    fetch: fetchFn,
    timeoutMs: config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : 15_000,
    onEmpty: !!config.fallbackOnEmpty,
  };
  const cacheTtl = config.cacheTtlSeconds && config.cacheTtlSeconds > 0 ? config.cacheTtlSeconds : 0;
  const cache = cacheTtl > 0 ? (config.cache ?? new MemoryCache()) : undefined;
  const defaultMax = clamp(config.maxResults ?? 10, 1, MAX_RESULTS_LIMIT);
  const defaultCrawl = clamp(config.crawlResults ?? 0, 0, 10);

  function chainNames(op: Operation, override?: string[]): string[] {
    if (override && override.length) {
      for (const n of override) {
        if (!isProviderName(n)) throw new GatewayError(400, 'unknown_provider', `Unknown provider: ${n}`);
        if (!instances.has(n)) throw new GatewayError(400, 'provider_not_configured', `Provider not configured: ${n}`);
      }
      return override;
    }
    return config.chains?.[op] ?? config.chain ?? [...instances.keys()];
  }

  function resolveChain(op: Operation, override?: string[]): SearchProvider[] {
    const list = chainNames(op, override)
      .map((n) => instances.get(n))
      .filter((p): p is SearchProvider => !!p && typeof p[op] === 'function');
    if (list.length === 0) {
      throw new GatewayError(
        503,
        'no_provider',
        `No provider configured for ${op}. Configure at least one provider key (e.g. SEARCH1API_KEY).`
      );
    }
    return list;
  }

  function normalize(req: SearchRequest): Omit<ProviderSearchParams, 'query'> {
    const p: Omit<ProviderSearchParams, 'query'> = {
      maxResults: clamp(req.max_results ?? defaultMax, 1, MAX_RESULTS_LIMIT),
    };
    if (req.country) p.country = req.country;
    if (req.search_language_filter?.length) p.languages = req.search_language_filter;
    if (req.search_domain_filter?.length) p.domains = req.search_domain_filter;
    if (req.search_recency_filter) p.recency = req.search_recency_filter;
    const after = normalizeDateInput(req.search_after_date_filter);
    const before = normalizeDateInput(req.search_before_date_filter);
    if (after) p.afterDate = after;
    if (before) p.beforeDate = before;
    const crawl = clamp(req.crawl_results ?? defaultCrawl, 0, 10);
    if (crawl > 0) p.crawlResults = crawl;
    return p;
  }

  async function withCache<T extends { cached?: boolean }>(key: string | undefined, run: () => Promise<T>): Promise<T> {
    if (!cache || !key) return run();
    const hit = await cache.get(key).catch(() => null);
    if (hit) {
      try {
        return { ...(JSON.parse(hit) as T), cached: true };
      } catch {
        /* 缓存损坏时忽略 */
      }
    }
    const value = await run();
    await cache.set(key, JSON.stringify(value), cacheTtl).catch(() => undefined);
    return value;
  }

  async function crawlOne(url: string, override: string[] | undefined, runOpts: ChainOptions): Promise<{ value: CrawlResult; provider: string; warnings: ProviderWarning[] }> {
    const chain = resolveChain('crawl', override);
    return runChain(chain, 'crawl', (p, ctx) => p.crawl!(url, ctx), (r) => !r.content, runOpts);
  }

  /** 保证前 N 条结果带正文(已由 provider 原生返回的跳过); 抓取失败只记 warning, 不影响搜索结果 */
  async function enrich(results: SearchResult[], count: number, maxChars: number | undefined, warnings: ProviderWarning[], runOpts: ChainOptions): Promise<void> {
    let crawlChainOk = true;
    try {
      resolveChain('crawl');
    } catch {
      crawlChainOk = false;
    }
    if (!crawlChainOk) {
      warnings.push({ provider: 'gateway', code: 'not_configured', message: 'crawl_results requested but no crawl provider configured' });
      return;
    }
    const targets = results.slice(0, count).filter((r) => !r.content);
    if (targets.length === 0) return;
    const settled = await Promise.allSettled(targets.map((r) => crawlOne(r.url, undefined, runOpts)));
    runOpts.signal?.throwIfAborted();
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') {
        targets[i].content = truncate(s.value.value.content, maxChars);
        warnings.push(...s.value.warnings);
      } else {
        const e = s.reason as GatewayError;
        warnings.push({ provider: 'gateway', code: 'upstream', message: `crawl failed for ${targets[i].url}: ${e?.message ?? String(e)}` });
      }
    });
  }

  async function runSearch(op: 'search' | 'news', req: SearchRequest, options: GatewayRunOptions = {}): Promise<SearchResponse> {
    const sessionId = searchSessionId(req.session_id);
    return withSearchSession(sessionId, async (claim) => {
      if (req.session_id) claim();
      const runOpts: ChainOptions = { ...chainOpts, signal: options.signal, sessionId };
      options.signal?.throwIfAborted();
      const queries = (Array.isArray(req.query) ? req.query : [req.query]).map((q) => String(q ?? '').trim()).filter(Boolean);
      if (queries.length === 0) throw new GatewayError(400, 'invalid_request', 'query is required');
      const params = normalize(req);
      const chain = resolveChain(op, req.providers);
      const names = chain.map((p) => p.name);
      if (names.includes('parallel')) claim();
      const maxChars = req.max_tokens_per_page ? req.max_tokens_per_page * 4 : undefined;
      const cacheKey = `${op}:${JSON.stringify([queries, params, names])}`;

      const response = await withCache(cacheKey, async () => {
        const settled = await Promise.allSettled(
          queries.map((query) => runChain(chain, op, (p, ctx) => p[op]!({ ...params, query }, ctx), (r) => r.length === 0, runOpts))
        );
        options.signal?.throwIfAborted();
        const warnings: ProviderWarning[] = [];
        const seen = new Set<string>();
        const results: SearchResult[] = [];
        const providersUsed: string[] = [];
        let failures = 0;
        for (const s of settled) {
          if (s.status === 'rejected') {
            failures++;
            const e = s.reason;
            if (e instanceof GatewayError) warnings.push(...e.warnings);
            else warnings.push({ provider: 'gateway', code: 'upstream', message: String((e as Error)?.message ?? e) });
            continue;
          }
          warnings.push(...s.value.warnings);
          if (!providersUsed.includes(s.value.provider)) providersUsed.push(s.value.provider);
          for (const r of s.value.value) {
            const key = urlKey(r.url);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            results.push(maxChars && r.content ? { ...r, content: truncate(r.content, maxChars) } : r);
          }
        }
        if (failures === queries.length) {
          throw new GatewayError(502, 'all_providers_failed', `All ${op} providers failed (${names.join(', ')})`, warnings);
        }
        if (params.crawlResults && params.crawlResults > 0) {
          await enrich(results, params.crawlResults, maxChars, warnings, runOpts);
        }
        const response: SearchResponse = { object: op, id: newId(), provider: providersUsed.join(','), results };
        if (warnings.length) response.warnings = warnings;
        return response;
      });
      if (response.provider.split(',').includes('parallel') || req.session_id) response.session_id = sessionId;
      return response;
    });
  }

  return {
    search: (req, options) => runSearch('search', req, options),
    news: (req, options) => runSearch('news', req, options),
    protocol: createProtocolTransport(config),
    fallbackOnEmpty: !!config.fallbackOnEmpty,
    async crawl(req, options = {}) {
      const sessionId = searchSessionId(req.session_id);
      return withSearchSession(sessionId, async (claim) => {
        if (req.session_id) claim();
        const runOpts: ChainOptions = { ...chainOpts, signal: options.signal, sessionId };
        options.signal?.throwIfAborted();
        const url = String(req.url ?? '').trim();
        if (!url) throw new GatewayError(400, 'invalid_request', 'url is required');
        const names = resolveChain('crawl', req.providers).map((p) => p.name);
        if (names.includes('parallel')) claim();
        const response = await withCache(`crawl:${JSON.stringify([url, names])}`, async () => {
          const r = await crawlOne(url, req.providers, runOpts);
          const response: CrawlResponse = { object: 'crawl', id: newId(), provider: r.provider, ...r.value };
          if (r.warnings.length) response.warnings = r.warnings;
          return response;
        });
        if (response.provider.split(',').includes('parallel') || req.session_id) response.session_id = sessionId;
        return response;
      });
    },
    providers: () => [...instances.values()].map(describeProvider),
    chain: (op) => {
      try {
        return resolveChain(op).map((p) => p.name);
      } catch {
        return [];
      }
    },
  };
}
