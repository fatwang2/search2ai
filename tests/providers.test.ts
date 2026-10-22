import { describe, expect, it } from 'vitest';
import { ProviderError } from '../src/core/errors.ts';
import {
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
} from '../src/core/providers/index.ts';
import type { ProviderContext, ProviderSearchParams } from '../src/core/types.ts';
import { json, mockFetch } from './helpers.ts';

const ctx = (f: typeof fetch): ProviderContext => ({ fetch: f, signal: new AbortController().signal });
const params = (extra: Partial<ProviderSearchParams> = {}): ProviderSearchParams => ({ query: 'hono workers', maxResults: 3, ...extra });

describe('search1api', () => {
  it('maps search/news/crawl and sends key + options', async () => {
    const { fetch, calls } = mockFetch((url) => {
      if (url.pathname === '/search') return json({ results: [{ title: 'A', link: 'https://a.com', snippet: 's', content: 'body', published_date: '2026-09-01' }] });
      if (url.pathname === '/news') return json({ results: [{ title: 'N', link: 'https://n.com', snippet: 'ns', date: '2026-09-01' }] });
      if (url.pathname === '/crawl') return json({ results: { title: 'P', link: 'https://p.com/x', content: '# hi' } });
      return undefined;
    });
    const p = createSearch1api({ apiKey: 'k1', searchService: 'bing' });
    const s = await p.search!(params({ domains: ['a.com'], crawlResults: 2, recency: 'week', languages: ['zh'] }), ctx(fetch));
    expect(s).toEqual([{ title: 'A', url: 'https://a.com', snippet: 's', content: 'body', date: '2026-09-01' }]);
    expect(calls[0].headers.authorization).toBe('Bearer k1');
    expect(calls[0].body).toMatchObject({ query: 'hono workers', search_service: 'bing', max_results: 3, crawl_results: 2, include_sites: ['a.com'], time_range: 'month', language: 'zh' });

    const n = await p.news!(params(), ctx(fetch));
    expect(n[0]).toMatchObject({ url: 'https://n.com', date: '2026-09-01' });

    const c = await p.crawl!('https://p.com/x', ctx(fetch));
    expect(c).toEqual({ url: 'https://p.com/x', title: 'P', content: '# hi' });
    expect(calls[2].body).toEqual({ url: 'https://p.com/x' });
  });

  it('classifies HTTP errors', async () => {
    const { fetch } = mockFetch(() => json({ error: 'bad key' }, 401));
    const p = createSearch1api({ apiKey: 'bad' });
    await expect(p.search!(params(), ctx(fetch))).rejects.toMatchObject({ code: 'auth', status: 401 });
    const rl = mockFetch(() => new Response('slow down', { status: 429 }));
    await expect(p.search!(params(), ctx(rl.fetch))).rejects.toBeInstanceOf(ProviderError);
    await expect(p.search!(params(), ctx(rl.fetch))).rejects.toMatchObject({ code: 'rate_limit' });
  });
});

describe('serper', () => {
  it('maps organic/news, applies site filter, recency and locale', async () => {
    const { fetch, calls } = mockFetch((url) => {
      if (url.pathname === '/search') return json({ organic: [{ title: 'A', link: 'https://a.com', snippet: 's', date: 'Jan 5, 2026' }, { title: 'B', link: 'https://b.com', snippet: 's2' }] });
      if (url.pathname === '/news') return json({ news: [{ title: 'N', link: 'https://n.com', snippet: 'ns', date: '3 hours ago' }] });
      return undefined;
    });
    const p = createSerper({ apiKey: 'sk', gl: 'cn', hl: 'zh' });
    const s = await p.search!(params({ maxResults: 1, domains: ['a.com', 'b.com'], recency: 'day', country: 'US' }), ctx(fetch));
    expect(s).toEqual([{ title: 'A', url: 'https://a.com', snippet: 's', date: '2026-01-05' }]);
    expect(calls[0].headers['x-api-key']).toBe('sk');
    expect(calls[0].body).toEqual({ q: 'hono workers (site:a.com OR site:b.com)', num: 1, gl: 'us', hl: 'zh', tbs: 'qdr:d' });
    const n = await p.news!(params(), ctx(fetch));
    expect(n).toEqual([{ title: 'N', url: 'https://n.com', snippet: 'ns' }]);
  });
});

