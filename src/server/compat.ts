/** Client protocols: retain native payloads and translate across providers on a best-effort basis. */
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { GatewayError } from '../core/errors.ts';
import { toIsoDate } from '../core/http.ts';
import type { Gateway } from '../core/gateway.ts';
import type { ClientProtocol } from '../core/protocol.ts';
import type { Operation, RecencyFilter, SearchRequest, SearchResponse } from '../core/types.ts';

type Body = Record<string, unknown>;
interface Plan {
  op: Operation;
  providersUsed: Set<string>;
  ignored: Set<string>;
  warnings: Set<string>;
  run(provider: string, signal: AbortSignal): Promise<Body>;
}
const id = () => crypto.randomUUID();
const protocolOfPath = (path: string) => path.split('/').reverse().find((s) => ['exa', 'tavily', 'search1api', 'firecrawl', 'searxng'].includes(s)) ?? '';
const fail = (message: string): never => { throw new GatewayError(400, 'invalid_request', message); };
function record(value: unknown, field = 'body'): Body {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(`${field} must be an object`);
  return value as Body;
}
function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) return fail(`${field} must be a nonempty string of at most 2000 characters`);
  return value;
}
function integer(value: unknown, fallback: number, max: number, field: string): number {
  const n = value ?? fallback;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > max) return fail(`${field} must be an integer between 1 and ${max}`);
  return n;
}
function url(value: unknown): string {
  const text = string(value, 'url');
  try { if (['https:', 'http:'].includes(new URL(text).protocol)) return text; } catch { /* invalid */ }
  return fail('url must be an absolute HTTP(S) URL');
}
function urls(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  if (!list.length || list.length > 10) return fail('urls must contain between 1 and 10 URLs');
  return list.map(url);
}
function noteIgnored(body: Body, fields: string[], ignored: Set<string>, neutral: Body = {}, prefix = ''): void {
  for (const [key, value] of Object.entries(body)) {
    if (fields.includes(key)) continue;
    if (Object.hasOwn(neutral, key) && JSON.stringify(value) === JSON.stringify(neutral[key])) continue;
    ignored.add(`${prefix}${key}`);
  }
}
function errorResponse(protocol: string, error: unknown): Response {
  const e = error instanceof GatewayError ? error : new GatewayError(500, 'internal_error', 'Internal Server Error');
  const body = protocol === 'exa' ? { requestId: id(), error: e.message, tag: e.code.toUpperCase() }
    : protocol === 'tavily' ? { detail: { error: e.message } }
    : protocol === 'firecrawl' ? { success: false, error: e.message }
    : protocol === 'search1api' ? { ok: false, error: e.code, message: e.message }
    : { error: e.message };
  return Response.json(body, { status: e.status });
}

/** Bound concurrency; a batch is explicit URLs, never recursive discovery. */
async function batch<T>(items: string[], run: (value: string) => Promise<T>, signal: AbortSignal): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(items.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (index < items.length) {
      signal.throwIfAborted();
      const current = index++;
      try { results[current] = { status: 'fulfilled', value: await run(items[current]) }; }
      catch (reason) { signal.throwIfAborted(); results[current] = { status: 'rejected', reason }; }
    }
  }));
  return results;
}

function operation(protocol: ClientProtocol, path: string, body: Body): Operation {
  if (['/crawl', '/contents', '/extract', '/v1/scrape', '/v2/scrape'].includes(path)) return 'crawl';
  if (path === '/news' || (protocol === 'tavily' && body.topic === 'news') || (protocol === 'exa' && body.category === 'news') || (protocol === 'searxng' && body.categories === 'news')) return 'news';
  return 'search';
}

