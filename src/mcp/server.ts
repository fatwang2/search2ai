/**
 * MCP server: 把网关的 search / news / crawl 暴露为 MCP 工具。
 * 同一个定义同时用于 HTTP(Streamable HTTP, 挂在 Hono 的 /mcp)与本地 stdio(`npx search2ai mcp`)。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Gateway } from '../core/gateway.ts';
import { GatewayError } from '../core/errors.ts';
import { CrawlRequestSchema, SearchRequestSchema } from '../core/schema.ts';

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function errorResult(error: unknown) {
  const message = error instanceof GatewayError ? `${error.message}${error.warnings.length ? ` (${error.warnings.map((w) => w.message).join('; ')})` : ''}` : String((error as Error)?.message ?? error);
  const sessionId = error instanceof GatewayError ? error.session_id : undefined;
  return {
    content: [{ type: 'text' as const, text: `${message}${sessionId ? ` [session_id=${sessionId}]` : ''}` }],
    ...(sessionId ? { structuredContent: { error: { message, session_id: sessionId } } } : {}),
    isError: true,
  };
}

export function createMcpServer(gateway: Gateway, version: string): McpServer {
  const server = new McpServer(
    { name: 'search2ai', version },
    { maxToolInputElements: 10_000 }
  );

  server.registerTool(
    'search',
    {
      title: 'Web search',
      description:
        'Search the web. Returns ranked results with title, url, snippet and date. Tries the configured search providers in order (fallback) and reports which provider answered.',
      inputSchema: SearchRequestSchema.shape,
    },
    async (args, extra) => {
      try {
        return textResult(await gateway.search(args, { signal: extra.signal }));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'news',
    {
      title: 'News search',
      description: 'Search recent news. Same parameters and result shape as search, restricted to news sources.',
      inputSchema: SearchRequestSchema.shape,
    },
    async (args, extra) => {
      try {
        return textResult(await gateway.news(args, { signal: extra.signal }));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'crawl',
    {
      title: 'Fetch page content',
      description: 'Fetch a URL and return its main text content (markdown or plain text) plus title.',
      inputSchema: CrawlRequestSchema.shape,
    },
    async (args, extra) => {
      try {
        return textResult(await gateway.crawl(args, { signal: extra.signal }));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  return server;
}
