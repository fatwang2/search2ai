import { describe, expect, it } from 'vitest';
import { configFromEnv } from '../src/core/config.ts';
import { createGateway } from '../src/core/gateway.ts';
import { json, mockFetch } from './helpers.ts';

const s1 = (items: Array<Record<string, unknown>>) => json({ results: items });

describe('createGateway', () => {
  it('orders the default chain by priority regardless of config key order', () => {
    const g = createGateway({ providers: { tavily: { apiKey: 't' }, search1api: { apiKey: 's' }, jina: {} } });
    expect(g.chain('search')).toEqual(['search1api', 'tavily']);
    expect(g.chain('news')).toEqual(['search1api', 'tavily']);
    expect(g.chain('crawl')).toEqual(['search1api', 'tavily', 'jina']);
    expect(g.providers().map((p) => p.name)).toEqual(['search1api', 'tavily', 'jina']);
  });

  it('falls back to the next provider and reports provider + warnings', async () => {
    const { fetch, calls } = mockFetch((url) => {
      if (url.hostname === 'api.search1api.com') return new Response('down', { status: 503 });
      if (url.hostname === 'api.tavily.com') return json({ results: [{ title: 'T', url: 'https://t.com', content: 'c' }] });
      return undefined;
    });
    const g = createGateway({ providers: { search1api: { apiKey: 's' }, tavily: { apiKey: 't' } }, fetch });
    const r = await g.search({ query: 'x' });
    expect(r.object).toBe('search');
    expect(r.provider).toBe('tavily');
    expect(r.results).toEqual([{ title: 'T', url: 'https://t.com', snippet: 'c' }]);
    expect(r.warnings).toEqual([{ provider: 'search1api', code: 'upstream', message: 'search1api: HTTP 503 down', status: 503 }]);
    expect(r.id).toMatch(/[0-9a-f-]{20,}/);
    expect(calls.map((c) => c.url.hostname)).toEqual(['api.search1api.com', 'api.tavily.com']);
  });

  it('fans out array queries and dedupes by url', async () => {
    const { fetch } = mockFetch((_url, call) => {
      const q = (call.body as { query: string }).query;
      return s1([
        { title: q, link: 'https://shared.com/', snippet: '' },
        { title: q, link: `https://${q}.com`, snippet: '' },
      ]);
    });
    const g = createGateway({ providers: { search1api: { apiKey: 's' } }, fetch });
    const r = await g.search({ query: ['a', 'b'] });
    expect(r.results.map((x) => x.url)).toEqual(['https://shared.com/', 'https://a.com', 'https://b.com']);
  });

  it('respects per-request providers override and rejects unknown / unconfigured ones', async () => {
    const { fetch, calls } = mockFetch((url) => (url.hostname === 'api.tavily.com' ? json({ results: [] }) : s1([{ title: 'S', link: 'https://s.com', snippet: '' }])));
    const g = createGateway({ providers: { search1api: { apiKey: 's' }, tavily: { apiKey: 't' } }, fetch });
    const r = await g.search({ query: 'x', providers: ['tavily'] });
    expect(r.provider).toBe('tavily');
    expect(calls).toHaveLength(1);
    await expect(g.search({ query: 'x', providers: ['bing'] })).rejects.toMatchObject({ status: 400, code: 'unknown_provider' });
    await expect(g.search({ query: 'x', providers: ['brave'] })).rejects.toMatchObject({ status: 400, code: 'provider_not_configured' });
  });

  it('returns 503 when no provider can serve the operation', async () => {
    const g = createGateway({ providers: { jina: {} } });
    await expect(g.search({ query: 'x' })).rejects.toMatchObject({ status: 503, code: 'no_provider' });
    expect(g.chain('search')).toEqual([]);
  });

  it('enriches results with crawled content and truncates by max_tokens_per_page', async () => {
    const { fetch, calls } = mockFetch((url) => {
      if (url.hostname === 'api.search1api.com') return s1([{ title: 'A', link: 'https://a.com', snippet: '' }, { title: 'B', link: 'https://b.com', snippet: '' }]);
      if (url.hostname === 'r.jina.ai') return json({ data: { title: 'A', url: url.pathname.slice(1), content: 'x'.repeat(1000) } });
      return undefined;
    });
    const g = createGateway({ providers: { search1api: { apiKey: 's' }, jina: {} }, chains: { crawl: ['jina'] }, fetch });
    const r = await g.search({ query: 'x', crawl_results: 1, max_tokens_per_page: 10 });
    expect(r.results[0].content).toHaveLength(40);
    expect(r.results[1].content).toBeUndefined();
    expect(calls.filter((c) => c.url.hostname === 'r.jina.ai')).toHaveLength(1);
  });

  it('only crawls within the top N and skips results that already carry content', async () => {
    const { fetch, calls } = mockFetch((url) => {
      if (url.hostname === 'api.search1api.com') return s1([{ title: 'A', link: 'https://a.com', snippet: '', content: 'native' }, { title: 'B', link: 'https://b.com', snippet: '' }]);
      if (url.hostname === 'r.jina.ai') return json({ data: { content: 'crawled' } });
      return undefined;
    });
    const g = createGateway({ providers: { search1api: { apiKey: 's' }, jina: {} }, chains: { crawl: ['jina'] }, fetch });
    const one = await g.search({ query: 'x', crawl_results: 1 });
    expect(one.results[0].content).toBe('native');
    expect(one.results[1].content).toBeUndefined();
    expect(calls.filter((c) => c.url.hostname === 'r.jina.ai')).toHaveLength(0);
    const two = await g.search({ query: 'y', crawl_results: 2 });
    expect(two.results[1].content).toBe('crawled');
    expect(calls.filter((c) => c.url.hostname === 'r.jina.ai')).toHaveLength(1);
  });

  it('warns instead of failing when crawl_results is requested without a crawl provider', async () => {
    const { fetch } = mockFetch(() => json({ organic: [{ title: 'A', link: 'https://a.com', snippet: '' }] }));
    const g = createGateway({ providers: { serper: { apiKey: 'k' } }, fetch });
    const r = await g.search({ query: 'x', crawl_results: 2 });
    expect(r.results).toHaveLength(1);
    expect(r.warnings?.[0]).toMatchObject({ provider: 'gateway', code: 'not_configured' });
  });

  it('caches responses when cacheTtlSeconds is set', async () => {
    const { fetch, calls } = mockFetch(() => s1([{ title: 'A', link: 'https://a.com', snippet: '' }]));
    const g = createGateway({ providers: { search1api: { apiKey: 's' } }, fetch, cacheTtlSeconds: 60 });
    const a = await g.search({ query: 'x' });
    const b = await g.search({ query: 'x' });
    expect(a.cached).toBeUndefined();
    expect(b.cached).toBe(true);
    expect(b.results).toEqual(a.results);
    expect(calls).toHaveLength(1);
    await g.search({ query: 'y' });
    expect(calls).toHaveLength(2);
  });

  it('crawl uses the crawl chain and returns provider', async () => {
    const { fetch } = mockFetch((url) => (url.hostname === 'api.search1api.com' ? json({ results: { title: 'P', link: 'https://p.com', content: 'body' } }) : undefined));
    const g = createGateway({ providers: { search1api: { apiKey: 's' } }, fetch });
    const r = await g.crawl({ url: 'https://p.com' });
    expect(r).toMatchObject({ object: 'crawl', provider: 'search1api', url: 'https://p.com', title: 'P', content: 'body' });
  });
});

