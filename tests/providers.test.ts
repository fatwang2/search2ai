import { describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../src/core/errors.ts';
import {
  createAutom,
  createBrave,
  createExa,
  createCloro,
  createFirecrawl,
  createGoogle,
  createJina,
  createKeenable,
  createOutcrawl,
  createSearch1api,
  createSearxng,
  createSerpapi,
  createSerper,
  createSpecstream,
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

describe('outcrawl', () => {
  it('searches /v1/search with bearer auth, site: domains and a capped limit, and scrapes markdown for crawl', async () => {
    const { fetch, calls } = mockFetch((url) => {
      if (url.pathname === '/v1/search') return json({ hits: [{ url: 'https://a.com/x', title: 'A', snippet: 's', rank: 1 }], usage: { credits: '0.5' } });
      if (url.pathname === '/v1/scrape') return json({ url: 'https://a.com/x', statusCode: 200, markdown: '# md', metadata: { title: 'T' } });
      return undefined;
    });
    const p = createOutcrawl({ apiKey: 'ock_k' });
    expect(p.news).toBeUndefined();
    const s = await p.search!(params({ domains: ['a.com'] }), ctx(fetch));
    expect(s).toEqual([{ title: 'A', url: 'https://a.com/x', snippet: 's' }]);
    expect(calls[0].url.toString()).toBe('https://api.outcrawl.ai/v1/search');
    expect(calls[0].headers.authorization).toBe('Bearer ock_k');
    expect(calls[0].body).toEqual({ query: 'hono workers site:a.com', limit: 3 });

    await p.search!(params({ maxResults: 50 }), ctx(fetch));
    expect(calls[1].body).toEqual({ query: 'hono workers', limit: 20 });

    const c = await p.crawl!('https://a.com/x', ctx(fetch));
    expect(c).toEqual({ url: 'https://a.com/x', title: 'T', content: '# md' });
    expect(calls[2].body).toEqual({ url: 'https://a.com/x', formats: ['markdown'], onlyMainContent: true });
  });

  it('maps 401 and 402 to provider errors', async () => {
    for (const [status, code] of [
      [401, 'auth'],
      [402, 'bad_request'],
    ] as const) {
      const { fetch } = mockFetch(() => json({ error: 'nope' }, status));
      const err = await createOutcrawl({ apiKey: 'ock_k' }).search!(params(), ctx(fetch)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).code).toBe(code);
    }
  });
});

describe('autom', () => {
  it('maps search and news, skips rows without a link, and sends country, language and the key', async () => {
    const { fetch, calls } = mockFetch((url) => {
      if (url.pathname === '/v1/google/search')
        return json({
          organic_results: [
            { position: 1, title: 'A', link: 'https://a.com/x', snippet: 's', domain: 'a.com' },
            { position: 2, title: 'No link', link: '', snippet: 'skip' },
            { position: 3, title: 'B', link: 'https://b.com/y', snippet: 's2' },
          ],
          pagination: { current: 1, has_next_page: true },
        });
      if (url.pathname === '/v1/google/news')
        return json({ organic_results: [{ position: 1, title: 'N', link: 'https://n.com/z', snippet: '', source: 'N', date: '2026-11-06' }] });
      return undefined;
    });
    const p = createAutom({ apiKey: 'ak', gl: 'cn', hl: 'zh' });
    expect(p.crawl).toBeUndefined();
    const s = await p.search!(params({ maxResults: 5, domains: ['a.com'], country: 'DE', languages: ['en'] }), ctx(fetch));
    expect(s).toEqual([
      { title: 'A', url: 'https://a.com/x', snippet: 's' },
      { title: 'B', url: 'https://b.com/y', snippet: 's2' },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe('/v1/google/search');
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ query: 'hono workers site:a.com', gl: 'de', hl: 'en' });
    expect(calls[0].headers['x-api-key']).toBe('ak');

    const n = await p.news!(params(), ctx(fetch));
    expect(n).toEqual([{ title: 'N', url: 'https://n.com/z', snippet: '', date: '2026-11-06' }]);
    expect(calls[1].url.toString()).toBe('https://api.autom.dev/v1/google/news?query=hono+workers&gl=cn&hl=zh');
  });

  it('reads a second page only when more than 10 results are wanted and Google has one', async () => {
    const page = (n: number, next: boolean) =>
      json({
        organic_results: Array.from({ length: 10 }, (_, i) => ({ title: `R${n}-${i}`, link: `https://r.com/${n}/${i}`, snippet: '' })),
        pagination: { current: n, has_next_page: next },
      });
    const { fetch, calls } = mockFetch((url) => page(Number(url.searchParams.get('page') ?? 1), true));
    const out = await createAutom({ apiKey: 'ak' }).search!(params({ maxResults: 50 }), ctx(fetch));
    expect(out).toHaveLength(20);
    expect(calls.map((c) => c.url.searchParams.get('page'))).toEqual([null, '2']);

    const last = mockFetch(() => page(1, false));
    expect(await createAutom({ apiKey: 'ak' }).search!(params({ maxResults: 50 }), ctx(last.fetch))).toHaveLength(10);
    expect(last.calls).toHaveLength(1);
  });

  it('maps a time filter to tbs on search only', async () => {
    const { fetch, calls } = mockFetch(() => json({ organic_results: [] }));
    const p = createAutom({ apiKey: 'ak' });
    await p.search!(params({ recency: 'day' }), ctx(fetch));
    expect(calls[0].url.searchParams.get('tbs')).toBe('qdr:d');
    await p.search!(params({ afterDate: '2026-10-01', beforeDate: '2026-10-07' }), ctx(fetch));
    expect(calls[1].url.searchParams.get('tbs')).toBe('cdr:1,cd_min:10/1/2026,cd_max:10/7/2026');
    await p.news!(params({ recency: 'day' }), ctx(fetch));
    expect(calls[2].url.searchParams.get('tbs')).toBeNull();
  });

  it('returns an empty list when organic_results is missing and maps HTTP errors', async () => {
    const empty = mockFetch(() => json({}));
    expect(await createAutom({ apiKey: 'ak' }).search!(params(), ctx(empty.fetch))).toEqual([]);
    for (const [status, code] of [
      [401, 'auth'],
      [429, 'rate_limit'],
    ] as const) {
      const { fetch } = mockFetch(() => json({ error: 'Invalid API Key' }, status));
      const err = await createAutom({ apiKey: 'ak' }).search!(params(), ctx(fetch)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).code).toBe(code);
    }
  });
});

