/**
 * 公共类型: 网关统一的请求与响应, 用于连接不同的搜索后端和调用入口。
 * 扩展字段: 响应的 provider / content / warnings / cached, 请求的 providers / crawl_results。
 */

export type RecencyFilter = 'hour' | 'day' | 'week' | 'month' | 'year';

export type Operation = 'search' | 'news' | 'crawl';

export interface SearchRequest {
  /** Opaque UUID for related calls in one conversation/research run. Omit for a new run. */
  session_id?: string;
  /** 查询词, 支持数组(并行查询后合并去重) */
  query: string | string[];
  /** 返回条数, 默认 10, 上限 50 */
  max_results?: number;
  /** ISO 3166-1 两位国家码 */
  country?: string;
  /** ISO 639-1 两位语言码 */
  search_language_filter?: string[];
  /** 只在这些域名内搜索 */
  search_domain_filter?: string[];
  /** 发布时间新鲜度 */
  search_recency_filter?: RecencyFilter;
  /** 发布时间下限, 接受 YYYY-MM-DD 或 MM/DD/YYYY */
  search_after_date_filter?: string;
  /** 发布时间上限 */
  search_before_date_filter?: string;
  /** 单条结果正文 token 上限(仅在抓取正文时生效, 近似按字符裁剪) */
  max_tokens_per_page?: number;
  /** 搜索类型, 当前仅支持 web */
  search_type?: 'web';
  /** 扩展: 本次请求的 provider 顺序, 覆盖默认 fallback 链 */
  providers?: string[];
  /** 扩展: 对前 N 条结果抓取正文写入 content */
  crawl_results?: number;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** 发布日期 YYYY-MM-DD, 各 provider 尽力提供 */
  date?: string;
  last_updated?: string;
  /** 扩展: 抓取到的正文 */
  content?: string;
}

export type ProviderErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'bad_request'
  | 'upstream'
  | 'network'
  | 'timeout'
  | 'empty'
  | 'not_configured'
  | 'unsupported';

export interface ProviderWarning {
  provider: string;
  code: ProviderErrorCode;
  message: string;
  status?: number;
}

export interface SearchResponse {
  session_id?: string;
  object: 'search' | 'news';
  id: string;
  /** 实际给出结果的 provider */
  provider: string;
  results: SearchResult[];
  /** fallback 过程中跳过的 provider 及原因 */
  warnings?: ProviderWarning[];
  cached?: boolean;
}

export interface CrawlRequest {
  session_id?: string;
  url: string;
  providers?: string[];
}

export interface CrawlResult {
  url: string;
  title?: string;
  content: string;
  links?: string[];
}

export interface CrawlResponse extends CrawlResult {
  session_id?: string;
  object: 'crawl';
  id: string;
  provider: string;
  warnings?: ProviderWarning[];
  cached?: boolean;
}

/** 传给 provider 的归一化查询参数(单条 query, 已解析默认值) */
export interface ProviderSearchParams {
  query: string;
  maxResults: number;
  country?: string;
  languages?: string[];
  domains?: string[];
  recency?: RecencyFilter;
  /** YYYY-MM-DD */
  afterDate?: string;
  beforeDate?: string;
  /** provider 若原生支持抓取正文(如 search1api), 可直接返回 content */
  crawlResults?: number;
}

export interface ProviderContext {
  /** Supplied by the research-run owner, independent of any MCP connection. */
  sessionId?: string;
  fetch: typeof fetch;
  signal: AbortSignal;
}

export interface SearchProvider {
  readonly name: string;
  search?(params: ProviderSearchParams, ctx: ProviderContext): Promise<SearchResult[]>;
  news?(params: ProviderSearchParams, ctx: ProviderContext): Promise<SearchResult[]>;
  crawl?(url: string, ctx: ProviderContext): Promise<CrawlResult>;
}

export interface ProviderInfo {
  name: string;
  capabilities: Operation[];
}

export interface Cache {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}
