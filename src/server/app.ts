/**
 * Hono app: 搜索网关的 HTTP 表面。可独立运行, 也可 `app.route('/search', createApp(...))` 挂进你自己的 Hono 应用。
 *
 * 路由:
 *   GET  /               服务信息
 *   GET  /v1/health      健康检查与已配置 provider
 *   GET  /openapi.json   OpenAPI 3.1
 *   POST /v1/search      统一网页搜索
 *   POST /v1/news        新闻
 *   POST /v1/crawl       抓取正文
 *   ALL  /mcp            MCP(Streamable HTTP)
 *   POST /v1/chat/completions  兼容旧版的聊天代理(仅在 chatProxy 配置存在时挂载)
 */
import { zValidator } from '@hono/zod-validator';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { createChatProxy } from '../chat/proxy.ts';
import { UpstreamError, proxyPassthrough, resolveApiKey, type ChatProxyConfig } from '../chat/upstream.ts';
import { GatewayError } from '../core/errors.ts';
import type { Gateway } from '../core/gateway.ts';
import { CrawlRequestSchema, SearchRequestSchema } from '../core/schema.ts';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcpServer } from '../mcp/server.ts';
import { version as pkgVersion } from '../version.ts';
import { buildOpenApi } from './openapi.ts';
import { createCompatibilityApp } from './compat.ts';

export interface AppOptions {
  gateway: Gateway;
  version?: string;
  /** 网关访问 key: /v1/*、/mcp 使用 Bearer; /compat 按客户端协议认证。为空则不鉴权。 */
  authKeys?: string[];
  /** 传入即挂载兼容旧版的聊天代理 */
  chatProxy?: ChatProxyConfig;
  /** 是否挂载 /mcp, 默认 true */
  mcp?: boolean;
  /** 自定义 fetch(聊天代理与透传使用) */
  fetch?: typeof fetch;
}

function bearerOf(c: Context): string {
  const h = c.req.header('Authorization') ?? '';
  return h.replace(/^Bearer\s+/i, '').trim();
}

function errorJson(c: Context, status: number, message: string, type: string, extra: Record<string, unknown> = {}) {
  return c.json({ error: { message, type, code: status, ...extra } }, status as 400);
}

function bearerAuth(keys: string[]): MiddlewareHandler {
  const allowed = new Set(keys.map((k) => k.toLowerCase()));
  return async (c, next) => {
    if (allowed.size === 0) return next();
    const key = bearerOf(c);
    if (!key) return errorJson(c, 401, 'Authorization header is missing', 'unauthorized');
    if (!allowed.has(key.toLowerCase())) return errorJson(c, 401, 'Invalid API key', 'unauthorized');
    return next();
  };
}

interface ValidationResult {
  success: boolean;
  error?: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> };
}

const validationHook = (result: ValidationResult, c: Context) => {
  if (!result.success) {
    const issues = result.error?.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })) ?? [];
    return errorJson(c, 400, `Invalid request: ${issues.map((i) => `${i.path || 'body'} ${i.message}`).join('; ')}`, 'invalid_request', { issues });
  }
  return undefined;
};

