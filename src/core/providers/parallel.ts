/** Anonymous Parallel Search MCP. Crawl is opt-in; news and strict filters remain with other providers. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js';
import { z } from 'zod';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { version } from '../../version.ts';
import { codeFromStatus, ProviderError, toProviderError } from '../errors.ts';
import type { ProviderContext, SearchProvider } from '../types.ts';

export interface ParallelOptions {
  /** Enable page fetching only when explicitly requested. Default false. */
  crawl?: boolean;
}

const endpoint = 'https://search.parallel.ai/mcp';
const itemSchema = z.object({
  url: z.url().refine((url) => /^https?:\/\//i.test(url)),
  title: z.string().nullable().optional(),
  publish_date: z.string().nullable().optional(),
  excerpts: z.array(z.string()),
  full_content: z.string().nullable().optional(),
});
const resultSchema = z.object({ results: z.array(itemSchema) });

async function callTool(name: string, args: Record<string, unknown>, ctx: ProviderContext) {
  // A connection belongs to this operation. Conversation identity comes from the
  // gateway's research run, never from this transport or the provider instance.
  const client = new Client({ name: 'search2ai', version }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('User-Agent', `search2ai/${version}`);
      const signal = init?.signal ? AbortSignal.any([ctx.signal, init.signal]) : ctx.signal;
      const response = await ctx.fetch(input, { ...init, headers, signal });
      if (!response.ok && init?.method === 'POST') {
        throw new ProviderError('parallel', codeFromStatus(response.status), `parallel: HTTP ${response.status} ${(await response.text()).slice(0, 500)}`, response.status);
      }
      return response;
    },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  });
  try {
    ctx.signal.throwIfAborted();
    await client.connect(transport, { signal: ctx.signal });
    const tools = await client.listTools({}, { signal: ctx.signal });
    if (!tools.tools.some((tool) => tool.name === name)) throw new ProviderError('parallel', 'unsupported', `parallel: MCP tool unavailable: ${name}`);
    const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: { ...args, session_id: ctx.sessionId ?? crypto.randomUUID() } }, undefined, { signal: ctx.signal }));
    if (result.isError) {
      const message = result.content.filter((c) => c.type === 'text').map((c) => c.text).join(' ');
      throw new ProviderError('parallel', /quota|rate.limit/i.test(message) ? 'rate_limit' : 'upstream', `parallel: ${message}`);
    }
    let data: unknown = result.structuredContent;
    if (!data) {
      const text = result.content.find((c) => c.type === 'text');
      try { data = text?.type === 'text' ? JSON.parse(text.text) : undefined; }
      catch { throw new ProviderError('parallel', 'upstream', 'parallel: invalid MCP JSON result'); }
    }
    const parsed = resultSchema.safeParse(data);
    if (!parsed.success) throw new ProviderError('parallel', 'upstream', 'parallel: invalid MCP result shape');
    return parsed.data.results;
  } catch (error) {
    throw toProviderError('parallel', error, ctx.signal);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function createParallel(opts: ParallelOptions = {}): SearchProvider {
  return {
    name: 'parallel',
    async search(p, ctx) {
      // The anonymous MCP schema has no strict filter parameters. Never silently
      // drop a caller's filters or pretend natural-language guidance enforces them.
      if (p.country || p.languages?.length || p.domains?.length || p.recency || p.afterDate || p.beforeDate) {
        throw new ProviderError('parallel', 'unsupported', 'parallel: strict search filters require another configured provider');
      }
      const results = await callTool('web_search', { objective: p.query, search_queries: [p.query] }, ctx);
      return results.slice(0, p.maxResults).map((item) => ({
        title: item.title ?? '', url: item.url, snippet: item.excerpts.join('\n\n'),
        ...(item.publish_date ? { date: item.publish_date } : {}),
      }));
    },
    ...(opts.crawl ? {
      async crawl(url: string, ctx: ProviderContext) {
        if (!/^https?:\/\//i.test(url)) throw new ProviderError('parallel', 'bad_request', 'parallel: crawl requires an HTTP or HTTPS URL');
        const items = await callTool('web_fetch', { urls: [url], full_content: true }, ctx);
        const item = items[0];
        if (!item) throw new ProviderError('parallel', 'upstream', 'parallel: page extraction failed');
        return { url: item.url, ...(item.title ? { title: item.title } : {}), content: item.full_content ?? item.excerpts.join('\n\n') };
      },
    } : {}),
  };
}
