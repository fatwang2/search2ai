/**
 * cloro: Google 搜索 /v1/monitor/google, Google 新闻 /v1/monitor/google/news。https://cloro.dev/docs
 */
import { fetchJson, jsonHeaders, str, toIsoDate, withSiteFilter } from '../http.ts';
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

  return {
    name,
    async search(p: ProviderSearchParams, ctx: ProviderContext) {
      const data = await fetchJson<{ result?: { organicResults?: CloroItem[] } }>(ctx, name, `${base}/v1/monitor/google`, { method: 'POST', headers, body: body(p) });
      return map(data.result?.organicResults, p.maxResults);
    },
    async news(p: ProviderSearchParams, ctx: ProviderContext) {
      const data = await fetchJson<{ result?: { newsResults?: CloroItem[] } }>(ctx, name, `${base}/v1/monitor/google/news`, { method: 'POST', headers, body: body(p) });
      return map(data.result?.newsResults, p.maxResults);
    },
  };
}
