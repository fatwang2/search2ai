/**
 * zod schema: 服务端做请求校验, OpenAPI 与 MCP 工具定义都从这里生成, 保证三处一致。
 */
import { z } from 'zod';

export const RecencyFilterSchema = z.enum(['hour', 'day', 'week', 'month', 'year']);

const DateFilter = z
  .string()
  .regex(/^(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})$/, 'expected YYYY-MM-DD or MM/DD/YYYY');

const SessionId = z.uuid().describe('Opaque UUID for this conversation or research run. Reuse for related search/crawl calls; omit or change on new chat/reset.');

export const SearchRequestSchema = z.object({
  session_id: SessionId.optional(),
  query: z.union([z.string().min(1).max(2000), z.array(z.string().min(1).max(2000)).min(1).max(10)]),
  max_results: z.number().int().min(1).max(50).optional(),
  country: z.string().length(2).optional(),
  search_language_filter: z.array(z.string().length(2)).max(20).optional(),
  search_domain_filter: z.array(z.string().min(1).max(253)).max(20).optional(),
  search_recency_filter: RecencyFilterSchema.optional(),
  search_after_date_filter: DateFilter.optional(),
  search_before_date_filter: DateFilter.optional(),
  max_tokens_per_page: z.number().int().min(1).max(1_000_000).optional(),
  search_type: z.literal('web').optional(),
  providers: z.array(z.string().min(1)).max(10).optional(),
  crawl_results: z.number().int().min(0).max(10).optional(),
});

export const CrawlRequestSchema = z.object({
  session_id: SessionId.optional(),
  url: z.url(),
  providers: z.array(z.string().min(1)).max(10).optional(),
});

export const ProviderWarningSchema = z.object({
  provider: z.string(),
  code: z.enum(['auth', 'rate_limit', 'bad_request', 'upstream', 'network', 'timeout', 'empty', 'not_configured', 'unsupported']),
  message: z.string(),
  status: z.number().optional(),
});

export const SearchResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  date: z.string().optional(),
  last_updated: z.string().optional(),
  content: z.string().optional(),
});

export const SearchResponseSchema = z.object({
  session_id: SessionId.optional(),
  object: z.enum(['search', 'news']),
  id: z.string(),
  provider: z.string(),
  results: z.array(SearchResultSchema),
  warnings: z.array(ProviderWarningSchema).optional(),
  cached: z.boolean().optional(),
});

export const CrawlResponseSchema = z.object({
  session_id: SessionId.optional(),
  object: z.literal('crawl'),
  id: z.string(),
  provider: z.string(),
  url: z.string(),
  title: z.string().optional(),
  content: z.string(),
  links: z.array(z.string()).optional(),
  warnings: z.array(ProviderWarningSchema).optional(),
  cached: z.boolean().optional(),
});

export const ErrorResponseSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    code: z.union([z.string(), z.number()]).optional(),
    warnings: z.array(ProviderWarningSchema).optional(),
  }),
});

export type SearchRequestInput = z.infer<typeof SearchRequestSchema>;
export type CrawlRequestInput = z.infer<typeof CrawlRequestSchema>;
