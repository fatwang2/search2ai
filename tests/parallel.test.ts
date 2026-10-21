import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createGateway, type Gateway } from '../src/core/gateway.ts';
import { configFromEnv } from '../src/core/config.ts';
import { createGatewayFromEnv } from '../src/hono.ts';
import { createApp } from '../src/server/app.ts';
import { createMcpServer } from '../src/mcp/server.ts';
import { createChatProxy } from '../src/chat/proxy.ts';
import { version } from '../src/version.ts';
import { json, mockFetch, sse, chunk, readSse, type RecordedCall } from './helpers.ts';

const page = { title: 'MCP documentation', url: 'https://example.com/docs', excerpts: ['Useful search excerpt'], publish_date: '2026-10-01' };
type Rpc = { id?: number; method: string; params?: { name: string; arguments: Record<string, unknown> } };

// Only the remote HTTP boundary is simulated. Production SDK handshake,
// discovery, tools/call, gateway routing and result parsing all execute.
function parallelRemote(reply?: (rpc: Rpc, call: RecordedCall) => unknown) {
  return mockFetch((_url, call) => {
    if (call.init.method === 'GET') return new Response(null, { status: 405 });
    const rpc = call.body as Rpc;
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    const custom = reply?.(rpc, call);
    if (custom instanceof Response || custom instanceof Promise) return custom;
    const result = custom ?? (rpc.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : rpc.method === 'tools/list'
        ? { tools: ['web_search', 'web_fetch'].map((name) => ({ name, inputSchema: { type: 'object' } })) }
        : { content: [{ type: 'text', text: JSON.stringify({ results: [{ ...page, ...(rpc.params?.name === 'web_fetch' ? { full_content: '# Full page' } : {}) }] }) }] });
    return json({ jsonrpc: '2.0', id: rpc.id, result });
  });
}
const toolCalls = (calls: RecordedCall[]) => calls.filter((c) => (c.body as Rpc)?.method === 'tools/call').map((c) => (c.body as Rpc).params!);
const gateway = (fetch: typeof globalThis.fetch, extra = {}) => createGateway({ providers: { parallel: { crawl: true } }, fetch, ...extra });

function post(app: ReturnType<typeof createApp>, path: string, data: unknown, headers: Record<string, string> = {}) {
  return app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
}