export function createApp(opts: AppOptions): Hono {
  const { gateway } = opts;
  const version = opts.version ?? pkgVersion;
  const authKeys = opts.authKeys ?? [];
  const fetchFn: typeof fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const app = new Hono();

  app.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Authorization', 'X-Api-Key', 'Exa-Beta', 'Content-Type', 'Accept', 'Mcp-Session-Id', 'Mcp-Protocol-Version', 'Last-Event-ID'],
      exposeHeaders: ['Mcp-Session-Id', 'X-Search2AI-Provider', 'X-Search2AI-Mode', 'X-Search2AI-Skipped', 'Retry-After'],
      maxAge: 86400,
    })
  );

  app.onError((err, c) => {
    if (err instanceof GatewayError) return errorJson(c, err.status, err.message, err.code, err.warnings.length ? { warnings: err.warnings } : {});
    if (err instanceof UpstreamError) return errorJson(c, err.status, err.message, 'upstream_error');
    if (err instanceof HTTPException) return err.getResponse();
    console.error('search2ai error:', err);
    return errorJson(c, 500, 'Internal Server Error', 'internal_error');
  });
  app.notFound((c) => errorJson(c, 404, `No route for ${c.req.method} ${c.req.path}`, 'not_found'));

  const info = () => ({
    name: 'search2ai',
    version,
    description: 'Self-hosted search gateway for AI agents',
    providers: gateway.providers(),
    chains: { search: gateway.chain('search'), news: gateway.chain('news'), crawl: gateway.chain('crawl') },
    endpoints: ['/v1/search', '/v1/news', '/v1/crawl', '/v1/health', '/openapi.json', '/compat/searxng', '/compat/exa', '/compat/tavily', '/compat/search1api', '/compat/firecrawl', ...(opts.mcp === false ? [] : ['/mcp']), ...(opts.chatProxy ? ['/v1/chat/completions'] : [])],
    auth: authKeys.length > 0 ? 'bearer' : 'none',
  });

  // 公开路由(注册在鉴权中间件之前)
  app.get('/', (c) => c.json(info()));
  app.get('/v1/health', (c) => c.json({ status: 'ok', ...info() }));
  app.get('/openapi.json', (c) =>
    c.json(buildOpenApi({ version, chatProxy: !!opts.chatProxy, secured: authKeys.length > 0, serverUrl: new URL(c.req.url).origin }))
  );

  // 鉴权
  const auth = bearerAuth(authKeys);
  app.use('/v1/*', auth);
  app.use('/mcp', auth);
  app.use('/chat/*', auth);

  app.route('/compat', createCompatibilityApp(gateway, authKeys));

  // 搜索网关
  app.post('/v1/search', zValidator('json', SearchRequestSchema, validationHook), async (c) => c.json(await gateway.search(c.req.valid('json'))));
  app.post('/v1/news', zValidator('json', SearchRequestSchema, validationHook), async (c) => c.json(await gateway.news(c.req.valid('json'))));
  app.post('/v1/crawl', zValidator('json', CrawlRequestSchema, validationHook), async (c) => c.json(await gateway.crawl(c.req.valid('json'))));

  // MCP
  if (opts.mcp !== false) {
    // 无状态模式: SDK 要求每个请求使用新的 transport, 这里连 server 也一起新建(注册 3 个工具, 开销可忽略)。
    // 适合 Workers 等无长驻进程的环境; 响应用 JSON 而非 SSE, curl 也能直接读。
    app.all('/mcp', async (c) => {
      const mcpServer = createMcpServer(gateway, version);
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await mcpServer.connect(transport);
      try {
        return await transport.handleRequest(c.req.raw);
      } finally {
        void mcpServer.close().catch(() => undefined);
      }
    });
  }

  // 兼容旧版的聊天代理
  if (opts.chatProxy) {
    const cfg: ChatProxyConfig = { ...opts.chatProxy, fetch: opts.chatProxy.fetch ?? fetchFn };
    const proxy = createChatProxy(gateway, cfg);
    const resolve = (c: Context): { apiKey: string } | Response => {
      const requestKey = bearerOf(c);
      if (!requestKey) return errorJson(c, 400, 'Authorization header is missing', 'invalid_request');
      const { apiKey, authError } = resolveApiKey(cfg, requestKey);
      if (authError) return errorJson(c, 401, authError, 'unauthorized');
      return { apiKey };
    };
    const chat = async (c: Context) => {
      const r = resolve(c);
      if (r instanceof Response) return r;
      let data: Record<string, unknown>;
      try {
        data = (await c.req.json()) as Record<string, unknown>;
      } catch {
        return errorJson(c, 400, 'Invalid JSON', 'invalid_request');
      }
      const result = await proxy.handleChat(r.apiKey, data);
      return c.body(result.body, result.status as 200, result.headers);
    };
    app.post('/v1/chat/completions', chat);
    app.post('/chat/completions', chat);
    // 其余 OpenAI 端点(models / embeddings / audio 等)透传到上游; 放在所有 /v1 路由之后
    app.all('/v1/*', async (c) => {
      const r = resolve(c);
      if (r instanceof Response) return r;
      return proxyPassthrough(cfg, fetchFn, r.apiKey, c.req.raw, c.req.path);
    });
  }

  return app;
}