describe('cloro', () => {
  it('maps search and news, skips rows without a usable link, and sends country, language and pages', async () => {
    const { fetch, calls } = mockFetch((url) => {
      if (url.pathname === '/v1/monitor/google')
        return json({
          success: true,
          result: {
            organicResults: [
              { position: 1, title: 'Gone', link: '', snippet: 'no link', redirectLink: 'https://www.google.com/goto?url=abc' },
              { position: 2, title: 'Goto', link: 'https://www.google.com/goto?url=def', snippet: 'redirect', redirectLink: 'https://www.google.com/goto?url=def' },
              { position: 3, title: 'A', link: 'https://a.com/x', snippet: 's', displayedLink: 'https://a.com > x' },
              { position: 4, title: 'B', link: 'https://b.com/y', snippet: 's2' },
            ],
          },
        });
      if (url.pathname === '/v1/monitor/google/news')
        return json({ success: true, result: { newsResults: [{ position: 1, title: 'N', link: 'https://n.com/z', snippet: '', source: 'N', date: '2026-11-06' }] } });
      return undefined;
    });
    const p = createCloro({ apiKey: 'ck', gl: 'cn', hl: 'zh' });
    expect(p.crawl).toBeUndefined();
    const s = await p.search!(params({ maxResults: 5, domains: ['a.com'], country: 'de', languages: ['en'] }), ctx(fetch));
    expect(s).toEqual([
      { title: 'A', url: 'https://a.com/x', snippet: 's' },
      { title: 'B', url: 'https://b.com/y', snippet: 's2' },
    ]);
    expect(calls[0].url.toString()).toBe('https://api.cloro.dev/v1/monitor/google');
    expect(calls[0].headers.authorization).toBe('Bearer ck');
    expect(calls[0].body).toEqual({ query: 'hono workers site:a.com', country: 'DE', hl: 'en', pages: 1 });

    const s2 = await p.search!(params({ maxResults: 50 }), ctx(fetch));
    expect(s2).toHaveLength(2);
    expect(calls[1].body).toEqual({ query: 'hono workers', country: 'CN', hl: 'zh', pages: 2 });

    const n = await p.news!(params(), ctx(fetch));
    expect(n).toEqual([{ title: 'N', url: 'https://n.com/z', snippet: '', date: '2026-11-06' }]);
    expect(calls[2].url.toString()).toBe('https://api.cloro.dev/v1/monitor/google/news');
  });

  it('sends a Google URL with tbs and one page when a time filter is set', async () => {
    const { fetch, calls } = mockFetch(() => json({ success: true, result: { organicResults: [{ position: 1, title: 'A', link: 'https://a.com/x', snippet: 's' }] } }));
    const p = createCloro({ apiKey: 'ck', hl: 'zh' });
    const out = await p.search!(params({ maxResults: 50, recency: 'day', domains: ['a.com'], country: 'de' }), ctx(fetch));
    expect(out).toEqual([{ title: 'A', url: 'https://a.com/x', snippet: 's' }]);
    expect(calls[0].url.toString()).toBe('https://api.cloro.dev/v1/monitor/google');
    expect(calls[0].body).toEqual({ url: 'https://www.google.com/search?q=hono+workers+site%3Aa.com&gl=de&hl=zh&tbs=qdr%3Ad' });

    await p.search!(params({ afterDate: '2026-10-01', beforeDate: '2026-10-07' }), ctx(fetch));
    const range = new URL((calls[1].body as { url: string }).url);
    expect(range.searchParams.get('tbs')).toBe('cdr:1,cd_min:10/1/2026,cd_max:10/7/2026');
    expect(range.searchParams.get('gl')).toBe('us');

    await p.search!(params({ afterDate: '2026-10-01', recency: 'year' }), ctx(fetch));
    expect(new URL((calls[2].body as { url: string }).url).searchParams.get('tbs')).toBe('cdr:1,cd_min:10/1/2026');

    // news 没有 url 形式, 时间过滤仍不映射
    await p.news!(params({ recency: 'day' }), ctx(fetch));
    expect(calls[3].body).toEqual({ query: 'hono workers', country: 'US', hl: 'zh', pages: 1 });
  });

  it('defaults the country to US and returns an empty list when result is missing', async () => {
    const { fetch, calls } = mockFetch(() => json({ success: true }));
    const out = await createCloro({ apiKey: 'ck' }).search!(params(), ctx(fetch));
    expect(out).toEqual([]);
    expect(calls[0].body).toEqual({ query: 'hono workers', country: 'US', pages: 1 });
  });

  it('maps 401 and 429 to provider errors', async () => {
    for (const [status, code] of [
      [401, 'auth'],
      [429, 'rate_limit'],
    ] as const) {
      const { fetch } = mockFetch(() => json({ success: false, error: { code: 'X', message: 'nope' } }, status));
      const err = await createCloro({ apiKey: 'ck' }).search!(params(), ctx(fetch)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).code).toBe(code);
    }
  });
});