describe('configFromEnv', () => {
  it('maps legacy and new variable names, chains and options', () => {
    const cfg = configFromEnv({
      SEARCH_SERVICE: 'search1api, Serper,bing',
      NEWS_SERVICE: 'serper',
      SEARCH1API_KEY: 's1',
      SERPER_API_KEY: 'sp',
      GOOGLE_KEY: 'gk',
      GOOGLE_CX: 'cx',
      TAVILY_API_KEY: 'tv',
      FIRECRAWL_BASE_URL: 'http://fc',
      OUTCRAWL_API_KEY: 'oc',
      MAX_RESULTS: '7',
      CRAWL_RESULTS: '2',
      FALLBACK_ON_EMPTY: 'true',
      PROVIDER_TIMEOUT_MS: '5000',
      CACHE_TTL: '30',
      GL: 'cn',
      HL: 'zh',
    });
    expect(cfg.chain).toEqual(['search1api', 'serper', 'bing']);
    expect(cfg.chains).toEqual({ news: ['serper'] });
    expect(cfg.providers.search1api).toEqual({ apiKey: 's1', searchService: undefined });
    expect(cfg.providers.serper).toEqual({ apiKey: 'sp', gl: 'cn', hl: 'zh' });
    expect(cfg.providers.google).toEqual({ apiKey: 'gk', cx: 'cx', gl: 'cn', hl: 'zh' });
    expect(cfg.providers.tavily).toEqual({ apiKey: 'tv' });
    expect(cfg.providers.firecrawl).toEqual({ apiKey: undefined, baseUrl: 'http://fc' });
    expect(cfg.providers.outcrawl).toEqual({ apiKey: 'oc' });
    expect(cfg.providers.jina).toBeUndefined();
    expect(cfg).toMatchObject({ maxResults: 7, crawlResults: 2, fallbackOnEmpty: true, timeoutMs: 5000, cacheTtlSeconds: 30 });
  });

  it('enables jina only when keyed or explicitly listed, and drops unknown chain entries at gateway level', () => {
    expect(configFromEnv({ CRAWL_SERVICE: 'jina' }).providers.jina).toEqual({ apiKey: undefined });
    expect(configFromEnv({ JINA_KEY: 'j' }).providers.jina).toEqual({ apiKey: 'j' });
    const g = createGateway(configFromEnv({ SEARCH_SERVICE: 'bing,duckduckgo,search1api', SEARCH1API_KEY: 'k' }));
    expect(g.chain('search')).toEqual(['search1api']);
  });
});