/** Invalid request envelopes still fail; optional provider capabilities never gate translation. */
function validate(protocol: ClientProtocol, path: string, body: Body): void {
  if (operation(protocol, path, body) === 'crawl') {
    if (path === '/contents' || path === '/extract') urls(body.urls);
    else url(body.url);
  } else {
    string(body[protocol === 'searxng' ? 'q' : 'query'], protocol === 'searxng' ? 'q' : 'query');
    if (protocol !== 'searxng') integer(body[protocol === 'exa' ? 'numResults' : 'max_results'], 5, Number.MAX_SAFE_INTEGER, 'result count');
  }
  if (protocol === 'exa' && body.contents !== undefined && typeof body.contents !== 'boolean') record(body.contents, 'contents');
  if (protocol === 'firecrawl' && body.formats !== undefined) {
    if (!Array.isArray(body.formats) || !body.formats.length) fail('formats must be a nonempty array');
    for (const format of body.formats as unknown[]) {
      if (typeof format !== 'string' && typeof record(format, 'format').type !== 'string') fail('format.type must be a string');
    }
  }
}

/** Preserve the search/single-page scope while ignoring options that ask for other features. */
function withinScope(protocol: ClientProtocol, original: Body): { body: Body; ignored: Set<string> } {
  const body = { ...original };
  const ignored = new Set<string>();
  const drop = (obj: Body, keys: string[], prefix = '') => {
    for (const key of keys) if (Object.hasOwn(obj, key)) {
      if (obj[key] && !(key === 'actions' && Array.isArray(obj[key]) && !obj[key].length)) ignored.add(`${prefix}${key}`);
      delete obj[key];
    }
  };
  if (protocol === 'searxng' && body.format !== undefined && body.format !== 'json') {
    ignored.add('format');
    body.format = 'json';
  }
  if (protocol === 'exa') {
    drop(body, ['stream', 'subpages', 'subpageTarget', 'summary', 'outputSchema', 'output_schema']);
    if (body.contents && typeof body.contents === 'object') {
      body.contents = { ...record(body.contents) };
      drop(body.contents as Body, ['subpages', 'subpageTarget', 'summary', 'outputSchema', 'output_schema'], 'contents.');
    }
  }
  if (protocol === 'tavily') drop(body, ['include_answer']);
  if (protocol === 'firecrawl') {
    drop(body, ['actions']);
    if (Array.isArray(body.formats)) {
      const formats = body.formats.filter((f) => ['markdown', 'html', 'rawHtml', 'links'].includes(typeof f === 'string' ? f : String(record(f).type)));
      if (formats.length !== body.formats.length) ignored.add('formats');
      body.formats = formats.length ? formats : ['markdown'];
    }
  }
  return { body, ignored };
}

