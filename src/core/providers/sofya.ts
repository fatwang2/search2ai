/**
 * Sofya: 面向 AI agent 的搜索 API(POST /v1/search)搜索与新闻, 可在搜索时原生带回正文; POST /v1/fetch 抓取正文(markdown)。
 * https://sofya.co/docs
 */
import { ProviderError } from '../errors.ts';
import { fetchJson, jsonHeaders, str, toIsoDate } from '../http.ts';
import type { CrawlResult, ProviderContext, ProviderSearchParams, SearchProvider, SearchResult } from '../types.ts';

export interface SofyaOptions {
  apiKey: string;
  baseUrl?: string;
}

interface SofyaItem {
  title?: string;
  url?: string;
  /** basic 深度且 fetched 为 true 时是页面正文, 否则与 description 相同 */
  content?: string;
  description?: string | null;
  fetched?: boolean;
  published_date?: string | null;
}

interface SofyaPage {
  title?: string;
  url?: string;
  content?: string;
  success?: boolean;
  error?: string | null;
}

/** max_results 与 include_domains 的上限 */
const MAX_RESULTS = 20;
const MAX_DOMAINS = 10;
/** 只给出上限时的起始日期 */
const EPOCH = '1970-01-01';

/** freshness 接受 day / week / month / year 或 YYYY-MM-DD:YYYY-MM-DD; hour 按天处理, 显式日期范围优先 */
function freshness(p: ProviderSearchParams): string | undefined {
  if (p.afterDate || p.beforeDate) {
    return `${p.afterDate ?? EPOCH}:${p.beforeDate ?? new Date().toISOString().slice(0, 10)}`;
  }
  if (!p.recency) return undefined;
  return { hour: 'day', day: 'day', week: 'week', month: 'month', year: 'year' }[p.recency];
}

export function createSofya(opts: SofyaOptions): SearchProvider {
  const name = 'sofya';
  const base = (opts.baseUrl ?? 'https://sofya.co').replace(/\/+$/, '');
  const headers = jsonHeaders({ Authorization: `Bearer ${opts.apiKey}` });

  async function run(topic: 'general' | 'news', p: ProviderSearchParams, ctx: ProviderContext): Promise<SearchResult[]> {
    // 超出上限的域名过滤交给其他 provider, 不悄悄截断
    if (p.domains && p.domains.length > MAX_DOMAINS) {
      throw new ProviderError(name, 'unsupported', `sofya: at most ${MAX_DOMAINS} domain filters are supported`);
    }
    // 需要正文时用 basic(搜索时一并读取页面), 否则用 snippets(只返回摘要, 最快)
    const wanted = p.crawlResults ?? 0;
    const body: Record<string, unknown> = {
      query: p.query,
      topic,
      max_results: Math.min(p.maxResults, MAX_RESULTS),
      search_depth: wanted > 0 ? 'basic' : 'snippets',
    };
    if (p.domains?.length) body.include_domains = p.domains;
    const fresh = freshness(p);
    if (fresh) body.freshness = fresh;
    const data = await fetchJson<{ results?: SofyaItem[] }>(ctx, name, `${base}/v1/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return (data.results ?? [])
      .filter((i) => i.url)
      .slice(0, p.maxResults)
      .map((i, index) => {
        const r: SearchResult = { title: str(i.title), url: str(i.url), snippet: str(i.description) || (i.fetched ? '' : str(i.content)) };
        const date = toIsoDate(i.published_date);
        if (date) r.date = date;
        // 页面没在时限内读到时 fetched 为 false, content 只是摘要, 留给 crawl 链去补
        if (index < wanted && i.fetched && i.content) r.content = str(i.content);
        return r;
      });
  }

  return {
    name,
    search: (p, ctx) => run('general', p, ctx),
    news: (p, ctx) => run('news', p, ctx),
    async crawl(url, ctx): Promise<CrawlResult> {
      const data = await fetchJson<{ results?: SofyaPage[] }>(ctx, name, `${base}/v1/fetch`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ urls: [url] }),
      });
      const page = data.results?.[0];
      // 单个 URL 读取失败时仍是 HTTP 200, success 为 false(不计费)
      if (!page || page.success === false) {
        throw new ProviderError(name, 'upstream', `sofya: ${str(page?.error) || 'page could not be fetched'}`);
      }
      if (!page.content) throw new ProviderError(name, 'empty', 'sofya: page has no readable text');
      return { url: str(page.url) || url, title: page.title ? str(page.title) : undefined, content: str(page.content) };
    },
  };
}
