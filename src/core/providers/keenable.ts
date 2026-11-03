/**
 * Keenable: /v1/search 搜索(带页面摘录), /v1/fetch 抓取正文(markdown)。免 key 可用, 有 key 提高限额。
 * https://docs.keenable.ai/api-reference/search
 */
import { ProviderError } from '../errors.ts';
import { fetchJson, jsonHeaders, qs, str, toIsoDate } from '../http.ts';
import type { CrawlResult, ProviderContext, ProviderSearchParams, SearchProvider, SearchResult } from '../types.ts';

export interface KeenableOptions {
  /** 可选; 不填时走免 key 的 /public 端点(按 IP 限流) */
  apiKey?: string;
  baseUrl?: string;
}

interface KeenableItem {
  title?: string;
  url?: string;
  snippet?: string;
  published_at?: string;
}

/** /v1/search 的 max_results 上限 */
const MAX_RESULTS = 50;
/** 免 key 端点要求标明调用方 */
const APP_TITLE = 'search2ai';
/** recency → Keenable 相对时间; hour 按天处理 */
const RECENCY = { hour: '1d', day: '1d', week: '7d', month: '1mo', year: '1y' } as const;

export function createKeenable(opts: KeenableOptions = {}): SearchProvider {
  const name = 'keenable';
  const base = (opts.baseUrl ?? 'https://api.keenable.ai').replace(/\/+$/, '');
  const suffix = opts.apiKey ? '' : '/public';
  const auth: Record<string, string> = opts.apiKey ? { 'X-API-Key': opts.apiKey } : { 'X-Keenable-Title': APP_TITLE };

  return {
    name,
    async search(p: ProviderSearchParams, ctx: ProviderContext): Promise<SearchResult[]> {
      // 原生 site 参数只接受一个域名; 多域名交给其他 provider, 不悄悄放宽过滤
      if (p.domains && p.domains.length > 1) {
        throw new ProviderError(name, 'unsupported', 'keenable: only a single domain filter is supported');
      }
      const body: Record<string, unknown> = { query: p.query, max_results: Math.min(p.maxResults, MAX_RESULTS) };
      if (p.domains?.length) body.site = p.domains[0];
      if (p.afterDate) body.published_after = p.afterDate;
      else if (p.recency) body.published_after = RECENCY[p.recency];
      if (p.beforeDate) body.published_before = p.beforeDate;
      const data = await fetchJson<{ results?: KeenableItem[] }>(ctx, name, `${base}/v1/search${suffix}`, {
        method: 'POST',
        headers: jsonHeaders(auth),
        body: JSON.stringify(body),
      });
      return (data.results ?? [])
        .filter((i) => i.url)
        .slice(0, p.maxResults)
        .map((i) => {
          const r: SearchResult = { title: str(i.title), url: str(i.url), snippet: str(i.snippet) };
          const date = toIsoDate(i.published_at);
          if (date) r.date = date;
          return r;
        });
    },
    async crawl(url, ctx): Promise<CrawlResult> {
      const data = await fetchJson<{ url?: string; title?: string; content?: string }>(
        ctx,
        name,
        `${base}/v1/fetch${suffix}${qs({ url })}`,
        { method: 'GET', headers: { Accept: 'application/json', ...auth } }
      );
      return { url: str(data.url) || url, title: data.title ? str(data.title) : undefined, content: str(data.content) };
    },
  };
}
