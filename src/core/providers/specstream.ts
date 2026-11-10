/**
 * SpecStream: Search API(GET /v1/web-search, speed=fast)搜索与新闻, Extract API(POST /v1/extract)抓取正文(markdown)。
 * https://api.specstream.ai/openapi.json
 */
import { ProviderError } from '../errors.ts';
import { fetchJson, jsonHeaders, qs, str, toIsoDate } from '../http.ts';
import type { CrawlResult, ProviderContext, ProviderErrorCode, ProviderSearchParams, SearchProvider, SearchResult } from '../types.ts';

export interface SpecstreamOptions {
  apiKey: string;
  gl?: string;
  hl?: string;
  baseUrl?: string;
}

interface SpecstreamSource {
  url?: string;
  title?: string;
  snippet?: string;
  published?: string | null;
  modified?: string | null;
}

interface SpecstreamPage {
  url?: string | null;
  status?: string;
  title?: string | null;
  text?: string;
  final_url?: string | null;
}

/** num 的上限 */
const MAX_NUM = 100;
/** recency → 往前推的天数, 用 after: 操作符表达; hour 按天处理 */
const RECENCY_DAYS = { hour: 1, day: 1, week: 7, month: 30, year: 365 } as const;
/** /v1/extract 非 ok 状态 → provider 错误码 */
const PAGE_ERRORS: Record<string, ProviderErrorCode> = {
  empty: 'empty',
  not_found: 'bad_request',
  invalid_url: 'bad_request',
  unsupported: 'unsupported',
};

/** language / country 只接受两位字母代码; zh-CN 这类取前半段 */
function twoLetter(v: string | undefined): string | undefined {
  const s = v?.split(/[-_]/)[0];
  return s && /^[a-z]{2}$/i.test(s) ? s : undefined;
}

/** 域名与时间过滤都写成查询里的操作符(site: / after: / before:) */
function buildQuery(p: ProviderSearchParams): string {
  const parts = [p.query];
  if (p.domains?.length) parts.push(`site:${p.domains[0]}`);
  const after = p.afterDate ?? (p.recency ? new Date(Date.now() - RECENCY_DAYS[p.recency] * 86_400_000).toISOString().slice(0, 10) : undefined);
  if (after) parts.push(`after:${after}`);
  if (p.beforeDate) parts.push(`before:${p.beforeDate}`);
  return parts.join(' ');
}

export function createSpecstream(opts: SpecstreamOptions): SearchProvider {
  const name = 'specstream';
  const base = (opts.baseUrl ?? 'https://api.specstream.ai').replace(/\/+$/, '');
  const auth = { Authorization: `Bearer ${opts.apiKey}` };

  async function run(news: boolean, p: ProviderSearchParams, ctx: ProviderContext): Promise<SearchResult[]> {
    // site: 操作符对每条结果都生效, 多个 site: 不是"或"; 多域名交给其他 provider, 不悄悄放宽过滤
    if (p.domains && p.domains.length > 1) {
      throw new ProviderError(name, 'unsupported', 'specstream: only a single domain filter is supported');
    }
    const url = `${base}/v1/web-search${qs({
      q: buildQuery(p),
      num: Math.min(p.maxResults, MAX_NUM),
      speed: 'fast',
      news: news || undefined,
      country: twoLetter(p.country ?? opts.gl)?.toUpperCase(),
      language: twoLetter(p.languages?.[0] ?? opts.hl)?.toLowerCase(),
    })}`;
    const data = await fetchJson<{ data?: { sources?: SpecstreamSource[] } }>(ctx, name, url, {
      headers: { Accept: 'application/json', ...auth },
    });
    return (data.data?.sources ?? [])
      .filter((s) => s.url)
      .slice(0, p.maxResults)
      .map((s) => {
        const r: SearchResult = { title: str(s.title), url: str(s.url), snippet: str(s.snippet) };
        const date = toIsoDate(s.published);
        if (date) r.date = date;
        const modified = toIsoDate(s.modified);
        if (modified) r.last_updated = modified;
        return r;
      });
  }

  return {
    name,
    search: (p, ctx) => run(false, p, ctx),
    news: (p, ctx) => run(true, p, ctx),
    async crawl(url, ctx): Promise<CrawlResult> {
      const data = await fetchJson<{ data?: { results?: SpecstreamPage[] } }>(ctx, name, `${base}/v1/extract`, {
        method: 'POST',
        headers: jsonHeaders(auth),
        body: JSON.stringify({ urls: [url], format: 'markdown' }),
      });
      const page = data.data?.results?.[0];
      if (!page || page.status !== 'ok') {
        const status = str(page?.status) || 'missing';
        throw new ProviderError(name, PAGE_ERRORS[status] ?? 'upstream', `specstream: page ${status}`);
      }
      return { url: str(page.final_url) || str(page.url) || url, title: page.title ? str(page.title) : undefined, content: str(page.text) };
    },
  };
}