describe('keenable', () => {
  it('uses the keyless public endpoints with an app title, a native site filter and markdown fetch', async () => {
    const { fetch, calls } = mockFetch((url) => {
      if (url.pathname === '/v1/search/public')
        return json({
          results: [
            { title: 'A', url: 'https://a.com/x', description: '', snippet: 'long excerpt', published_at: '2026-05-06T10:00:00Z' },
            { title: 'no url', snippet: 'dropped' },
          ],
        });
      if (url.pathname === '/v1/fetch/public') return json({ url: 'https://a.com/x', title: 'T', content: '# md' });
      return undefined;
    });
    const p = createKeenable();
    expect(p.news).toBeUndefined();
    const s = await p.search!(params({ domains: ['a.com'], recency: 'week' }), ctx(fetch));
    expect(s).toEqual([{ title: 'A', url: 'https://a.com/x', snippet: 'long excerpt', date: '2026-05-06' }]);
    expect(calls[0].url.toString()).toBe('https://api.keenable.ai/v1/search/public');
    expect(calls[0].headers['x-keenable-title']).toBe('search2ai');
    expect(calls[0].headers['x-api-key']).toBeUndefined();
    expect(calls[0].body).toEqual({ query: 'hono workers', max_results: 3, site: 'a.com', published_after: '7d' });

    await p.search!(params({ maxResults: 80, afterDate: '2026-01-01', beforeDate: '2026-02-01', recency: 'day' }), ctx(fetch));
    expect(calls[1].body).toEqual({ query: 'hono workers', max_results: 50, published_after: '2026-01-01', published_before: '2026-02-01' });

    const c = await p.crawl!('https://a.com/x?q=1', ctx(fetch));
    expect(c).toEqual({ url: 'https://a.com/x', title: 'T', content: '# md' });
    expect(calls[2].url.searchParams.get('url')).toBe('https://a.com/x?q=1');
  });

  it('uses the keyed endpoints with X-API-Key when a key is configured', async () => {
    const { fetch, calls } = mockFetch((url) => {
      if (url.pathname === '/v1/search') return json({ results: [] });
      if (url.pathname === '/v1/fetch') return json({ content: 'body' });
      return undefined;
    });
    const p = createKeenable({ apiKey: 'kk' });
    expect(await p.search!(params(), ctx(fetch))).toEqual([]);
    expect(calls[0].headers['x-api-key']).toBe('kk');
    expect(calls[0].headers['x-keenable-title']).toBeUndefined();
    expect(await p.crawl!('https://a.com', ctx(fetch))).toEqual({ url: 'https://a.com', title: undefined, content: 'body' });
    expect(calls[1].url.pathname).toBe('/v1/fetch');
  });

  it('maps hour recency to an exact 1h filter', async () => {
    const { fetch, calls } = mockFetch(() => json({ results: [] }));
    await createKeenable().search!(params({ recency: 'hour' }), ctx(fetch));
    expect(calls[0].body).toEqual({ query: 'hono workers', max_results: 3, published_after: '1h' });
  });

  it('omits search or crawl when disabled', () => {
    expect(createKeenable({ search: false }).search).toBeUndefined();
    expect(createKeenable({ search: false }).crawl).toBeDefined();
    expect(createKeenable({ crawl: false }).crawl).toBeUndefined();
  });

  it('rejects multiple domains as unsupported and maps 429 to rate_limit', async () => {
    const { fetch, calls } = mockFetch(() => json({ results: [] }));
    const err = await createKeenable().search!(params({ domains: ['a.com', 'b.com'] }), ctx(fetch)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe('unsupported');
    expect(calls).toHaveLength(0);

    const rl = mockFetch(() => new Response('slow down', { status: 429 }));
    const e2 = await createKeenable().search!(params(), ctx(rl.fetch)).catch((e: unknown) => e);
    expect((e2 as ProviderError).code).toBe('rate_limit');
  });
});

describe('specstream', () => {
  it('searches /v1/web-search with bearer auth, fast speed, operators and locale, and extracts markdown for crawl', async () => {
    const { fetch, calls } = mockFetch((url) => {
      if (url.pathname === '/v1/web-search')
        return json({
          data: {
            sources: [
              { url: 'https://a.com/x', title: 'A', site: 'a.com', snippet: 's', cited: false, published: '2026-05-06', modified: '2026-06-01' },
              { url: 'https://a.com/y', title: 'B', site: 'a.com', snippet: 's2', cited: false, published: null },
            ],
          },
        });
      if (url.pathname === '/v1/extract')
        return json({ data: { results: [{ url: 'https://a.com/x', status: 'ok', title: 'T', text: '# md', published: null }], took_ms: 1, price_usd: 0.0008 } });
      return undefined;
    });
    const p = createSpecstream({ apiKey: 'ss_k', gl: 'us', hl: 'zh-CN' });
    const s = await p.search!(params({ domains: ['a.com'], afterDate: '2026-01-01', beforeDate: '2026-02-01' }), ctx(fetch));
    expect(s).toEqual([
      { title: 'A', url: 'https://a.com/x', snippet: 's', date: '2026-05-06', last_updated: '2026-06-01' },
      { title: 'B', url: 'https://a.com/y', snippet: 's2' },
    ]);
    expect(calls[0].url.origin + calls[0].url.pathname).toBe('https://api.specstream.ai/v1/web-search');
    expect(calls[0].headers.authorization).toBe('Bearer ss_k');
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({
      q: 'hono workers site:a.com after:2026-01-01 before:2026-02-01',
      num: '3',
      speed: 'fast',
      country: 'US',
      language: 'zh',
    });

    await p.news!(params({ maxResults: 50, country: 'de', languages: ['de'] }), ctx(fetch));
    expect(Object.fromEntries(calls[1].url.searchParams)).toEqual({ q: 'hono workers', num: '50', speed: 'fast', news: 'true', country: 'DE', language: 'de' });

    const c = await p.crawl!('https://a.com/x', ctx(fetch));
    expect(c).toEqual({ url: 'https://a.com/x', title: 'T', content: '# md' });
    expect(calls[2].body).toEqual({ urls: ['https://a.com/x'], format: 'markdown' });
    expect(calls[2].headers.authorization).toBe('Bearer ss_k');
  });

  it('maps recency to an after: date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
    try {
      const { fetch, calls } = mockFetch(() => json({ data: { sources: [] } }));
      expect(await createSpecstream({ apiKey: 'k' }).search!(params({ recency: 'week' }), ctx(fetch))).toEqual([]);
      expect(calls[0].url.searchParams.get('q')).toBe('hono workers after:2026-11-03');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns unsupported for more than one domain, and maps HTTP and page errors', async () => {
    const { fetch, calls } = mockFetch(() => json({ data: { sources: [] } }));
    const p = createSpecstream({ apiKey: 'k' });
    await expect(p.search!(params({ domains: ['a.com', 'b.com'] }), ctx(fetch))).rejects.toMatchObject({ code: 'unsupported' });
    expect(calls).toHaveLength(0);

    for (const [status, code] of [
      [401, 'auth'],
      [402, 'bad_request'],
      [429, 'rate_limit'],
    ] as const) {
      const m = mockFetch(() => json({ error: { code: 'x', message: 'nope' } }, status));
      const err = await p.search!(params(), ctx(m.fetch)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).code).toBe(code);
    }

    const blocked = mockFetch(() => json({ data: { results: [{ url: 'https://a.com', status: 'blocked', title: null, text: '', published: null }] } }));
    await expect(p.crawl!('https://a.com', ctx(blocked.fetch))).rejects.toMatchObject({ code: 'upstream' });
    const empty = mockFetch(() => json({ data: { results: [{ url: 'https://a.com', status: 'empty', title: null, text: '', published: null }] } }));
    await expect(p.crawl!('https://a.com', ctx(empty.fetch))).rejects.toMatchObject({ code: 'empty' });
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
