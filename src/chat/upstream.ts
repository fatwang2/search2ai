/**
 * 聊天代理的上游封装: OpenAI 兼容 / Azure OpenAI 的鉴权头、URL 与错误透传。
 */
import type { Env } from '../core/config.ts';

export interface ChatProxyConfig {
  /** 与 OpenAI SDK baseURL 语义一致的完整前缀, 如 https://api.openai.com/v1 */
  apiBase: string;
  type: 'openai' | 'azure';
  azure?: { resource: string; deploy: string; apiVersion: string; apiKey: string };
  /** 允许的请求 key 列表; 配置后请求 key 必须在列表中, 上游改用 upstreamKey */
  authKeys: string[];
  upstreamKey?: string;
  fetch?: typeof fetch;
  /** 工具回路最大轮数, 默认 8 */
  maxRounds?: number;
}

export class UpstreamError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

function pick(env: Env, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = env[n];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * 只有显式配置了上游(APIBASE / CHAT_PROXY=true / OPENAI_TYPE=azure)才启用聊天代理, 否则返回 undefined。
 * 0.2.x 用户的环境变量原样生效。
 */
export function chatProxyConfigFromEnv(env: Env): ChatProxyConfig | undefined {
  const apiBase = pick(env, 'APIBASE');
  const type = (pick(env, 'OPENAI_TYPE') ?? 'openai').toLowerCase() === 'azure' ? 'azure' : 'openai';
  const enabled = !!apiBase || type === 'azure' || ['1', 'true', 'yes', 'on'].includes((pick(env, 'CHAT_PROXY') ?? '').toLowerCase());
  if (!enabled) return undefined;
  const authKeys = (pick(env, 'AUTH_KEYS') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const cfg: ChatProxyConfig = {
    apiBase: (apiBase ?? 'https://api.openai.com/v1').replace(/\/+$/, ''),
    type,
    authKeys,
    upstreamKey: type === 'azure' ? pick(env, 'AZURE_API_KEY') : pick(env, 'OPENAI_API_KEY'),
  };
  if (type === 'azure') {
    cfg.azure = {
      resource: pick(env, 'RESOURCE_NAME') ?? '',
      deploy: pick(env, 'DEPLOY_NAME') ?? '',
      apiVersion: pick(env, 'API_VERSION') ?? '2024-10-21',
      apiKey: pick(env, 'AZURE_API_KEY') ?? '',
    };
  }
  return cfg;
}

export function joinUrl(base: string, pathname: string): string {
  return `${base.replace(/\/+$/, '')}/${pathname.replace(/^\/+/, '')}`;
}

/** apiBase 末尾已带版本段(如 /v1)时, 入站路径里重复的版本段要去掉, 否则会拼成 /v1/v1/models */
export function upstreamPath(apiBase: string, pathname: string): string {
  const m = apiBase.replace(/\/+$/, '').match(/\/(v\d+[a-z0-9]*)$/i);
  if (m && pathname.toLowerCase().startsWith(`/${m[1].toLowerCase()}/`)) return pathname.slice(m[1].length + 1);
  return pathname;
}

/**
 * 解析请求鉴权: 配置了 authKeys 时校验请求 key ∈ 列表(不区分大小写), 通过后上游改用 upstreamKey;
 * 未配置时直接透传请求 key。
 */
export function resolveApiKey(cfg: ChatProxyConfig, requestKey: string): { apiKey: string; authError?: string } {
  if (cfg.authKeys.length > 0) {
    const ok = cfg.authKeys.some((k) => k.toLowerCase() === requestKey.toLowerCase());
    if (!ok) return { apiKey: '', authError: 'Invalid API key' };
    return { apiKey: cfg.upstreamKey || requestKey };
  }
  return { apiKey: requestKey };
}

export function chatRequestOptions(cfg: ChatProxyConfig, apiKey: string, stream: boolean): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
  };
  if (cfg.type === 'azure' && cfg.azure) {
    const { resource, deploy, apiVersion, apiKey: azureKey } = cfg.azure;
    headers['api-key'] = azureKey || apiKey;
    return {
      url: `https://${resource}.openai.azure.com/openai/deployments/${deploy}/chat/completions?api-version=${apiVersion}`,
      headers,
    };
  }
  headers.Authorization = `Bearer ${apiKey}`;
  return { url: joinUrl(cfg.apiBase, '/chat/completions'), headers };
}

/** 调用上游 chat/completions; stream=true 返回 Response, 否则返回解析后的 JSON */
export async function callChatCompletions(
  cfg: ChatProxyConfig,
  fetchFn: typeof fetch,
  apiKey: string,
  body: unknown,
  stream: boolean,
  signal?: AbortSignal
): Promise<Response | Record<string, unknown>> {
  const { url, headers } = chatRequestOptions(cfg, apiKey, stream);
  const upstream = await fetchFn(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!upstream.ok) {
    let detail = upstream.statusText || '';
    try {
      const e = (await upstream.json()) as { error?: { message?: string } };
      detail = e.error?.message || JSON.stringify(e);
    } catch {
      /* 非 JSON 错误体 */
    }
    throw new UpstreamError(upstream.status, detail);
  }
  return stream ? upstream : ((await upstream.json()) as Record<string, unknown>);
}

/** 非 chat 端点(models / embeddings / audio 等)直接转发到上游 */
export async function proxyPassthrough(cfg: ChatProxyConfig, fetchFn: typeof fetch, apiKey: string, request: Request, pathname: string): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('content-length');
  if (cfg.type === 'azure' && cfg.azure) headers.set('api-key', cfg.azure.apiKey || apiKey);
  else headers.set('Authorization', `Bearer ${apiKey}`);
  const url = new URL(request.url);
  const target = joinUrl(cfg.apiBase, upstreamPath(cfg.apiBase, pathname)) + url.search;
  const hasBody = !['GET', 'HEAD'].includes(request.method);
  const init: RequestInit & { duplex?: 'half' } = { method: request.method, headers };
  if (hasBody) {
    init.body = request.body;
    init.duplex = 'half';
  }
  const upstream = await fetchFn(target, init);
  const outHeaders = new Headers(upstream.headers);
  outHeaders.delete('content-encoding');
  outHeaders.delete('content-length');
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}