function makePlan(gateway: Gateway, protocol: ClientProtocol, path: string, body: Body): Plan {
  const op = operation(protocol, path, body);
  const t0 = Date.now();
  const requestId = id();
  const providersUsed = new Set<string>();
  const ignored = new Set<string>();
  const warnings = new Set<string>();
  const plan = { op, providersUsed, ignored, warnings };
  const elapsed = () => (Date.now() - t0) / 1000;
  const only = (value: Body, fields: string[], neutral: Body = {}, prefix = '') => noteIgnored(value, fields, ignored, neutral, prefix);
  const crawl = (target: string, provider: string, signal: AbortSignal) => {
    const chain = gateway.chain('crawl');
    const remaining = body.enableFallback === false ? [provider] : chain.slice(chain.indexOf(provider));
    return gateway.crawl({ url: target, providers: remaining }, { signal }).then((result) => {
      providersUsed.add(result.provider);
      return result;
    });
  };

  if (op === 'crawl') {
    if (protocol === 'search1api') {
      only(body, ['url', 'enableFallback']);
      if (body.enableFallback !== undefined && typeof body.enableFallback !== 'boolean') fail('enableFallback must be a boolean');
      return { ...plan, async run(provider, signal) {
        const result = await crawl(url(body.url), provider, signal);
        return { crawlParameters: { url: body.url }, results: { title: result.title ?? '', link: result.url, content: result.content, metadata: {} } };
      } };
    }
    if (protocol === 'firecrawl') {
      only(body, ['url', 'formats', 'origin']);
      if (body.origin !== undefined && typeof body.origin !== 'string') fail('origin must be a string');
      const formats = body.formats ?? ['markdown'];
      if (JSON.stringify(formats) !== JSON.stringify(['markdown']) && JSON.stringify(formats) !== JSON.stringify([{ type: 'markdown' }])) {
        ignored.add('formats');
        warnings.add('markdown_fallback');
      }
      return { ...plan, async run(provider, signal) {
        const result = await crawl(url(body.url), provider, signal);
        return { success: true, data: { markdown: result.content, ...(result.links ? { links: result.links } : {}), metadata: { sourceURL: result.url, ...(result.title ? { title: result.title } : {}) } } };
      } };
    }
    const targets = urls(body.urls);
    let textLimit: number | undefined;
    if (protocol === 'exa') {
      only(body, ['urls', 'text'], { filterEmptyResults: true });
      if (body.text !== undefined && body.text !== true && body.text !== false) {
        const options = record(body.text, 'text');
        only(options, ['maxCharacters'], {}, 'text.');
        textLimit = integer(options.maxCharacters, 10_000, 1_000_000, 'text.maxCharacters');
      }
    } else {
      only(body, ['urls'], { extract_depth: 'basic', format: 'markdown', include_images: false, include_favicon: false, include_usage: false });
      if (body.format && body.format !== 'markdown') warnings.add('markdown_fallback');
    }
    return { ...plan, async run(provider, signal) {
      const results = await batch(targets, (target) => crawl(target, provider, signal), signal);
      if (protocol === 'exa') {
        return {
          requestId,
          results: results.flatMap((r) => r.status === 'fulfilled' ? [{ id: r.value.url, url: r.value.url, title: r.value.title ?? '', ...(body.text === false ? {} : { text: textLimit ? r.value.content.slice(0, textLimit) : r.value.content }) }] : []),
          statuses: results.map((r, i) => r.status === 'fulfilled' ? { id: targets[i], status: 'success' } : { id: targets[i], status: 'error', error: { tag: 'CRAWL_FAILED', httpStatusCode: r.reason instanceof GatewayError ? r.reason.status : 502 } }),
        };
      }
      return {
        results: results.flatMap((r) => r.status === 'fulfilled' ? [{ url: r.value.url, raw_content: r.value.content, images: [] }] : []),
        failed_results: results.flatMap((r, i) => r.status === 'rejected' ? [{ url: targets[i], error: 'Failed to retrieve content' }] : []),
        response_time: elapsed(), request_id: requestId,
      };
    } };
  }

  let request: SearchRequest;
  let readText = false;
  let textLimit: number | undefined;
  const countField = protocol === 'exa' || protocol === 'searxng' ? 'numResults' : 'max_results';
  const count = integer(protocol === 'searxng' && body.numResults !== undefined ? Number(body.numResults) : body[countField], protocol === 'exa' || protocol === 'searxng' ? 10 : 5, Number.MAX_SAFE_INTEGER, countField);
  if (protocol === 'searxng') {
    only(body, ['q', 'format', 'categories', 'language', 'numResults', 'time_range'], { pageno: '1', engines: '', safesearch: '0', imageProxy: 'true' });
    if (body.categories !== undefined && !['general', 'news'].includes(String(body.categories))) ignored.add('categories');
    const query = string(body.q, 'q');
    const plain = query.replace(/(^|\s)(?:!{1,2}\S+|:[a-z][\w-]*)(?=\s|$)/gi, '$1').trim();
    if (plain !== query.trim()) ignored.add('q.syntax');
    request = { query: plain || query, max_results: count, crawl_results: 0 };
  } else if (protocol === 'search1api') {
    only(body, ['query', 'max_results', 'crawl_results', 'include_sites', 'exclude_sites', 'language', 'time_range'], { page: 1, search_service: '', image: false });
    const crawlCount = body.crawl_results ?? 0;
    if (typeof crawlCount !== 'number' || !Number.isSafeInteger(crawlCount) || crawlCount < 0) return fail('crawl_results must be a nonnegative integer');
    if (crawlCount > 10) warnings.add('crawl_limit_clamped');
    request = { query: string(body.query, 'query'), max_results: count, crawl_results: 0 };
    readText = crawlCount > 0;
  } else if (protocol === 'tavily') {
    only(body, ['query', 'max_results', 'topic', 'include_raw_content', 'include_domains', 'exclude_domains', 'time_range', 'start_date', 'end_date', 'country'], {
      search_depth: 'basic', include_images: false, include_image_descriptions: false,
      include_favicon: false, auto_parameters: false, include_usage: false,
    });
    if (body.topic !== undefined && !['general', 'news'].includes(String(body.topic))) ignored.add('topic');
    if (body.include_raw_content !== undefined && ![false, true, 'markdown', 'text'].includes(body.include_raw_content as boolean)) ignored.add('include_raw_content');
    readText = [true, 'markdown', 'text'].includes(body.include_raw_content as boolean);
    request = { query: string(body.query, 'query'), max_results: count, crawl_results: 0 };
  } else {
    only(body, ['query', 'numResults', 'contents', 'type', 'category', 'includeDomains', 'excludeDomains', 'startPublishedDate', 'endPublishedDate']);
    if (body.type !== undefined && body.type !== 'auto') ignored.add('type');
    if (body.category !== undefined && body.category !== 'news') ignored.add('category');
    const contents = body.contents ?? { text: { maxCharacters: 10_000 } };
    if (contents !== false) {
      const options = contents === true ? { text: true } : record(contents, 'contents');
      only(options, ['text'], {}, 'contents.');
      readText = options.text !== undefined && options.text !== false;
      if (readText && options.text !== true) {
        const text = record(options.text, 'contents.text');
        only(text, ['maxCharacters'], {}, 'contents.text.');
        textLimit = integer(text.maxCharacters, 10_000, 1_000_000, 'contents.text.maxCharacters');
      }
    }
    request = { query: string(body.query, 'query'), max_results: count, crawl_results: 0 };
  }

  // Map shared capabilities through the gateway's existing provider adapters.
  const domainField = protocol === 'exa' ? 'includeDomains' : protocol === 'tavily' ? 'include_domains' : 'include_sites';
  const excludeField = protocol === 'exa' ? 'excludeDomains' : protocol === 'tavily' ? 'exclude_domains' : 'exclude_sites';
  for (const field of protocol === 'searxng' ? [] : [domainField, excludeField]) if (body[field] !== undefined) {
    const value = body[field];
    if (!Array.isArray(value) || value.some((d) => typeof d !== 'string' || !d.trim() || /\s/.test(d))) return fail(`${field} must be an array of nonempty domains without whitespace`);
    if (field === domainField) request.search_domain_filter = value as string[];
    else if (value.length) request.query = `${request.query} ${(value as string[]).map((d) => `-site:${d}`).join(' ')}`;
  }
  if ((protocol === 'searxng' || protocol === 'search1api') && body.language) {
    if (typeof body.language !== 'string') return fail('language must be a string');
    const language = body.language.match(/^([a-z]{2})(?:[-_][a-z]{2})?$/i);
    if (language) {
      request.search_language_filter = [language[1].toLowerCase()];
      if (body.language.length > 2) warnings.add('language_normalized');
    } else ignored.add('language');
  }
  if (protocol !== 'exa' && body.time_range) {
    if (typeof body.time_range !== 'string') return fail('time_range must be a string');
    const recency: Record<string, RecencyFilter> = { h: 'hour', hour: 'hour', d: 'day', day: 'day', w: 'week', week: 'week', m: 'month', month: 'month', y: 'year', year: 'year' };
    if (Object.hasOwn(recency, body.time_range)) request.search_recency_filter = recency[body.time_range];
    else ignored.add('time_range');
  }
  const afterField = protocol === 'exa' ? 'startPublishedDate' : 'start_date';
  const beforeField = protocol === 'exa' ? 'endPublishedDate' : 'end_date';
  const dates = protocol === 'exa' || protocol === 'tavily' ? [[afterField, 'search_after_date_filter'], [beforeField, 'search_before_date_filter']] as const : [];
  for (const [field, target] of dates) if (body[field] !== undefined) {
    const date = typeof body[field] === 'string' ? toIsoDate(body[field]) : undefined;
    if (!date) return fail(`${field} must be a valid date`);
    request[target] = date;
  }
  if (protocol === 'tavily' && body.country !== undefined) {
    if (typeof body.country !== 'string' || !/^[a-z]{2}$/i.test(body.country)) return fail('country must be a two-letter country code');
    request.country = body.country;
  }

  return { ...plan, async run(provider, signal) {
    const translated = { ...request, providers: [provider] };
    if (translated.search_language_filter && !['search1api', 'searxng', 'serper', 'brave', 'google'].includes(provider)) {
      delete translated.search_language_filter;
      ignored.add('language');
    }
    if (!['exa', 'tavily', 'brave'].includes(provider)) {
      if (translated.search_after_date_filter) { delete translated.search_after_date_filter; ignored.add(afterField); }
      if (translated.search_before_date_filter) { delete translated.search_before_date_filter; ignored.add(beforeField); }
    }
    if (translated.country && !['tavily', 'serper', 'google', 'brave'].includes(provider)) {
      delete translated.country;
      ignored.add('country');
    }
    const limit = { tavily: 20, brave: 20, google: 10 }[provider as 'tavily' | 'brave' | 'google'] ?? 50;
    if (count > limit) warnings.add('result_limit_clamped');
    translated.max_results = Math.min(count, limit);
    const result: SearchResponse = await gateway[op as 'search' | 'news'](translated, { signal });
    providersUsed.add(result.provider);
    if (readText) {
      const requested = protocol === 'search1api' ? Math.min(Number(body.crawl_results), 10) : result.results.length;
      const targets = result.results.slice(0, requested);
      const missing = targets.filter((r) => r.content === undefined);
      if (missing.length && !gateway.chain('crawl').length) warnings.add('content_unavailable');
      else {
        const settled = await batch(missing.map((r) => r.url), (target) => gateway.crawl({ url: target }, { signal }), signal);
        for (let i = 0; i < settled.length; i++) {
          const page = settled[i];
          if (page.status === 'rejected') { warnings.add('content_partial'); continue; }
          providersUsed.add(page.value.provider);
          missing[i].content = page.value.content;
        }
      }
      if (textLimit) for (const target of targets) if (target.content !== undefined) target.content = target.content.slice(0, textLimit);
    }
    if (protocol === 'searxng') return {
      query: body.q,
      results: result.results.map((r) => ({ url: r.url, title: r.title, content: r.snippet, ...(r.date ? { publishedDate: r.date } : {}) })),
      answers: [], corrections: [], infoboxes: [], suggestions: [], unresponsive_engines: [],
    };
    if (protocol === 'search1api') return {
      searchParameters: { query: body.query, max_results: translated.max_results, crawl_results: Math.min(Number(body.crawl_results ?? 0), 10) },
      results: result.results.map((r) => ({ title: r.title, link: r.url, snippet: r.snippet, ...(r.content !== undefined ? { content: r.content } : {}), ...(r.date ? { published_date: r.date } : {}) })),
      images: [],
    };
    if (protocol === 'tavily') return {
      query: body.query,
      results: result.results.map((r) => ({ title: r.title, url: r.url, content: r.snippet, raw_content: r.content ?? null, ...(r.date ? { published_date: r.date } : {}) })),
      images: [], response_time: elapsed(), request_id: requestId,
    };
    return { requestId, results: result.results.map((r) => ({ id: r.url, url: r.url, title: r.title, ...(r.date ? { publishedDate: r.date } : {}), ...(r.content !== undefined ? { text: r.content } : {}) })) };
  } };
}