describe('Parallel configuration and caller', () => {
  it('stays unselected until it is named, leaving every other configuration untouched', async () => {
    const { fetch, calls } = parallelRemote();
    const unconfigured = createGatewayFromEnv({}, { fetch });
    expect(unconfigured.chain('search')).toEqual([]);
    expect(unconfigured.chain('news')).toEqual([]);
    expect(unconfigured.chain('crawl')).toEqual([]);
    await expect(unconfigured.search({ query: 'no provider configured' })).rejects.toMatchObject({ code: 'no_provider' });
    expect(configFromEnv({}).providers).toEqual({});
    for (const env of [{ SEARCH1API_KEY: 'saved' }, { SEARCH1API_SERVICE: 'arxiv' }, { SEARXNG_BASE_URL: 'https://local.example' }, { JINA_KEY: 'saved' }, { GOOGLE_KEY: 'saved' }, { GOOGLE_CX: 'saved' }, { SEARCH_SERVICE: 'tavily' }]) {
      expect(configFromEnv(env).providers).not.toHaveProperty('parallel');
    }
    expect(configFromEnv({ SEARCH1API_KEY: 'saved' }).providers).toEqual({ search1api: { apiKey: 'saved', searchService: undefined } });
    expect(createGatewayFromEnv({ SEARCH_SERVICE: 'tavily' }).chain('search')).toEqual([]);
    expect(createGatewayFromEnv({}, { providers: { tavily: { apiKey: 'saved' } } }).chain('search')).toEqual(['tavily']);
    expect(calls).toHaveLength(0);
  });

  it('is selected by SEARCH_SERVICE, CRAWL_SERVICE or an explicit provider option', () => {
    const search = createGatewayFromEnv({ SEARCH_SERVICE: 'parallel' });
    expect(search.chain('search')).toEqual(['parallel']);
    expect(search.chain('crawl')).toEqual([]);
    expect(search.chain('news')).toEqual([]);
    expect(createGatewayFromEnv({ SEARCH_SERVICE: 'parallel', CRAWL_SERVICE: 'parallel' }).chain('crawl')).toEqual(['parallel']);
    expect(createGatewayFromEnv({ CRAWL_SERVICE: 'parallel' }).chain('crawl')).toEqual(['parallel']);
    expect(createGateway({ providers: { parallel: {} } }).chain('search')).toEqual(['parallel']);
    expect(createGateway({ providers: { parallel: {} } }).chain('crawl')).toEqual([]);
    expect(createGateway({ providers: { parallel: { crawl: true } } }).chain('crawl')).toEqual(['parallel']);
    expect(createGatewayFromEnv({ SEARCH_SERVICE: 'parallel,tavily', TAVILY_KEY: 'saved' }).chain('search')).toEqual(['parallel', 'tavily']);
  });

  it('answers search over the keyless MCP endpoint once selected', async () => {
    const { fetch, calls } = parallelRemote();
    const g = createGatewayFromEnv({ SEARCH_SERVICE: 'parallel' }, { fetch });
    const result = await g.search({ query: 'MCP documentation', max_results: 1 });
    expect(result).toMatchObject({ provider: 'parallel', results: [{ title: page.title, url: page.url, snippet: page.excerpts[0], date: page.publish_date }] });
    expect(result.session_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(toolCalls(calls)[0]).toMatchObject({ name: 'web_search', arguments: { objective: 'MCP documentation', search_queries: ['MCP documentation'], session_id: result.session_id } });
    expect(calls.filter((c) => c.init.method === 'POST').map((c) => (c.body as Rpc).method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    for (const call of calls) {
      expect(call.url.href).toBe('https://search.parallel.ai/mcp');
      expect(call.headers['user-agent']).toBe(`search2ai/${version}`);
      expect(call.headers.authorization).toBeUndefined();
      expect(call.headers['x-api-key']).toBeUndefined();
    }
  });

  it('keeps configured provider failures, overrides and disabled chains authoritative', async () => {
    const remote = parallelRemote();
    const configured = mockFetch(() => new Response('invalid key', { status: 401 }));
    const g = createGatewayFromEnv({ TAVILY_KEY: 'explicit-bad-key' }, { fetch: configured.fetch });
    await expect(g.search({ query: 'x' })).rejects.toMatchObject({ code: 'all_providers_failed', warnings: [{ provider: 'tavily', code: 'auth' }] });
    expect(configured.calls.every((c) => c.url.hostname === 'api.tavily.com')).toBe(true);
    const both = gateway(remote.fetch, { providers: { parallel: {}, tavily: { apiKey: 't' } }, chain: ['parallel'] });
    await expect(both.search({ query: 'x', providers: ['missing'] })).rejects.toMatchObject({ code: 'unknown_provider' });
    await expect(both.search({ query: 'x', providers: ['brave'] })).rejects.toMatchObject({ code: 'provider_not_configured' });
    await expect(createGateway({ providers: { parallel: {} }, chain: [], fetch: remote.fetch }).search({ query: 'x' })).rejects.toMatchObject({ code: 'no_provider' });
    expect(remote.calls).toHaveLength(0);
  });

  it('rejects unsupported strict filters without sending a request', async () => {
    const { fetch, calls } = parallelRemote();
    const g = gateway(fetch);
    for (const filter of [{ country: 'US' }, { search_domain_filter: ['example.com'] }, { search_language_filter: ['en'] }, { search_recency_filter: 'day' as const }, { search_after_date_filter: '2026-01-01' }, { search_before_date_filter: '2026-10-01' }]) {
      await expect(g.search({ query: 'x', ...filter })).rejects.toMatchObject({ warnings: [{ provider: 'parallel', code: 'unsupported' }] });
    }
    await expect(g.news({ query: 'x' })).rejects.toMatchObject({ code: 'no_provider' });
    expect(calls).toHaveLength(0);
  });

  it('shares a run ID for array queries, enrichment, fetch and follow-up, separating concurrent runs and reset', async () => {
    const { fetch, calls } = parallelRemote();
    const g = gateway(fetch);
    const [a, b] = await Promise.all([
      g.search({ query: ['first angle', 'second angle'], crawl_results: 1 }),
      g.search({ query: 'independent task' }),
    ]);
    expect(a.results[0].content).toBe('# Full page');
    expect(a.session_id).not.toBe(b.session_id);
    const follow = await g.search({ query: 'follow up', session_id: a.session_id });
    const fetched = await g.crawl({ url: page.url, session_id: a.session_id });
    expect(follow.session_id).toBe(a.session_id);
    expect(fetched).toMatchObject({ content: '# Full page', session_id: a.session_id });
    const reset = await g.search({ query: 'new task' });
    expect(reset.session_id).not.toBe(a.session_id);
    const recorded = toolCalls(calls);
    const taskB = recorded.find((c) => c.arguments.objective === 'independent task')!;
    expect(taskB.arguments.session_id).toBe(b.session_id);
    const runA = recorded.filter((c) => ['first angle', 'second angle', 'follow up'].includes(c.arguments.objective as string) || c.name === 'web_fetch');
    expect(runA).toHaveLength(5);
    expect(new Set(runA.map((c) => c.arguments.session_id))).toEqual(new Set([a.session_id]));
  });

  it('never reuses a cached response conversation ID', async () => {
    const { fetch, calls } = parallelRemote();
    const g = gateway(fetch, { cacheTtlSeconds: 60 });
    const a = await g.search({ query: 'same query' });
    const b = await g.search({ query: 'same query' });
    expect(b.cached).toBe(true);
    expect(a.session_id).not.toBe(b.session_id);
    expect(toolCalls(calls)).toHaveLength(1);
    const explicit = await g.search({ query: 'same query', session_id: a.session_id });
    expect(explicit.session_id).toBe(a.session_id);
  });

  it('uses REST result consumption with authentication and disabled MCP preserved', async () => {
    const { fetch, calls } = parallelRemote();
    const app = createApp({ gateway: gateway(fetch), authKeys: ['secret'], mcp: false });
    expect((await post(app, '/v1/search', { query: 'x' })).status).toBe(401);
    expect(calls).toHaveLength(0);
    expect((await post(app, '/mcp', {})).status).toBe(401);
    const result = await post(app, '/v1/search', { query: 'x' }, { Authorization: 'Bearer secret' });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ provider: 'parallel', results: [{ url: page.url, snippet: page.excerpts[0] }] });
    expect((await post(app, '/mcp', {}, { Authorization: 'Bearer secret' })).status).toBe(404);
    expect((await post(app, '/v1/search', { query: 'x', session_id: 'personal-data' }, { Authorization: 'Bearer secret' })).status).toBe(400);
    await expect(gateway(fetch).crawl({ url: 'file:///etc/passwd' })).rejects.toMatchObject({ warnings: [{ code: 'bad_request' }] });
  });

  it('dispatches tools through the MCP server and consumes its JSON result', async () => {
    const { fetch } = parallelRemote();
    const server = createMcpServer(gateway(fetch), 'test');
    const client = new Client({ name: 'test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a);
      await client.connect(b);
      const result = await client.callTool({ name: 'search', arguments: { query: 'MCP documentation' } });
      expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toMatchObject({ provider: 'parallel', results: [{ url: page.url }] });
    } finally { await client.close(); await server.close(); }
  });

  it('dispatches through the public HTTP MCP transport', async () => {
    const { fetch } = parallelRemote();
    const app = createApp({ gateway: gateway(fetch) });
    const client = new Client({ name: 'test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: async (input, init) => app.fetch(new Request(input, init)),
    });
    try {
      await client.connect(transport);
      await client.listTools();
      const result = await client.callTool({ name: 'search', arguments: { query: 'MCP documentation' } });
      expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toMatchObject({ results: [{ url: page.url, snippet: page.excerpts[0] }] });
    } finally { await client.close(); }
  });
});

describe('Parallel error and cancellation paths', () => {
  it.each([401, 429, 503])('classifies HTTP %s', async (status) => {
    const { fetch } = parallelRemote((rpc) => rpc.method === 'tools/call' ? new Response('provider error', { status }) : undefined);
    await expect(gateway(fetch).search({ query: 'x' })).rejects.toMatchObject({ warnings: [{ provider: 'parallel', status, code: status === 401 ? 'auth' : status === 429 ? 'rate_limit' : 'upstream' }] });
  });

  it.each([
    { content: [{ type: 'text', text: 'free quota exceeded' }], isError: true },
    { content: [{ type: 'text', text: 'not JSON' }] },
    { content: [{ type: 'text', text: '{"wrong":[]}' }] },
    { content: [{ type: 'text', text: '{"results":[{"url":"javascript:alert(1)","excerpts":[]}]}' }] },
  ])('rejects tool errors or malformed results: %j', async (result) => {
    const { fetch } = parallelRemote((rpc) => rpc.method === 'tools/call' ? result : undefined);
    await expect(gateway(fetch).search({ query: 'x' })).rejects.toMatchObject({ code: 'all_providers_failed' });
  });

  it('retains the same conversation ID when retrying after quota', async () => {
    let attempt = 0;
    const { fetch, calls } = parallelRemote((rpc) => rpc.method === 'tools/call' && attempt++ === 0 ? { isError: true, content: [{ type: 'text', text: 'quota exceeded' }] } : undefined);
    const g = gateway(fetch);
    const session_id = crypto.randomUUID();
    await expect(g.search({ query: 'x', session_id })).rejects.toMatchObject({ warnings: [{ code: 'rate_limit' }] });
    await g.search({ query: 'x', session_id });
    expect(toolCalls(calls).map((c) => c.arguments.session_id)).toEqual([session_id, session_id]);
  });

  function stalled() {
    return parallelRemote((rpc, call) => rpc.method === 'tools/call' ? new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException('aborted', 'AbortError'));
      if (call.init.signal?.aborted) abort();
      else call.init.signal?.addEventListener('abort', abort, { once: true });
    }) : undefined);
  }
  it('bounds the complete MCP operation with the configured provider timeout', async () => {
    const { fetch } = stalled();
    await expect(gateway(fetch, { timeoutMs: 40 }).search({ query: 'x' })).rejects.toMatchObject({ warnings: [{ provider: 'parallel', code: 'timeout' }] });
  });

  it('stops a cancelled request before fallback and makes no request when already aborted', async () => {
    const { fetch, calls } = stalled();
    const controller = new AbortController();
    const g = gateway(fetch, { providers: { parallel: {}, tavily: { apiKey: 't' } }, chain: ['parallel', 'tavily'] });
    const request = g.search({ query: 'x' }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls.every((c) => c.url.hostname === 'search.parallel.ai')).toBe(true);
    const count = calls.length;
    await expect(g.search({ query: 'x' }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(count);
  });
});

// Scripted OpenAI tool calls test the real proxy loop; this is not a live model test.
describe('scripted chat tool execution', () => {
  function scriptedProxy(g: Gateway, streaming = false) {
    const observed: unknown[] = [];
    const model = mockFetch((_url, call) => {
      const body = call.body as { messages: Array<{ role: string; content: string }>; search_session_id?: unknown; stream?: boolean };
      expect(body.search_session_id).toBeUndefined();
      const tools = body.messages.filter((m) => m.role === 'tool');
      observed.push(...tools.map((m) => JSON.parse(m.content)));
      const name = tools.length === 0 ? 'search' : tools.length === 1 ? 'crawler' : tools.length === 2 ? 'search' : null;
      const tool = name ? { id: `call-${tools.length}`, type: 'function', function: { name, arguments: JSON.stringify(name === 'crawler' ? { url: page.url } : { query: 'MCP documentation' }) } } : null;
      if (body.stream) return sse([chunk(tool ? { tool_calls: [{ ...tool, index: 0 }] } : { content: 'Answer with https://example.com/docs' }, tool ? 'tool_calls' : 'stop')]);
      return json({ choices: [{ message: tool ? { role: 'assistant', content: null, tool_calls: [tool] } : { role: 'assistant', content: 'Answer with https://example.com/docs' }, finish_reason: tool ? 'tool_calls' : 'stop' }] });
    });
    return { proxy: createChatProxy(g, { apiBase: 'https://model.example/v1', type: 'openai', authKeys: [], fetch: model.fetch }), observed };
  }

  it.each([false, true])('searches, fetches and consumes results with one run ID; stream=%s', async (stream) => {
    const { fetch, calls } = parallelRemote();
    const g = gateway(fetch);
    const { proxy, observed } = scriptedProxy(g, stream);
    const result = await proxy.handleChat('model-key', { model: 'scripted', messages: [{ role: 'user', content: 'Research MCP' }], stream });
    const sessionId = result.headers['X-Search2AI-Session-Id'];
    const body = typeof result.body === 'string' ? result.body : (await readSse(new Response(result.body))).raw;
    expect(body).toContain('https://example.com/docs');
    expect(observed).toContainEqual(expect.objectContaining({ results: [expect.objectContaining({ url: page.url, snippet: page.excerpts[0] })] }));
    expect(toolCalls(calls).map((c) => c.name)).toEqual(['web_search', 'web_fetch', 'web_search']);
    expect(new Set(toolCalls(calls).map((c) => c.arguments.session_id))).toEqual(new Set([sessionId]));
    const follow = await proxy.handleChat('model-key', { messages: [{ role: 'user', content: 'Follow up' }], search_session_id: sessionId });
    expect(follow.headers['X-Search2AI-Session-Id']).toBe(sessionId);
    const [other, reset] = await Promise.all([
      proxy.handleChat('model-key', { messages: [{ role: 'user', content: 'Other conversation' }] }),
      proxy.handleChat('model-key', { messages: [{ role: 'user', content: 'Reset' }] }),
    ]);
    expect(other.headers['X-Search2AI-Session-Id']).not.toBe(sessionId);
    expect(reset.headers['X-Search2AI-Session-Id']).not.toBe(other.headers['X-Search2AI-Session-Id']);
    const ids = toolCalls(calls).map((c) => c.arguments.session_id);
    expect(ids.filter((id) => id === sessionId)).toHaveLength(6);
    expect(ids.filter((id) => id === other.headers['X-Search2AI-Session-Id'])).toHaveLength(3);
    expect(ids.filter((id) => id === reset.headers['X-Search2AI-Session-Id'])).toHaveLength(3);
  });
});

describe('first-failure research identity', () => {
  function quotaThenSuccess() {
    let first = true;
    return parallelRemote((rpc) => {
      if (rpc.method !== 'tools/call' || !first) return undefined;
      first = false;
      return { isError: true, content: [{ type: 'text', text: 'anonymous quota exceeded' }] };
    });
  }

  it('returns the initially generated UUID on a library error for retry', async () => {
    const { fetch, calls } = quotaThenSuccess();
    const g = gateway(fetch);
    const error = await g.search({ query: 'first failure' }).catch((e) => e);
    expect(error.session_id).toMatch(/^[a-f0-9-]{36}$/);
    const result = await g.search({ query: 'first failure', session_id: error.session_id });
    expect(toolCalls(calls).map((c) => c.arguments.session_id)).toEqual([error.session_id, error.session_id]);
    expect(result.session_id).toBe(error.session_id);
  });

  it('keeps the initial task UUID in REST errors and retries', async () => {
    const { fetch, calls } = quotaThenSuccess();
    const app = createApp({ gateway: gateway(fetch) });
    const first = await post(app, '/v1/search', { query: 'first failure' });
    expect(first.status).toBe(502);
    const { error } = await first.json();
    expect(error.session_id).toMatch(/^[a-f0-9-]{36}$/);
    const retry = await post(app, '/v1/search', { query: 'first failure', session_id: error.session_id });
    expect(retry.status).toBe(200);
    expect(toolCalls(calls).map((c) => c.arguments.session_id)).toEqual([error.session_id, error.session_id]);
  });

  it('keeps the initial task UUID in MCP errors and retries through the HTTP dispatcher', async () => {
    const { fetch, calls } = quotaThenSuccess();
    const app = createApp({ gateway: gateway(fetch) });
    const client = new Client({ name: 'test', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), { fetch: async (input, init) => app.fetch(new Request(input, init)) }));
      const first = await client.callTool({ name: 'search', arguments: { query: 'first failure' } });
      expect(first.isError).toBe(true);
      const session_id = (first.structuredContent as { error: { session_id: string } }).error.session_id;
      expect(session_id).toMatch(/^[a-f0-9-]{36}$/);
      expect((first.content as Array<{ text: string }>)[0].text).toContain(session_id);
      const retry = await client.callTool({ name: 'search', arguments: { query: 'first failure', session_id } });
      expect(retry.isError).not.toBe(true);
      expect(toolCalls(calls).map((c) => c.arguments.session_id)).toEqual([session_id, session_id]);
    } finally { await client.close(); }
  });
});
