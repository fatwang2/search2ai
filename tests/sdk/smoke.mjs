import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Exa from 'exa-js';
import { tavily } from '@tavily/core';
import { Search1API } from '@search1api/client';
import Firecrawl from '@mendable/firecrawl-js';
import { SearxngSearch } from '@langchain/community/tools/searxng_search';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createApp } from '../../src/server/app.ts';
import { createGateway } from '../../src/core/gateway.ts';

const json = (body) => Response.json(body);
const upstreamCalls = [];
const mockFetch = async (input, init) => {
  const u = new URL(input);
  upstreamCalls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers)), body: init?.body && JSON.parse(init.body) });
  const entry = { title: 'SDK Page', url: 'https://example.com/a', text: '# SDK Page\nBody', content: 'SDK preview', raw_content: '# SDK Page\nBody', snippet: 'SDK preview', link: 'https://example.com/a', highlights: ['SDK preview'], score: 0.8 };
  if (u.hostname === 'google.serper.dev') return json({ organic: [entry], news: [entry] });
  if (u.hostname === 'r.jina.ai') return json({ data: { title: entry.title, url: entry.url, content: entry.text } });
  if (u.hostname === 'searx.example') return json({ query: u.searchParams.get('q'), results: [entry], answers: [], infoboxes: [], suggestions: [] });
  if (u.hostname === 'api.exa.ai') return json({ requestId: 'native-exa', results: [entry], statuses: [{ id: entry.url, status: 'success' }] });
  if (u.hostname === 'api.tavily.com') return json({ query: 'q', results: [entry], failed_results: [], images: [], response_time: 0.1, request_id: 'native-tavily' });
  if (u.hostname === 'api.search1api.com') return json({ searchParameters: { query: 'q' }, crawlParameters: { url: entry.url }, results: u.pathname === '/crawl' ? { title: entry.title, link: entry.url, content: entry.text } : [entry] });
  if (u.hostname === 'api.firecrawl.dev') return json({ success: true, data: { markdown: entry.text, metadata: { title: entry.title, sourceURL: entry.url } } });
  throw new Error(`Unexpected upstream ${u}`);
};
const key = 'Gateway-Key';
const root = new Hono();
const incoming = [];
root.use('*', async (c, next) => {
  incoming.push({ method: c.req.method, path: new URL(c.req.url).pathname });
  await next();
});
root.route('/gateway', createApp({ gateway: createGateway({ providers: { serper: { apiKey: 'upstream-serper' }, jina: { apiKey: 'upstream-reader' } }, fetch: mockFetch }), authKeys: [key], mcp: false }));
for (const protocol of ['exa', 'tavily', 'search1api', 'firecrawl', 'searxng']) {
  root.route(`/native/${protocol}`, createApp({ gateway: createGateway({ providers: { [protocol]: protocol === 'searxng' ? { baseUrl: 'https://searx.example' } : { apiKey: `upstream-${protocol}` } }, fetch: mockFetch }), authKeys: [key], mcp: false }));
}
const server = serve({ fetch: root.fetch, hostname: '127.0.0.1', port: 0 });
await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  for (const mode of ['gateway', 'native']) {
    const base = (protocol) => `${origin}/${mode === 'gateway' ? 'gateway' : `native/${protocol}`}/compat/${protocol}`;
    const exa = new Exa(key, base('exa'));
    assert.equal((await exa.search('q')).results[0].title, 'SDK Page');
    assert.equal((await exa.getContents(['https://example.com/a'], { text: true })).results[0].text, '# SDK Page\nBody');
    const tv = tavily({ apiKey: key, apiBaseURL: base('tavily') });
    assert.equal((await tv.search('q')).results[0].title, 'SDK Page');
    assert.equal((await tv.extract(['https://example.com/a'])).results[0].rawContent, '# SDK Page\nBody');
    const s1 = new Search1API({ apiKey: key, baseUrl: base('search1api') });
    assert.equal((await s1.search('q')).results[0].title, 'SDK Page');
    assert.equal((await s1.news('q')).results[0].title, 'SDK Page');
    assert.equal((await s1.crawl('https://example.com/a')).results.content, '# SDK Page\nBody');
    const fc = new Firecrawl({ apiKey: key, apiUrl: base('firecrawl') });
    assert.equal((await fc.scrape('https://example.com/a', { formats: ['markdown'] })).markdown, '# SDK Page\nBody');
    const searx = new SearxngSearch({ apiBase: base('searxng'), headers: { Authorization: `Bearer ${key}` } });
    assert.match(await searx.invoke('q'), /SDK Page/);
    console.log(`${mode}: Exa search/contents; Tavily search/extract; Search1API search/news/crawl; Firecrawl scrape; LangChain SearXNG OK`);
  }
  assert.ok(upstreamCalls.every((c) => !Object.values(c.headers).includes(key) && !JSON.stringify(c.body ?? null).includes(key)));
  for (const name of ['exa-js', '@tavily/core', '@search1api/client', '@mendable/firecrawl-js', '@langchain/community', '@langchain/core']) {
    const pkg = JSON.parse(readFileSync(new URL(`./node_modules/${name}/package.json`, import.meta.url), 'utf8'));
    console.log(`${name}@${pkg.version}`);
  }
  console.log(JSON.stringify(incoming, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