async function execute(gateway: Gateway, protocol: ClientProtocol, path: string, body: Body, signal: AbortSignal, headers?: Record<string, string>): Promise<Response> {
  validate(protocol, path, body);
  const scoped = withinScope(protocol, body);
  body = scoped.body;
  const op = operation(protocol, path, body);
  const configured = gateway.chain(op);
  const chain = protocol === 'search1api' && op === 'crawl' && body.enableFallback === false ? configured.slice(0, 1) : configured;
  if (!chain.length) throw new GatewayError(503, 'no_provider', `No provider configured for ${op}`);
  let lastError: unknown;
  let nativeError: Response | undefined;
  type Hints = { ignored: Set<string>; warnings: Set<string> };
  let firstEmpty: { response: Response; provider: string; mode: string; hints?: Hints } | undefined;
  const skipped: string[] = [];
  const outgoing = (response: Response, provider: string, mode: string, hints?: Hints) => {
    const headers = new Headers(response.headers);
    headers.set('X-Search2AI-Provider', provider);
    headers.set('X-Search2AI-Mode', mode);
    if (skipped.length) headers.set('X-Search2AI-Skipped', skipped.join(','));
    // Encode arbitrary option names and bound diagnostic headers independently of request size.
    const ignored = [...new Set([...scoped.ignored, ...(hints?.ignored ?? [])])];
    if (ignored.length) headers.set('X-Search2AI-Ignored', ignored.slice(0, 50).map((field) => {
      // URLSearchParams also replaces malformed Unicode safely; encode spaces consistently.
      const encoded = new URLSearchParams({ f: field }).toString().slice(2).replace(/\+/g, '%20');
      return encoded.length <= 120 ? encoded : 'option_name_truncated';
    }).join(','));
    if (hints?.warnings.size) headers.set('X-Search2AI-Warnings', [...hints.warnings].join(','));
    return new Response(response.body, { status: response.status, headers });
  };
  const isEmpty = async (response: Response): Promise<boolean> => {
    if (!gateway.fallbackOnEmpty) return false;
    try {
      const value = await response.clone().json() as Body;
      if (Array.isArray(value.results)) return value.results.length === 0;
      if (protocol === 'search1api' && op === 'crawl') return !record(value.results).content;
      if (protocol === 'firecrawl') {
        const data = record(value.data);
        return !['markdown', 'html', 'rawHtml', 'links'].some((key) => typeof data[key] === 'string' ? !!data[key] : Array.isArray(data[key]) && data[key].length > 0);
      }
    } catch { /* The upstream owns native response validation. */ }
    return false;
  };
  for (const [index, provider] of chain.entries()) {
    signal.throwIfAborted();
    let translatingPages = false;
    try {
      if (provider === protocol && gateway.protocol) {
        const response = await gateway.protocol({ protocol, path, body, signal, headers });
        if (response.ok) {
          if (index < chain.length - 1 && await isEmpty(response)) firstEmpty ??= { response, provider, mode: 'native' };
          else return outgoing(response, provider, 'native');
        } else nativeError = response;
      } else {
        const plan = makePlan(gateway, protocol, path, body);
        if (headers?.['Exa-Beta']) plan.ignored.add('Exa-Beta');
        translatingPages = plan.op === 'crawl';
        const result = await plan.run(provider, signal);
        const response = Response.json(result);
        const used = [...plan.providersUsed].join(',') || provider;
        // Each translated page already runs the remaining core crawl chain. Do not retry that tail here.
        if (!translatingPages && index < chain.length - 1 && await isEmpty(response)) firstEmpty ??= { response, provider: used, mode: 'translated', hints: plan };
        else return outgoing(response, used, 'translated', plan);
      }
    } catch (error) {
      signal.throwIfAborted();
      // Invalid mapped parameters are request errors, not a reason to try a different provider.
      if (error instanceof GatewayError && error.status === 400) throw error;
      lastError = error;
      if (translatingPages) break;
    }
    skipped.push(provider);
  }
  if (firstEmpty) return outgoing(firstEmpty.response, firstEmpty.provider, firstEmpty.mode, firstEmpty.hints);
  if (nativeError) return outgoing(nativeError, protocol, 'native');
  throw lastError ?? new GatewayError(503, 'no_provider', 'No compatible provider configured');
}

