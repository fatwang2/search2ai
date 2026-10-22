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
    expect(page2.status).toBe(422);
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
    ['/compat/searxng/search?q=q&format=html', undefined],
    ['/compat/searxng/search?q=q&pageno=2', undefined],
    ['/compat/searxng/search?q=q&engines=google', undefined],
    ['/compat/searxng/search?q=%21google+q', undefined],
    ['/compat/exa/search', { query: 'q', type: 'neural' }],
    ['/compat/exa/contents', { urls: ['https://example.com'], subpages: 2 }],
    ['/compat/tavily/search', { query: 'q', include_answer: true }],
    ['/compat/tavily/search', { query: 'q', include_domains: ['example.com'] }],
    ['/compat/search1api/search', { query: 'q', page: 2 }],
    ['/compat/firecrawl/v2/scrape', { url: 'https://example.com', formats: ['screenshot'] }],
  ])('rejects unsupported semantics without calling a provider: %s', async (path, data) => {
    const { app, calls } = build();
    const result = await app.request(path, data ? post(data) : { headers: { Authorization: 'Bearer Gateway-Key' } });
    expect(result.status).toBe(422);
    expect(calls).toHaveLength(0);
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

  it('falls back from native failure only when translation preserves supported options', async () => {
    const mock = mockFetch((url) => url.hostname === 'api.exa.ai' ? json({ error: 'limited', tag: 'RATE_LIMIT' }, 429) : json({ organic: [{ title: 'Fallback', link: 'https://example.com', snippet: 'x' }] }));
    const gateway = createGateway({ providers: { exa: { apiKey: 'e' }, serper: { apiKey: 's' } }, chain: ['exa', 'serper'], fetch: mock.fetch });
    const app = createApp({ gateway, mcp: false });
    const fallback = await app.request('/compat/exa/search', post({ query: 'q', contents: false }));
    expect(fallback.status).toBe(200);
    expect(fallback.headers.get('X-Search2AI-Provider')).toBe('serper');
    const restricted = await app.request('/compat/exa/search', post({ query: 'q', type: 'neural' }));
    expect(restricted.status).toBe(429);
    expect(await restricted.json()).toMatchObject({ tag: 'RATE_LIMIT' });
    expect(mock.calls.filter((c) => c.url.hostname === 'google.serper.dev')).toHaveLength(1);
  });

  it('skips an incapable earlier provider while retaining native advanced options', async () => {
    const mock = mockFetch(() => json({ results: [{ highlights: ['native'] }] }));
    const gateway = createGateway({ providers: { serper: { apiKey: 's' }, exa: { apiKey: 'e' } }, chain: ['serper', 'exa'], fetch: mock.fetch });
    const result = await createApp({ gateway, mcp: false }).request('/compat/exa/search', post({ query: 'q', contents: { highlights: true } }));
    expect(result.status).toBe(200);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url.hostname).toBe('api.exa.ai');
  });

  it('preserves Exa beta headers only for native Exa and does not leak gateway authorization', async () => {
    const mock = mockFetch(() => json({ results: [] }));
    const gateway = createGateway({ providers: { serper: { apiKey: 's' }, exa: { apiKey: 'e' } }, chain: ['serper', 'exa'], fetch: mock.fetch });
    const result = await createApp({ gateway, authKeys: ['Gateway-Key'], mcp: false }).request('/compat/exa/search', { ...post({ query: 'q', contents: false }), headers: { ...post({}).headers, 'Exa-Beta': 'dynamic-highlights-2026-08-28' } });
    expect(result.status).toBe(200);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].headers['exa-beta']).toBe('dynamic-highlights-2026-08-28');
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

  it('applies the SearXNG language filter only through capable translated providers', async () => {
    const mock = mockFetch(() => json({ results: [{ title: 'Found', link: 'https://example.com', snippet: 'x' }] }));
    const gateway = createGateway({ providers: { search1api: { apiKey: 's' }, serper: { apiKey: 'g' } }, chain: ['serper', 'search1api'], fetch: mock.fetch });
    const result = await createApp({ gateway, mcp: false }).request('/compat/searxng/search?q=q&format=json&language=en');
    expect(result.status).toBe(200);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].body).toMatchObject({ language: 'en' });
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
