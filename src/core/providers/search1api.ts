/**
 * Search1API: 本项目配套的托管搜索服务, search / news / crawl 全部支持, 且可在搜索时原生抓取正文。
 * https://www.search1api.com
 */
import { fetchJson, jsonHeaders, str, toIsoDate } from '../http.ts';
import type { CrawlResult, ProviderContext, ProviderSearchParams, SearchProvider, SearchResult } from '../types.ts';

export interface Search1apiOptions {
  apiKey: string;
  /** 底层引擎: google(默认) / bing / duckduckgo / yahoo / x / reddit / github / youtube / arxiv / wechat / bilibili / imdb / wikipedia */
  searchService?: string;
  baseUrl?: string;
}

interface S1Item {
  title?: string;
  link?: string;
  snippet?: string;
  content?: string;
  date?: string;
  published_date?: string;
}

function mapResults(items: S1Item[] | undefined): SearchResult[] {
  return (items ?? []).map((i) => {
    const r: SearchResult = { title: str(i.title), url: str(i.link), snippet: str(i.snippet) };
    const date = toIsoDate(i.published_date ?? i.date);
    if (date) r.date = date;
    if (i.content) r.content = str(i.content);
    return r;
  });
}

function timeRange(recency?: ProviderSearchParams['recency']): string | undefined {
  if (!recency) return undefined;
  return { hour: 'day', day: 'day', week: 'month', month: 'month', year: 'year' }[recency];
}

export function createSearch1api(opts: Search1apiOptions): SearchProvider {
  const name = 'search1api';
  const base = (opts.baseUrl ?? 'https://api.search1api.com').replace(/\/+$/, '');
  const headers = jsonHeaders({ Authorization: `Bearer ${opts.apiKey}` });

  async function query(path: string, p: ProviderSearchParams, ctx: ProviderContext): Promise<SearchResult[]> {
    const body: Record<string, unknown> = {
      query: p.query,
      search_service: opts.searchService ?? 'google',
      max_results: p.maxResults,
      crawl_results: p.crawlResults ?? 0,
      image: false,
      include_sites: p.domains ?? [],
      exclude_sites: [],
    };
    if (p.languages?.[0]) body.language = p.languages[0];
    const tr = timeRange(p.recency);
    if (tr) body.time_range = tr;
    const data = await fetchJson<{ results?: S1Item[] }>(ctx, name, `${base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return mapResults(data.results).slice(0, p.maxResults);
  }

  return {
    name,
    search: (p, ctx) => query('/search', p, ctx),
    news: (p, ctx) => query('/news', p, ctx),
    async crawl(url, ctx): Promise<CrawlResult> {
      const data = await fetchJson<{ results?: { title?: string; link?: string; content?: string } }>(ctx, name, `${base}/crawl`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ url }),
      });
      const r = data.results ?? {};
      return { url: str(r.link) || url, title: r.title ? str(r.title) : undefined, content: str(r.content) };
    },
  };
}