export function createCompatibilityApp(gateway: Gateway, authKeys: string[]): Hono {
  const app = new Hono();
  const keys = new Set(authKeys);
  app.use('*', bodyLimit({ maxSize: 256 * 1024, onError: (c) => errorResponse(protocolOfPath(c.req.path), new GatewayError(413, 'request_too_large', 'Request body exceeds 256 KiB')) }));
  const handler = (protocol: ClientProtocol, path: string) => async (c: Context): Promise<Response> => {
    try {
      let body: Body;
      if (protocol === 'searxng') {
        const values = new URLSearchParams(new URL(c.req.url).search);
        if (c.req.method === 'POST') {
          const text = await c.req.text();
          // Some existing integrations POST query parameters with no request body.
          if (text) {
            if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/x-www-form-urlencoded')) fail('SearXNG POST bodies must use application/x-www-form-urlencoded');
            const form = new URLSearchParams(text);
            for (const key of new Set(form.keys())) { values.delete(key); for (const value of form.getAll(key)) values.append(key, value); }
          }
        }
        body = {};
        for (const [key, value] of values) {
          if (Object.hasOwn(body, key)) fail(`Duplicate parameter: ${key}`);
          body[key] = value;
        }
        if (body.pageNumber !== undefined) {
          if (body.pageno !== undefined && body.pageno !== body.pageNumber) fail('Conflicting pageNumber and pageno');
          body.pageno = body.pageNumber;
          delete body.pageNumber;
        }
      } else {
        try { body = record(await c.req.json()); } catch (error) {
          if (error instanceof GatewayError) throw error;
          fail('Invalid JSON request body');
        }
      }
      const bearer = c.req.header('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1].trim();
      const apiKey = protocol === 'exa' ? c.req.header('x-api-key') : undefined;
      const legacy = protocol === 'tavily' && typeof body!.api_key === 'string' ? body!.api_key : undefined;
      const credentials = [bearer, apiKey, legacy].filter((v): v is string => !!v);
      if (keys.size && (!credentials.length || credentials.some((key) => !keys.has(key)))) throw new GatewayError(401, 'unauthorized', 'Invalid or missing gateway API key');
      const clean = { ...body! };
      if (protocol === 'tavily') delete clean.api_key;
      const beta = protocol === 'exa' ? c.req.header('Exa-Beta') : undefined;
      return await execute(gateway, protocol, path, clean, c.req.raw.signal, beta ? { 'Exa-Beta': beta } : undefined);
    } catch (error) {
      if (c.req.raw.signal.aborted) return errorResponse(protocol, new GatewayError(499, 'cancelled', 'Request cancelled'));
      return errorResponse(protocol, error);
    }
  };
  for (const path of ['/searxng', '/searxng/', '/searxng/search']) app.on(['GET', 'POST'], path, handler('searxng', '/search'));
  for (const [protocol, paths] of Object.entries({
    exa: ['/search', '/contents'], tavily: ['/search', '/extract'], search1api: ['/search', '/news', '/crawl'], firecrawl: ['/v1/scrape', '/v2/scrape'],
  })) for (const path of paths) app.post(`/${protocol}${path}`, handler(protocol as ClientProtocol, path));
  app.all('*', (c) => errorResponse(protocolOfPath(c.req.path), new GatewayError(404, 'not_found', 'Unsupported compatibility route; only search and single-page reading are available')));
  return app;
}