describe('serpapi', () => {
  it('uses google / google_news engines via query string', async () => {
    const { fetch, calls } = mockFetch((url) => {
      if (url.searchParams.get('engine') === 'google') return json({ organic_results: [{ title: 'A', link: 'https://a.com', snippet: 's' }] });
      if (url.searchParams.get('engine') === 'google_news') return json({ news_results: [{ title: 'N', link: 'https://n.com', date: '09/01/2026, 10:00 AM, +0000 UTC' }] });
      return undefined;
    });
    const p = createSerpapi({ apiKey: 'sp' });
    const s = await p.search!(params({ recency: 'month' }), ctx(fetch));
    expect(s[0].url).toBe('https://a.com');
    expect(calls[0].url.searchParams.get('api_key')).toBe('sp');
    expect(calls[0].url.searchParams.get('num')).toBe('3');
    expect(calls[0].url.searchParams.get('tbs')).toBe('qdr:m');
    const n = await p.news!(params(), ctx(fetch));
    expect(n[0]).toMatchObject({ title: 'N', url: 'https://n.com', snippet: '' });
  });
});

describe('google', () => {
  it('caps num at 10, uses siteSearch for one domain and sort=date for news', async () => {
    const { fetch, calls } = mockFetch(() =>
      json({ items: [{ title: 'A', link: 'https://a.com', snippet: 's', pagemap: { metatags: [{ 'article:published_time': '2026-02-03T10:00:00Z' }] } }] })
    );
    const p = createGoogle({ apiKey: 'gk', cx: 'cx1' });
    const s = await p.search!(params({ maxResults: 25, domains: ['a.com'], recency: 'week' }), ctx(fetch));
    expect(s).toEqual([{ title: 'A', url: 'https://a.com', snippet: 's', date: '2026-02-03' }]);
    const q = calls[0].url.searchParams;
    expect(q.get('num')).toBe('10');
    expect(q.get('siteSearch')).toBe('a.com');
    expect(q.get('dateRestrict')).toBe('w1');
    expect(q.get('q')).toBe('hono workers');
    await p.news!(params(), ctx(fetch));
    expect(calls[1].url.searchParams.get('sort')).toBe('date');
  });
});

describe('searxng', () => {
  it('requests json format with categories and time_range', async () => {
    const { fetch, calls } = mockFetch(() => json({ results: [{ title: 'A', url: 'https://a.com', content: 'c', publishedDate: '2026-01-01T00:00:00' }] }));
    const p = createSearxng({ baseUrl: 'http://searx.local/' });
    const s = await p.news!(params({ recency: 'year' }), ctx(fetch));
    expect(s).toEqual([{ title: 'A', url: 'https://a.com', snippet: 'c', date: '2026-01-01' }]);
    const q = calls[0].url;
    expect(q.origin + q.pathname).toBe('http://searx.local/search');
    expect(q.searchParams.get('format')).toBe('json');
    expect(q.searchParams.get('categories')).toBe('news');
    expect(q.searchParams.get('time_range')).toBe('year');
  });
});

describe('tavily', () => {
  it('maps search/news/extract', async () => {
    const { fetch, calls } = mockFetch((url) => {
      if (url.pathname === '/search') return json({ results: [{ title: 'A', url: 'https://a.com', content: 'c', published_date: 'Mon, 01 Sep 2026 00:00:00 GMT' }] });
      if (url.pathname === '/extract') return json({ results: [{ url: 'https://a.com', raw_content: 'full' }], failed_results: [] });
      return undefined;
    });
    const p = createTavily({ apiKey: 'tv' });
    const n = await p.news!(params({ domains: ['a.com'], recency: 'week', afterDate: '2026-01-01' }), ctx(fetch));
    expect(n).toEqual([{ title: 'A', url: 'https://a.com', snippet: 'c', date: '2026-09-01' }]);
    expect(calls[0].headers.authorization).toBe('Bearer tv');
    expect(calls[0].body).toMatchObject({ query: 'hono workers', topic: 'news', max_results: 3, include_domains: ['a.com'], time_range: 'week', start_date: '2026-01-01' });
    const c = await p.crawl!('https://a.com', ctx(fetch));
    expect(c).toEqual({ url: 'https://a.com', content: 'full' });
  });
});

