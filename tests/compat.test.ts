import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createGateway } from '../src/core/gateway.ts';
import { createApp } from '../src/server/app.ts';
import { json, mockFetch } from './helpers.ts';

function build() {
  const mock = mockFetch((url) => {
    if (url.hostname === 'google.serper.dev') return json({ organic: [{ title: 'Page', link: 'https://example.com/a', snippet: 'Preview' }], news: [{ title: 'News', link: 'https://example.com/n', snippet: 'News preview' }] });
    if (url.hostname === 'r.jina.ai') {
      if (url.pathname.includes('/bad')) return json({ error: 'unavailable' }, 500);
      return json({ data: { title: 'Page', url: 'https://example.com/a', content: '# Page\nBody' } });
    }
  });
  const gateway = createGateway({ providers: { serper: { apiKey: 'upstream-key' }, jina: { apiKey: 'reader-key' } }, fetch: mock.fetch });
  return { ...mock, gateway, app: createApp({ gateway, authKeys: ['Gateway-Key'], mcp: false }) };
}
const post = (body: unknown, key = 'Gateway-Key') => ({ method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });

describe('client protocol compatibility', () => {
  it('serves SearXNG GET, root and form POST inside a mounted app', async () => {
    const { app, calls } = build();
    const mounted = new Hono().route('/gateway', app);
    for (const path of ['', '/', '/search']) {
      const result = await mounted.request(`/gateway/compat/searxng${path}?q=%E4%B8%AD%E6%96%87&format=json`, { headers: { Authorization: 'Bearer Gateway-Key' } });
      expect(result.status).toBe(200);
      const body = await result.json();
      expect(body.query).toBe('中文');
      expect(body.results[0]).toEqual({ title: 'Page', url: 'https://example.com/a', content: 'Preview' });
      expect(body.number_of_results).toBeUndefined(); // no invented total
    }
    const result = await mounted.request('/gateway/compat/searxng/search', { method: 'POST', headers: { Authorization: 'Bearer Gateway-Key', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'q=news&format=json&categories=news&pageno=1' });
    expect(result.status).toBe(200);
    expect((await result.json()).results[0].title).toBe('News');
    expect(calls.at(-1)?.url.pathname).toBe('/news');
  });

  it('preserves native SearXNG pagination, engines, metadata and base path without truncation', async () => {
    const payload = { query: 'q', number_of_results: 240, results: Array.from({ length: 15 }, (_, i) => ({ title: `Page ${i}`, url: `https://example.com/${i}`, content: 'x', engines: ['google'], score: 1 })), suggestions: ['next'] };
    const mock = mockFetch(() => json(payload));
    const app = createApp({ gateway: createGateway({ providers: { searxng: { baseUrl: 'https://searx.example/base/' } }, fetch: mock.fetch }), mcp: false });
    const result = await app.request('/compat/searxng/search?q=q&format=json&pageno=3&engines=google&safesearch=2&language=en');
    expect(await result.json()).toEqual(payload);
    expect(mock.calls[0].url.pathname).toBe('/base/search');
    expect(Object.fromEntries(mock.calls[0].url.searchParams)).toMatchObject({ pageno: '3', engines: 'google', safesearch: '2', language: 'en' });
  });

  it('accepts existing SearXNG integrations that POST query parameters with an empty body', async () => {
    const { app, calls } = build();
    const result = await app.request('/compat/searxng/search?q=q&format=json&pageNumber=1&numResults=3&imageProxy=true&safesearch=0', { method: 'POST', headers: { Authorization: 'Bearer Gateway-Key', 'Content-Type': 'application/json' } });
    expect(result.status).toBe(200);
    expect(calls[0].body).toMatchObject({ num: 3 });
    const page2 = await app.request('/compat/searxng/search?q=q&pageNumber=2', { headers: { Authorization: 'Bearer Gateway-Key' } });
    expect(page2.status).toBe(200);
    expect(page2.headers.get('X-Search2AI-Ignored')).toBe('pageno');
  });

  it.each([
    ['/compat/exa/search', { query: 'q', contents: false }, 'url'],
    ['/compat/tavily/search', { query: 'q' }, 'url'],
    ['/compat/search1api/search', { query: 'q' }, 'link'],
    ['/compat/search1api/news', { query: 'q' }, 'link'],
  ])('translates the supported search subset for %s', async (path, data, link) => {
    const { app, calls } = build();
    const result = await app.request(path, post(data));
    expect(result.status).toBe(200);
    const body = await result.json();
    expect(body.results[0][link]).toMatch(/^https:\/\/example.com\//);
    expect(body.results[0].score).toBeUndefined();
    expect(body.costDollars).toBeUndefined();
    expect(result.headers.get('X-Search2AI-Mode')).toBe('translated');
    expect(calls.every((c) => !Object.values(c.headers).includes('Gateway-Key'))).toBe(true);
  });

  it('uses x-api-key and reads the Exa SDK default text contents instead of treating snippets as text', async () => {
    const { app, calls } = build();
    const result = await app.request('/compat/exa/search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': 'Gateway-Key' }, body: JSON.stringify({ query: 'q' }) });
    expect(result.status).toBe(200);
    expect((await result.json()).results[0].text).toBe('# Page\nBody');
    expect(calls).toHaveLength(2);
  });

  it.each([
    ['/compat/search1api/crawl', { url: 'https://example.com/a' }, (b: any) => b.results.content],
    ['/compat/firecrawl/v2/scrape', { url: 'https://example.com/a', formats: ['markdown'] }, (b: any) => b.data.markdown],
    ['/compat/firecrawl/v1/scrape', { url: 'https://example.com/a' }, (b: any) => b.data.markdown],
  ])('translates single-page reading for %s', async (path, data, content) => {
    const { app } = build();
    const result = await app.request(path, post(data));
    expect(result.status).toBe(200);
    expect(content(await result.json())).toBe('# Page\nBody');
  });

  it.each(['/compat/tavily/extract', '/compat/exa/contents'])('reports batch partial failures for %s', async (path) => {
    const { app } = build();
    const result = await app.request(path, post({ urls: ['https://example.com/a', 'https://example.com/bad'] }));
    expect(result.status).toBe(200);
    const body = await result.json();
    expect(body.results).toHaveLength(1);
    if (path.includes('tavily')) expect(body.failed_results).toEqual([{ url: 'https://example.com/bad', error: 'Failed to retrieve content' }]);
    else expect(body.statuses[1]).toMatchObject({ id: 'https://example.com/bad', status: 'error' });
  });

  it.each([
    ['/compat/searxng/search?q=q&format=html', undefined, 'format'],
    ['/compat/searxng/search?q=q&pageno=2', undefined, 'pageno'],
    ['/compat/searxng/search?q=q&engines=google', undefined, 'engines'],
    ['/compat/searxng/search?q=%21google+q', undefined, 'q.syntax'],
    ['/compat/exa/search', { query: 'q', type: 'neural' }, 'type'],
    ['/compat/exa/contents', { urls: ['https://example.com'], subpages: 2 }, 'subpages'],
    ['/compat/tavily/search', { query: 'q', include_answer: true }, 'include_answer'],
    ['/compat/tavily/search', { query: 'q', search_depth: 'advanced' }, 'search_depth'],
    ['/compat/search1api/search', { query: 'q', page: 2 }, 'page'],
    ['/compat/firecrawl/v2/scrape', { url: 'https://example.com', formats: ['screenshot'] }, 'formats'],
  ])('ignores unsupported options while executing the request: %s', async (path, data, ignored) => {
    const { app, calls } = build();
    const result = await app.request(path, data ? post(data) : { headers: { Authorization: 'Bearer Gateway-Key' } });
    expect(result.status).toBe(200);
    expect(result.headers.get('X-Search2AI-Ignored')?.split(',')).toContain(ignored);
    expect(calls.length).toBeGreaterThan(0);
  });

  it.each(['exa', 'tavily', 'search1api', 'firecrawl'])('preserves native %s fields and upstream credentials', async (protocol) => {
    const payload = { requestId: 'native', results: [{ score: 0.8, highlights: ['evidence'], metadata: { custom: true } }], costDollars: { total: 0.01 } };
    const mock = mockFetch(() => json(payload));
    const gateway = createGateway({ providers: { [protocol]: { apiKey: 'upstream-only', baseUrl: 'https://up.example/base' } }, fetch: mock.fetch });
    const app = createApp({ gateway, authKeys: ['Gateway-Key'], mcp: false });
    const path = protocol === 'firecrawl' ? '/v2/scrape' : '/search';
    const body = protocol === 'firecrawl' ? { url: 'https://example.com', formats: ['html'] } : { query: 'q', custom_upstream_option: true };
    const result = await app.request(`/compat/${protocol}${path}`, post(body));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(payload);
    expect(mock.calls[0].url.pathname).toBe(`/base${path}`);
    expect(mock.calls[0].body).toEqual(body);
    expect(mock.calls[0].headers[protocol === 'exa' ? 'x-api-key' : 'authorization']).toBe(protocol === 'exa' ? 'upstream-only' : 'Bearer upstream-only');
  });

  it('accepts legacy Tavily body auth but strips it before native forwarding', async () => {
    const mock = mockFetch(() => json({ results: [] }));
    const app = createApp({ gateway: createGateway({ providers: { tavily: { apiKey: 'upstream' } }, fetch: mock.fetch }), authKeys: ['Gateway-Key'], mcp: false });
    const result = await app.request('/compat/tavily/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: 'Gateway-Key', query: 'q' }) });
    expect(result.status).toBe(200);
    expect(mock.calls[0].body).toEqual({ query: 'q' });
    const denied = await app.request('/compat/tavily/search', post({ api_key: 'wrong', query: 'q' }));
    expect(denied.status).toBe(401);
  });

  it('falls back from native failure even with native-only options', async () => {
    const mock = mockFetch((url) => url.hostname === 'api.exa.ai' ? json({ error: 'limited', tag: 'RATE_LIMIT' }, 429) : json({ organic: [{ title: 'Fallback', link: 'https://example.com', snippet: 'x' }] }));
    const gateway = createGateway({ providers: { exa: { apiKey: 'e' }, serper: { apiKey: 's' } }, chain: ['exa', 'serper'], fetch: mock.fetch });
    const app = createApp({ gateway, mcp: false });
    const fallback = await app.request('/compat/exa/search', post({ query: 'q', contents: false }));
    expect(fallback.status).toBe(200);
    expect(fallback.headers.get('X-Search2AI-Provider')).toBe('serper');
    const restricted = await app.request('/compat/exa/search', post({ query: 'q', type: 'neural' }));
    expect(restricted.status).toBe(200);
    expect(restricted.headers.get('X-Search2AI-Ignored')).toBe('type');
    expect((await restricted.json()).results[0].title).toBe('Fallback');
    expect(mock.calls.filter((c) => c.url.hostname === 'google.serper.dev')).toHaveLength(2);
  });

  it('honors provider order even when an earlier provider cannot implement advanced options', async () => {
    const mock = mockFetch(() => json({ organic: [{ title: 'Translated', link: 'https://example.com', snippet: 'Preview' }] }));
    const gateway = createGateway({ providers: { serper: { apiKey: 's' }, exa: { apiKey: 'e' } }, chain: ['serper', 'exa'], fetch: mock.fetch });
    const result = await createApp({ gateway, mcp: false }).request('/compat/exa/search', post({ query: 'q', contents: { highlights: true } }));
    expect(result.status).toBe(200);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url.hostname).toBe('google.serper.dev');
    expect(result.headers.get('X-Search2AI-Ignored')).toBe('contents.highlights');
    expect((await result.json()).results[0].highlights).toBeUndefined();
  });

  it.each([['exa', 'serper'], ['serper', 'exa']])('preserves beta headers only on native Exa: %s first', async (first, second) => {
    const mock = mockFetch(() => json({ results: [] }));
    const gateway = createGateway({ providers: { serper: { apiKey: 's' }, exa: { apiKey: 'e' } }, chain: [first, second], fetch: mock.fetch });
    const result = await createApp({ gateway, authKeys: ['Gateway-Key'], mcp: false }).request('/compat/exa/search', { ...post({ query: 'q', contents: false }), headers: { ...post({}).headers, 'Exa-Beta': 'dynamic-highlights-2026-08-28' } });
    expect(result.status).toBe(200);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].headers['exa-beta']).toBe(first === 'exa' ? 'dynamic-highlights-2026-08-28' : undefined);
    expect(result.headers.get('X-Search2AI-Ignored')).toBe(first === 'exa' ? null : 'Exa-Beta');
    expect(mock.calls[0].headers.authorization).toBeUndefined();
  });

  it('bounds concurrent page reads and uses fallback independently for failed pages', async () => {
    let active = 0;
    let peak = 0;
    const mock = mockFetch(async (url) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      if (url.hostname === 'r.jina.ai') return json({ error: 'down' }, 500);
      return json({ success: true, data: { markdown: 'Fallback page' } });
    });
    const gateway = createGateway({ providers: { jina: {}, firecrawl: { apiKey: 'f' } }, chains: { crawl: ['jina', 'firecrawl'] }, fetch: mock.fetch });
    const result = await createApp({ gateway, mcp: false }).request('/compat/tavily/extract', post({ urls: Array.from({ length: 10 }, (_, i) => `https://example.com/${i}`) }));
    expect(result.status).toBe(200);
    expect((await result.json()).results).toHaveLength(10);
    expect(result.headers.get('X-Search2AI-Provider')).toBe('firecrawl');
    expect(peak).toBeLessThanOrEqual(4);
    expect(mock.calls).toHaveLength(20);
  });

  it('honors enableFallback=false for translated single-page reads', async () => {
    const mock = mockFetch(() => json({ error: 'down' }, 500));
    const gateway = createGateway({ providers: { jina: {}, firecrawl: { apiKey: 'f' } }, chains: { crawl: ['jina', 'firecrawl'] }, fetch: mock.fetch });
    const result = await createApp({ gateway, mcp: false }).request('/compat/search1api/crawl', post({ url: 'https://example.com/a', enableFallback: false }));
    expect(result.status).toBe(502);
    expect(mock.calls).toHaveLength(1);
  });

  it.each([
    ['/compat/search1api/crawl', { url: 'https://example.com/a' }, 2, 502],
    ['/compat/tavily/extract', { urls: ['https://example.com/a', 'https://example.com/b'] }, 4, 200],
  ])('never repeats exhausted page providers for %s', async (path, body, count, status) => {
    const mock = mockFetch(() => json({ error: 'down' }, 500));
    const gateway = createGateway({ providers: { jina: {}, firecrawl: { apiKey: 'f' } }, chains: { crawl: ['jina', 'firecrawl'] }, fetch: mock.fetch });
    const result = await createApp({ gateway, mcp: false }).request(path, post(body));
    expect(result.status).toBe(status);
    expect(mock.calls).toHaveLength(count);
    if (status === 200) expect((await result.json()).failed_results).toHaveLength(2);
  });

  it('bounds streamed native responses and cancels an oversized body', async () => {
    let cancelled = false;
    const mock = mockFetch(() => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); },
      cancel() { cancelled = true; },
    })));
    const gateway = createGateway({ providers: { exa: { apiKey: 'e' } }, fetch: mock.fetch });
    const result = await createApp({ gateway, mcp: false }).request('/compat/exa/search', post({ query: 'q', contents: false }));
    expect(result.status).toBe(502);
    expect(await result.json()).toMatchObject({ tag: 'RESPONSE_TOO_LARGE' });
    expect(cancelled).toBe(true);
  });

  it.each([false, true])('shares the native empty-result fallback policy: %s', async (fallbackOnEmpty) => {
    const mock = mockFetch((url) => url.hostname === 'api.exa.ai' ? json({ results: [] }) : json({ organic: [{ title: 'Found', link: 'https://example.com', snippet: 'x' }] }));
    const gateway = createGateway({ providers: { exa: { apiKey: 'e' }, serper: { apiKey: 's' } }, chain: ['exa', 'serper'], fallbackOnEmpty, fetch: mock.fetch });
    const result = await createApp({ gateway, mcp: false }).request('/compat/exa/search', post({ query: 'q', contents: false }));
    expect(result.status).toBe(200);
    expect((await result.json()).results).toHaveLength(fallbackOnEmpty ? 1 : 0);
    expect(mock.calls).toHaveLength(fallbackOnEmpty ? 2 : 1);
  });

  it('maps SearXNG language to the first provider without skipping Serper', async () => {
    const mock = mockFetch(() => json({ results: [{ title: 'Found', link: 'https://example.com', snippet: 'x' }] }));
    const gateway = createGateway({ providers: { search1api: { apiKey: 's' }, serper: { apiKey: 'g' } }, chain: ['serper', 'search1api'], fetch: mock.fetch });
    const result = await createApp({ gateway, mcp: false }).request('/compat/searxng/search?q=q&format=json&language=en');
    expect(result.status).toBe(200);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].body).toMatchObject({ hl: 'en' });
  });

  it.each([
    ['tavily', { query: 'q', include_domains: ['example.com'], exclude_domains: ['blocked.example'], time_range: 'week', country: 'us' }],
    ['search1api', { query: 'q', include_sites: ['example.com'], exclude_sites: ['blocked.example'], time_range: 'week', language: 'en' }],
    ['exa', { query: 'q', includeDomains: ['example.com'], excludeDomains: ['blocked.example'], contents: false }],
  ])('maps domain filters and available options from %s to Serper', async (protocol, data) => {
    const { app, calls } = build();
    const response = await app.request(`/compat/${protocol}/search`, post(data));
    expect(response.status).toBe(200);
    expect(calls[0].body).toMatchObject({ q: 'q -site:blocked.example site:example.com' });
    expect(response.headers.get('X-Search2AI-Ignored')).toBeNull();
    if (protocol === 'tavily') expect(calls[0].body).toMatchObject({ tbs: 'qdr:w', gl: 'us' });
    if (protocol === 'search1api') expect(calls[0].body).toMatchObject({ tbs: 'qdr:w', hl: 'en' });
  });

  it('maps Exa dates and domains to Tavily', async () => {
    const mock = mockFetch(() => json({ results: [] }));
    const app = createApp({ gateway: createGateway({ providers: { tavily: { apiKey: 't' } }, fetch: mock.fetch }), mcp: false });
    const response = await app.request('/compat/exa/search', post({ query: 'q', contents: false, includeDomains: ['example.com'], startPublishedDate: '2026-01-01T00:00:00Z', endPublishedDate: '2026-10-01T00:00:00Z' }));
    expect(response.status).toBe(200);
    expect(mock.calls[0].body).toMatchObject({ include_domains: ['example.com'], start_date: '2026-01-01', end_date: '2026-10-01' });
    expect(response.headers.get('X-Search2AI-Ignored')).toBeNull();
  });

  it('ignores language and date options that the chosen adapter cannot apply', async () => {
    const mock = mockFetch(() => json({ results: [{ title: 'Found', url: 'https://example.com' }] }));
    const app = createApp({ gateway: createGateway({ providers: { exa: { apiKey: 'e' } }, fetch: mock.fetch }), mcp: false });
    const response = await app.request('/compat/searxng/search?q=q&language=en');
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Search2AI-Ignored')).toBe('language');
    const { app: serper } = build();
    const dated = await serper.request('/compat/exa/search', post({ query: 'q', contents: false, startPublishedDate: '2026-01-01' }));
    expect(dated.status).toBe(200);
    expect(dated.headers.get('X-Search2AI-Ignored')).toBe('startPublishedDate');
  });

  it.each([
    ['google', { apiKey: 'g', cx: 'cx' }, 10],
    ['brave', { apiKey: 'b' }, 20],
    ['tavily', { apiKey: 't' }, 20],
    ['serper', { apiKey: 's' }, 50],
  ])('clamps result counts to the %s limit without rejecting the request', async (provider, options, limit) => {
    const entry = { title: 'Found', url: 'https://example.com', link: 'https://example.com', snippet: 'preview', content: 'preview', description: 'preview' };
    const entries = Array.from({ length: limit }, (_, i) => ({ ...entry, url: `${entry.url}/${i}`, link: `${entry.link}/${i}` }));
    const mock = mockFetch(() => json({ items: entries, web: { results: entries }, results: entries, organic: entries }));
    const app = createApp({ gateway: createGateway({ providers: { [provider]: options }, fetch: mock.fetch }), mcp: false });
    const response = await app.request('/compat/search1api/search', post({ query: 'q', max_results: 100 }));
    expect(response.status).toBe(200);
    expect((await response.json()).results).toHaveLength(limit);
    expect(response.headers.get('X-Search2AI-Warnings')).toBe('result_limit_clamped');
    expect(mock.calls).toHaveLength(1);
    if (provider === 'google') expect(mock.calls[0].url.searchParams.get('num')).toBe(String(limit));
    if (provider === 'brave') expect(mock.calls[0].url.searchParams.get('count')).toBe(String(limit));
    if (provider === 'tavily') expect(mock.calls[0].body).toMatchObject({ max_results: limit });
    if (provider === 'serper') expect(mock.calls[0].body).toMatchObject({ num: limit });
  });

  it.each(['exa', 'tavily', 'search1api'])('keeps %s search results when optional content is unavailable or fails', async (protocol) => {
    for (const reader of [false, true]) {
      const mock = mockFetch((u) => u.hostname === 'r.jina.ai' ? json({ error: 'down' }, 500) : json({ organic: [{ title: 'Found', link: 'https://example.com', snippet: 'preview' }] }));
      const app = createApp({ gateway: createGateway({ providers: { serper: { apiKey: 's' }, ...(reader ? { jina: {} } : {}) }, fetch: mock.fetch }), mcp: false });
      const data = protocol === 'tavily' ? { query: 'q', include_raw_content: true } : protocol === 'search1api' ? { query: 'q', crawl_results: 1 } : { query: 'q' };
      const response = await app.request(`/compat/${protocol}/search`, post(data));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.results[0].title).toBe('Found');
      expect(body.results[0].text).toBeUndefined();
      expect(body.results[0].content).toBe(protocol === 'tavily' ? 'preview' : undefined);
      if (protocol === 'tavily') expect(body.results[0].raw_content).toBeNull();
      expect(response.headers.get('X-Search2AI-Warnings')).toBe(reader ? 'content_partial' : 'content_unavailable');
      expect(mock.calls).toHaveLength(reader ? 2 : 1);
    }
  });

  it('retains successful content when only some page reads fail', async () => {
    const mock = mockFetch((u) => {
      if (u.hostname === 'google.serper.dev') return json({ organic: ['good', 'bad'].map((name) => ({ title: name, link: `https://example.com/${name}`, snippet: name })) });
      return u.pathname.includes('bad') ? json({}, 500) : json({ data: { content: 'Actual page text' } });
    });
    const app = createApp({ gateway: createGateway({ providers: { serper: { apiKey: 's' }, jina: {} }, fetch: mock.fetch }), mcp: false });
    const response = await app.request('/compat/tavily/search', post({ query: 'q', include_raw_content: true }));
    expect(response.status).toBe(200);
    expect((await response.json()).results.map((r: { raw_content: string | null }) => r.raw_content)).toEqual(['Actual page text', null]);
    expect(response.headers.get('X-Search2AI-Warnings')).toBe('content_partial');
  });

  it.each([
    ['exa', '/search', { query: 'q', stream: true, contents: { text: true, subpages: 3, summary: true } }, ['stream', 'contents.subpages', 'contents.summary']],
    ['tavily', '/search', { query: 'q', include_answer: true }, ['include_answer']],
    ['firecrawl', '/v2/scrape', { url: 'https://example.com', actions: [{ type: 'wait', milliseconds: 500 }], formats: ['markdown', 'screenshot'] }, ['actions', 'formats']],
  ])('ignores out-of-scope options on native %s calls without rejecting the base operation', async (protocol, path, data, ignored) => {
    const mock = mockFetch(() => json({ results: [] }));
    const app = createApp({ gateway: createGateway({ providers: { [protocol]: { apiKey: 'key' } }, fetch: mock.fetch }), mcp: false });
    const response = await app.request(`/compat/${protocol}${path}`, post(data));
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Search2AI-Ignored')?.split(',')).toEqual(ignored);
    const payload = mock.calls[0].body as Record<string, unknown>;
    if (protocol === 'exa') expect(payload).toEqual({ query: 'q', contents: { text: true } });
    if (protocol === 'tavily') expect(payload).toEqual({ query: 'q' });
    if (protocol === 'firecrawl') expect(payload).toEqual({ url: 'https://example.com', formats: ['markdown'] });
  });

  it('does not leak ignored options from a failed translation into a later native response', async () => {
    const mock = mockFetch((u) => u.hostname === 'google.serper.dev' ? json({}, 500) : json({ results: [{ title: 'Native', url: 'https://example.com', highlights: ['native'] }] }));
    const app = createApp({ gateway: createGateway({ providers: { serper: { apiKey: 's' }, exa: { apiKey: 'e' } }, chain: ['serper', 'exa'], fetch: mock.fetch }), mcp: false });
    const response = await app.request('/compat/exa/search', post({ query: 'q', contents: { highlights: true } }));
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Search2AI-Mode')).toBe('native');
    expect(response.headers.get('X-Search2AI-Ignored')).toBeNull();
    expect(response.headers.get('X-Search2AI-Warnings')).toBeNull();
    expect((await response.json()).results[0].highlights).toEqual(['native']);
  });

  it('preserves native errors if every fallback fails', async () => {
    const mock = mockFetch((u) => u.hostname === 'api.exa.ai' ? json({ error: 'limited', tag: 'RATE_LIMIT' }, 429) : json({}, 500));
    const app = createApp({ gateway: createGateway({ providers: { exa: { apiKey: 'e' }, serper: { apiKey: 's' } }, chain: ['exa', 'serper'], fetch: mock.fetch }), mcp: false });
    const response = await app.request('/compat/exa/search', post({ query: 'q', contents: false, type: 'neural' }));
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: 'limited', tag: 'RATE_LIMIT' });
    expect(mock.calls).toHaveLength(2);
  });

  it('ignores unknown option values without interpreting them and exposes safe diagnostics through CORS', async () => {
    const { app } = build();
    const response = await app.request('/compat/tavily/search', post({ query: 'q', language: { unknown: true }, '选项\r\n': 'private-value', '\ud800': true }));
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Search2AI-Ignored')).toBe('language,%E9%80%89%E9%A1%B9%0D%0A,%EF%BF%BD');
    expect(response.headers.get('X-Search2AI-Ignored')).not.toContain('private-value');
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('X-Search2AI-Ignored');
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('X-Search2AI-Warnings');
  });

  it.each([
    ['/compat/exa/search', { query: 'q', numResults: 0 }],
    ['/compat/tavily/search', { query: 'q', max_results: '10' }],
    ['/compat/search1api/search', { query: 'q', crawl_results: -1 }],
    ['/compat/tavily/search', { query: 'q', include_domains: 'example.com' }],
    ['/compat/exa/search', { query: 'q', contents: { text: { maxCharacters: -1 } } }],
    ['/compat/firecrawl/v2/scrape', { url: 'https://example.com', formats: [] }],
  ])('still rejects invalid request values: %s', async (path, data) => {
    const { app, calls } = build();
    const response = await app.request(path, post(data));
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('does not expose recursive routes, rejects malformed envelopes and requires exact keys', async () => {
    const { app, calls } = build();
    expect((await app.request('/compat/firecrawl/v2/crawl', post({ url: 'https://example.com' }))).status).toBe(404);
    expect((await app.request('/compat/search1api/search', post({ query: 'q' }, 'gateway-key'))).status).toBe(401);
    expect((await app.request('/compat/search1api/crawl', post({ url: 'file:///etc/passwd' }))).status).toBe(400);
    expect((await app.request('/compat/exa/contents', post({ urls: Array(11).fill('https://example.com') }))).status).toBe(400);
    expect((await app.request('/compat/tavily/search', post([]))).status).toBe(400);
    expect((await app.request('/compat/searxng/search?q=a&q=b', { headers: { Authorization: 'Bearer Gateway-Key' } })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('returns protocol errors without any configured provider and permits x-api-key in CORS', async () => {
    const app = createApp({ gateway: createGateway({ providers: {} }), mcp: false });
    const result = await app.request('/compat/exa/search', post({ query: 'q' }));
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ tag: 'NO_PROVIDER' });
    const options = await app.request('/compat/exa/search', { method: 'OPTIONS', headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-api-key,content-type' } });
    expect(options.headers.get('Access-Control-Allow-Headers')).toContain('X-Api-Key');
    const schema = await (await app.request('/openapi.json')).json();
    expect(schema.paths['/compat/searxng/search'].get.parameters.find((p: { name: string }) => p.name === 'q').required).toBe(true);
    expect(schema.paths['/compat/firecrawl/v2/scrape'].post).toBeDefined();
    expect(schema.paths['/compat/firecrawl/v2/crawl']).toBeUndefined();
    expect(schema.components.securitySchemes.exaKey.name).toBe('x-api-key');
    const oversized = await app.request('/compat/firecrawl/v2/scrape', post({ url: 'https://example.com', extra: 'x'.repeat(256 * 1024) }));
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ success: false });
  });

  it('times out native requests and cancels translated calls without starting fallback', async () => {
    const mock = mockFetch((_url, call) => new Promise((_resolve, reject) => call.init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
    const native = createApp({ gateway: createGateway({ providers: { exa: { apiKey: 'e' } }, timeoutMs: 5, fetch: mock.fetch }), mcp: false });
    const timed = await native.request('/compat/exa/search', post({ query: 'q' }));
    expect(timed.status).toBe(504);
    const controller = new AbortController();
    const translated = createApp({ gateway: createGateway({ providers: { serper: { apiKey: 's' }, tavily: { apiKey: 't' } }, chain: ['serper', 'tavily'], fetch: mock.fetch }), mcp: false });
    const pending = translated.request('/compat/search1api/search', { ...post({ query: 'q' }), signal: controller.signal });
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    expect((await pending).status).toBe(499);
    expect(mock.calls).toHaveLength(2);
  });
});
