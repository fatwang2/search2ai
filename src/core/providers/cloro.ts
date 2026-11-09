/**
 * cloro: Google 搜索 /v1/monitor/google, Google 新闻 /v1/monitor/google/news。https://cloro.dev/docs
 */
import { fetchJson, googleTbs, jsonHeaders, str, toIsoDate, withSiteFilter } from '../http.ts';
import type { ProviderContext, ProviderSearchParams, SearchProvider, SearchResult } from '../types.ts';

export interface CloroOptions {
  apiKey: string;
  gl?: string;
  hl?: string;
  baseUrl?: string;
}

interface CloroItem {
  title?: string;
  link?: string;
  snippet?: string;
  date?: string;
}

/** 每页 10 条; 第 2 页起每页多 2 credits, 所以最多取 2 页 */
const PAGE_SIZE = 10;
const MAX_PAGES = 2;

/** link 可能为空, 或是 google.com/goto 跳转地址(真实地址在别处), 这样的行没有可用 URL, 丢弃 */
function usableUrl(link: unknown): string | undefined {
  const s = str(link);
  if (!/^https?:\/\//i.test(s)) return undefined;
  try {
    const u = new URL(s);
    if (/(^|\.)google\.[a-z.]+$/i.test(u.hostname) && u.pathname.startsWith('/goto')) return undefined;
  } catch {
    return undefined;
  }
  return s;
}

/** YYYY-MM-DD -> Google cd_min/cd_max 的 M/D/YYYY */
function googleDate(d: string): string {
  const [y, m, day] = d.split('-');
  return `${Number(m)}/${Number(day)}/${y}`;
}

/** 时间过滤对应的 Google tbs: 日期范围用 cdr, 否则用 recency 的 qdr */
function timeTbs(p: ProviderSearchParams): string | undefined {
  if (p.afterDate || p.beforeDate) {
    const parts = ['cdr:1'];
    if (p.afterDate) parts.push(`cd_min:${googleDate(p.afterDate)}`);
    if (p.beforeDate) parts.push(`cd_max:${googleDate(p.beforeDate)}`);
    return parts.join(',');
  }
  return googleTbs(p.recency);
}

function map(items: CloroItem[] | undefined, limit: number): SearchResult[] {
  const out: SearchResult[] = [];
  for (const i of items ?? []) {
    const url = usableUrl(i.link);
    if (!url) continue;
    const r: SearchResult = { title: str(i.title), url, snippet: str(i.snippet) };
    const date = toIsoDate(i.date);
    if (date) r.date = date;
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

export function createCloro(opts: CloroOptions): SearchProvider {
  const name = 'cloro';
  const base = (opts.baseUrl ?? 'https://api.cloro.dev').replace(/\/+$/, '');
  const headers = jsonHeaders({ Authorization: `Bearer ${opts.apiKey}` });

  function body(p: ProviderSearchParams): string {
    const b: Record<string, unknown> = {
      query: withSiteFilter(p.query, p.domains),
      // cloro 没有默认国家, 必须传
      country: (p.country ?? opts.gl ?? 'US').toUpperCase(),
      pages: Math.min(Math.ceil(p.maxResults / PAGE_SIZE) || 1, MAX_PAGES),
    };
    const hl = p.languages?.[0] ?? opts.hl;
    if (hl) b.hl = hl;
    return JSON.stringify(b);
  }

  /**
   * 有时间过滤时发完整的 Google 搜索 URL, cloro 原样应用其中的 tbs, 计费与标准请求相同。
   * URL 自带 q/gl/hl, 且不能再传 pages, 所以只取 1 页(最多 10 条)。
   */
  function urlBody(p: ProviderSearchParams, tbs: string): string {
    const u = new URL('https://www.google.com/search');
    u.searchParams.set('q', withSiteFilter(p.query, p.domains));
    u.searchParams.set('gl', (p.country ?? opts.gl ?? 'US').toLowerCase());
    const hl = p.languages?.[0] ?? opts.hl;
    if (hl) u.searchParams.set('hl', hl);
    u.searchParams.set('tbs', tbs);
    return JSON.stringify({ url: u.toString() });
  }

  return {
    name,
    async search(p: ProviderSearchParams, ctx: ProviderContext) {
      const tbs = timeTbs(p);
      const data = await fetchJson<{ result?: { organicResults?: CloroItem[] } }>(ctx, name, `${base}/v1/monitor/google`, {
        method: 'POST',
        headers,
        body: tbs ? urlBody(p, tbs) : body(p),
      });
      return map(data.result?.organicResults, p.maxResults);
    },
    async news(p: ProviderSearchParams, ctx: ProviderContext) {
      const data = await fetchJson<{ result?: { newsResults?: CloroItem[] } }>(ctx, name, `${base}/v1/monitor/google/news`, { method: 'POST', headers, body: body(p) });
      return map(data.result?.newsResults, p.maxResults);
    },
  };
}
