/**
 * Autom: Google 搜索 /v1/google/search, Google 新闻 /v1/google/news。https://docs.autom.dev
 */
import { fetchJson, googleTbs, jsonHeaders, qs, str, toIsoDate, withSiteFilter } from '../http.ts';
import type { ProviderContext, ProviderSearchParams, SearchProvider, SearchResult } from '../types.ts';

export interface AutomOptions {
  apiKey: string;
  gl?: string;
  hl?: string;
  baseUrl?: string;
}

interface AutomItem {
  title?: string;
  link?: string;
  snippet?: string;
  date?: string;
}

interface AutomPage {
  organic_results?: AutomItem[];
  pagination?: { has_next_page?: boolean };
}

/** 每页 10 条, 每页 1 credit, 最多取 2 页 */
const PAGE_SIZE = 10;
const MAX_PAGES = 2;

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

function map(items: AutomItem[], limit: number): SearchResult[] {
  const out: SearchResult[] = [];
  for (const i of items) {
    const url = str(i.link);
    if (!/^https?:\/\//i.test(url)) continue;
    const r: SearchResult = { title: str(i.title), url, snippet: str(i.snippet) };
    const date = toIsoDate(i.date);
    if (date) r.date = date;
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

export function createAutom(opts: AutomOptions): SearchProvider {
  const name = 'autom';
  const base = (opts.baseUrl ?? 'https://api.autom.dev').replace(/\/+$/, '');
  const headers = jsonHeaders({ 'x-api-key': opts.apiKey });

  /** 取够 maxResults 为止, 最多 2 页; 下一页不存在时停止 */
  async function pages(p: ProviderSearchParams, ctx: ProviderContext, path: string, tbs?: string): Promise<SearchResult[]> {
    const want = Math.min(Math.ceil(p.maxResults / PAGE_SIZE) || 1, MAX_PAGES);
    const items: AutomItem[] = [];
    for (let page = 1; page <= want; page++) {
      const query = qs({
        query: withSiteFilter(p.query, p.domains),
        gl: (p.country ?? opts.gl)?.toLowerCase(),
        hl: p.languages?.[0] ?? opts.hl,
        tbs,
        page: page > 1 ? page : undefined,
      });
      const data = await fetchJson<AutomPage>(ctx, name, `${base}${path}${query}`, { method: 'GET', headers });
      items.push(...(data.organic_results ?? []));
      if (!data.pagination?.has_next_page) break;
    }
    return map(items, p.maxResults);
  }

  return {
    name,
    search(p: ProviderSearchParams, ctx: ProviderContext) {
      return pages(p, ctx, '/v1/google/search', timeTbs(p));
    },
    // Google 新闻接口没有 tbs 参数, 时间过滤不映射
    news(p: ProviderSearchParams, ctx: ProviderContext) {
      return pages(p, ctx, '/v1/google/news');
    },
  };
}
