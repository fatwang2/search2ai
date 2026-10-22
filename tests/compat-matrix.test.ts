import { describe, expect, it } from 'vitest';
import { createGateway } from '../src/core/gateway.ts';
import { createApp } from '../src/server/app.ts';
import { json, mockFetch } from './helpers.ts';

const page = 'https://example.com/page';
const content = '# Actual page content';
const item = { title: 'Page', url: page, link: page, snippet: 'Preview', description: 'Preview', content: 'Preview', highlights: ['Preview'] };
const providers = {
  serper: { apiKey: 's' },
  brave: { apiKey: 'b' },
  google: { apiKey: 'g', cx: 'cx' },
  exa: { apiKey: 'e' },
  tavily: { apiKey: 't' },
  search1api: { apiKey: 's1' },
  searxng: { baseUrl: 'https://searx.example' },
  firecrawl: { apiKey: 'f' },
  jina: {},
};
const post = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// Fixtures use each backend's actual envelope, so SDK-facing shape conversion is exercised.
function upstream(url: URL): Response {
  if (url.hostname === 'google.serper.dev') return json({ organic: [item], news: [item] });
  if (url.hostname === 'api.search.brave.com') return json({ web: { results: [item] }, results: [item] });
  if (url.hostname === 'www.googleapis.com') return json({ items: [item] });
  if (url.hostname === 'searx.example') return json({ query: 'q', results: [item] });
  if (url.hostname === 'r.jina.ai') return json({ data: { title: 'Page', url: page, content } });
  if (url.hostname === 'api.firecrawl.dev') return json({ success: true, data: { markdown: content, metadata: { title: 'Page', sourceURL: page } } });
  if (url.pathname === '/contents') return json({ results: [{ ...item, text: content }] });
  if (url.pathname === '/extract') return json({ results: [{ url: page, raw_content: content }], failed_results: [] });
  if (url.pathname === '/crawl') return json({ results: { title: 'Page', link: page, content } });
  return json({ results: [item] });
}

describe('provider and client protocol combinations', () => {
  const searchProviders = ['serper', 'brave', 'google', 'exa', 'tavily', 'search1api', 'searxng'] as const;
  const protocols = ['exa', 'tavily', 'search1api', 'searxng'] as const;
  it.each(searchProviders.flatMap((provider) => protocols.map((protocol) => ({ provider, protocol }))))('$provider serves $protocol search despite extra client options', async ({ provider, protocol }) => {
    const mock = mockFetch(upstream);
    const gateway = createGateway({ providers: { [provider]: providers[provider] }, fetch: mock.fetch });
    const app = createApp({ gateway, mcp: false });
    const response = protocol === 'searxng'
      ? await app.request('/compat/searxng/search?q=q&pageno=2&engines=google&custom_option=1')
      : await app.request(`/compat/${protocol}/search`, post({ query: 'q', custom_option: true, ...(protocol === 'exa' ? { contents: false, type: 'neural' } : {}) }));
    expect(response.status).toBe(200);
    expect((await response.json()).results[0].title).toBe('Page');
    expect(response.headers.get('X-Search2AI-Provider')).toBe(provider);
    expect(response.headers.get('X-Search2AI-Mode')).toBe(provider === protocol ? 'native' : 'translated');
    if (provider !== protocol) expect(response.headers.get('X-Search2AI-Ignored')).toContain('custom_option');
    expect(mock.calls).toHaveLength(1);
  });

  const crawlProviders = ['jina', 'firecrawl', 'exa', 'tavily', 'search1api'] as const;
  const reads = [
    { protocol: 'exa', path: '/contents', body: { urls: [page], text: true, custom_option: true }, text: (b: any) => b.results[0].text },
    { protocol: 'tavily', path: '/extract', body: { urls: [page], extract_depth: 'advanced', custom_option: true }, text: (b: any) => b.results[0].raw_content },
    { protocol: 'search1api', path: '/crawl', body: { url: page, custom_option: true }, text: (b: any) => b.results.content },
    { protocol: 'firecrawl', path: '/v2/scrape', body: { url: page, formats: ['markdown'], custom_option: true }, text: (b: any) => b.data.markdown },
  ];
  it.each(crawlProviders.flatMap((provider) => reads.map((read) => ({ provider, ...read }))))('$provider serves $protocol page reads despite extra client options', async ({ provider, protocol, path, body, text }) => {
    const mock = mockFetch(upstream);
    const gateway = createGateway({ providers: { [provider]: providers[provider] }, fetch: mock.fetch });
    const response = await createApp({ gateway, mcp: false }).request(`/compat/${protocol}${path}`, post(body));
    expect(response.status).toBe(200);
    expect(text(await response.json())).toBe(content);
    expect(response.headers.get('X-Search2AI-Provider')).toBe(provider);
    if (provider !== protocol) expect(response.headers.get('X-Search2AI-Ignored')).toContain('custom_option');
    expect(mock.calls).toHaveLength(1);
  });
});
