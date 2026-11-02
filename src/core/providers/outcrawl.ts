/**
 * Outcrawl: /v1/search 搜索, /v1/scrape 抓取正文(markdown)。https://outcrawl.ai/docs
 */
import { fetchJson, jsonHeaders, str, withSiteFilter } from '../http.ts';
import type { CrawlResult, ProviderContext, ProviderSearchParams, SearchProvider, SearchResult } from '../types.ts';

export interface OutcrawlOptions {
  apiKey: string;
  baseUrl?: string;
}

interface OutcrawlHit {
  url?: string;
  title?: string;
  snippet?: string;
  rank?: number;
}

/** /v1/search 的 limit 上限 */
const MAX_LIMIT = 20;

export function createOutcrawl(opts: OutcrawlOptions): SearchProvider {
  const name = 'outcrawl';
  const base = (opts.baseUrl ?? 'https://api.outcrawl.ai').replace(/\/+$/, '');
  const headers = jsonHeaders({ Authorization: `Bearer ${opts.apiKey}` });

  return {
    name,
    async search(p: ProviderSearchParams, ctx: ProviderContext): Promise<SearchResult[]> {
      const body = { query: withSiteFilter(p.query, p.domains), limit: Math.min(p.maxResults, MAX_LIMIT) };
      const data = await fetchJson<{ hits?: OutcrawlHit[] }>(ctx, name, `${base}/v1/search`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      return (data.hits ?? []).slice(0, p.maxResults).map((h) => ({ title: str(h.title), url: str(h.url), snippet: str(h.snippet) }));
    },
    async crawl(url, ctx): Promise<CrawlResult> {
      const data = await fetchJson<{ url?: string; markdown?: string; metadata?: { title?: string } }>(ctx, name, `${base}/v1/scrape`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
      });
      return { url: str(data.url) || url, title: data.metadata?.title ? str(data.metadata.title) : undefined, content: str(data.markdown) };
    },
  };
}