describe('brave', () => {
  it('maps web/news, cleans html snippets, sets freshness and token header', async () => {
    const { fetch, calls } = mockFetch((url) => {
      if (url.pathname.endsWith('/web/search')) return json({ web: { results: [{ title: 'A', url: 'https://a.com', description: '<strong>bold</strong> text', page_age: '2026-03-04T00:00:00' }] } });
      if (url.pathname.endsWith('/news/search')) return json({ results: [{ title: 'N', url: 'https://n.com', description: 'd', age: '2 hours ago' }] });
      return undefined;
    });
    const p = createBrave({ apiKey: 'bk' });
    const s = await p.search!(params({ recency: 'week', country: 'de' }), ctx(fetch));
    expect(s).toEqual([{ title: 'A', url: 'https://a.com', snippet: 'bold text', date: '2026-03-04' }]);
    expect(calls[0].headers['x-subscription-token']).toBe('bk');
    expect(calls[0].url.searchParams.get('freshness')).toBe('pw');
    expect(calls[0].url.searchParams.get('country')).toBe('DE');
    const n = await p.news!(params({ afterDate: '2026-01-01', beforeDate: '2026-02-01' }), ctx(fetch));
    expect(n).toEqual([{ title: 'N', url: 'https://n.com', snippet: 'd' }]);
    expect(calls[1].url.searchParams.get('freshness')).toBe('2026-01-01to2026-02-01');
  });
});

describe('exa', () => {
  it('uses highlights as snippet, category news, and /contents for crawl', async () => {
    const { fetch, calls } = mockFetch((url) => {
      if (url.pathname === '/search') return json({ results: [{ title: 'A', url: 'https://a.com', publishedDate: '2026-05-06T00:00:00.000Z', highlights: ['h1', 'h2'] }] });
      if (url.pathname === '/contents') return json({ results: [{ url: 'https://a.com', title: 'A', text: 'full text' }] });
      return undefined;
    });
    const p = createExa({ apiKey: 'ek' });
    const n = await p.news!(params({ domains: ['a.com'] }), ctx(fetch));
    expect(n).toEqual([{ title: 'A', url: 'https://a.com', snippet: 'h1 h2', date: '2026-05-06' }]);
    expect(calls[0].headers['x-api-key']).toBe('ek');
    expect(calls[0].body).toMatchObject({ query: 'hono workers', numResults: 3, category: 'news', includeDomains: ['a.com'] });
    const c = await p.crawl!('https://a.com', ctx(fetch));
    expect(c).toEqual({ url: 'https://a.com', title: 'A', content: 'full text' });
  });
});

describe('jina / firecrawl', () => {
  it('jina reads r.jina.ai json', async () => {
    const { fetch, calls } = mockFetch(() => json({ data: { title: 'T', url: 'https://a.com/', content: 'md', links: { a: 'https://x', b: 'https://y' } } }));
    const c = await createJina({ apiKey: 'jk' }).crawl!('https://a.com/', ctx(fetch));
    expect(c).toEqual({ url: 'https://a.com/', title: 'T', content: 'md', links: ['https://x', 'https://y'] });
    expect(calls[0].url.toString()).toBe('https://r.jina.ai/https://a.com/');
    expect(calls[0].headers.authorization).toBe('Bearer jk');
    expect(calls[0].headers.accept).toBe('application/json');
  });

  it('firecrawl scrapes markdown, honours self-hosted base url', async () => {
    const { fetch, calls } = mockFetch(() => json({ success: true, data: { markdown: '# md', links: ['https://x'], metadata: { title: 'T', sourceURL: 'https://a.com' } } }));
    const c = await createFirecrawl({ baseUrl: 'http://fc.local' }).crawl!('https://a.com', ctx(fetch));
    expect(c).toEqual({ url: 'https://a.com', title: 'T', content: '# md', links: ['https://x'] });
    expect(calls[0].url.toString()).toBe('http://fc.local/v1/scrape');
    expect(calls[0].body).toEqual({ url: 'https://a.com', formats: ['markdown'] });
    expect(calls[0].headers.authorization).toBeUndefined();
  });
});
