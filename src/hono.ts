/**
 * search2ai/hono: 可 mount 的 Hono app 与从环境变量一键组装的入口。
 *
 * ```ts
 * import { createAppFromEnv } from 'search2ai/hono';
 * export default createAppFromEnv(process.env);   // Node / Workers / Vercel / Bun 通用
 * ```
 */
import type { Hono } from 'hono';
import { chatProxyConfigFromEnv } from './chat/upstream.ts';
import { configFromEnv, type Env, type GatewayConfig } from './core/config.ts';
import { createGateway, type Gateway } from './core/gateway.ts';
import type { Cache } from './core/types.ts';
import { createApp, type AppOptions } from './server/app.ts';

export { createApp, type AppOptions } from './server/app.ts';
export { createChatProxy, gatewayToolDefinitions, type ChatProxy, type ChatResult } from './chat/proxy.ts';
export { chatProxyConfigFromEnv, resolveApiKey, UpstreamError, type ChatProxyConfig } from './chat/upstream.ts';
export { createMcpServer } from './mcp/server.ts';
export { buildOpenApi } from './server/openapi.ts';

export interface FromEnvOptions {
  /** 覆盖 / 补充从环境变量解析出的网关配置 */
  gateway?: Partial<GatewayConfig>;
  /** 结果缓存实现(如 Workers KV), 配合 CACHE_TTL 生效 */
  cache?: Cache;
  /** 覆盖 app 选项 */
  app?: Partial<Omit<AppOptions, 'gateway'>>;
}

export function parseAuthKeys(env: Env): string[] {
  return (env.AUTH_KEYS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function createGatewayFromEnv(env: Env, overrides: Partial<GatewayConfig> & { cache?: Cache } = {}): Gateway {
  const base = configFromEnv(env);
  return createGateway({
    ...base,
    ...overrides,
    providers: { ...base.providers, ...(overrides.providers ?? {}) },
  });
}

/** 从环境变量组装完整的 Hono app(网关 + MCP + 按需的聊天代理) */
export function createAppFromEnv(env: Env, options: FromEnvOptions = {}): Hono {
  const gateway = createGatewayFromEnv(env, { ...(options.gateway ?? {}), cache: options.cache ?? options.gateway?.cache });
  return createApp({
    gateway,
    authKeys: parseAuthKeys(env),
    chatProxy: chatProxyConfigFromEnv(env),
    ...(options.app ?? {}),
  });
}
