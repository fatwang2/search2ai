/** Client protocols: retain native payloads; translate only the documented common subset. */
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { GatewayError } from '../core/errors.ts';
import type { Gateway } from '../core/gateway.ts';
import type { ClientProtocol } from '../core/protocol.ts';
import type { Operation, SearchRequest, SearchResponse } from '../core/types.ts';

type Body = Record<string, unknown>;
interface Plan {
  op: Operation;
  providersUsed: Set<string>;
  run(provider: string, signal: AbortSignal): Promise<Body>;
}
const id = () => crypto.randomUUID();
const protocolOfPath = (path: string) => path.split('/').reverse().find((s) => ['exa', 'tavily', 'search1api', 'firecrawl', 'searxng'].includes(s)) ?? '';
const fail = (message: string): never => { throw new GatewayError(400, 'invalid_request', message); };
const unsupported = (message: string): never => { throw new GatewayError(422, 'unsupported', message); };
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
function only(body: Body, fields: string[], neutral: Body = {}): void {
  for (const [key, value] of Object.entries(body)) {
    if (fields.includes(key)) continue;
    if (Object.hasOwn(neutral, key) && JSON.stringify(value) === JSON.stringify(neutral[key])) continue;
    unsupported(`Option ${key} requires the matching upstream protocol; it cannot be translated`);
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

/** Validate the common envelope even for native calls and exclude out-of-scope features. */
function validate(protocol: ClientProtocol, path: string, body: Body): void {
  if (operation(protocol, path, body) === 'crawl') {
    if (path === '/contents' || path === '/extract') urls(body.urls);
    else url(body.url);
  } else {
    string(body[protocol === 'searxng' ? 'q' : 'query'], protocol === 'searxng' ? 'q' : 'query');
    if (protocol !== 'searxng') integer(body[protocol === 'exa' ? 'numResults' : 'max_results'], 5, protocol === 'tavily' ? 20 : 50, 'result count');
  }
  if (protocol === 'searxng' && body.format !== undefined && body.format !== 'json') unsupported('Only SearXNG format=json is supported');
  if (protocol === 'exa') {
    const contents = body.contents === undefined || typeof body.contents === 'boolean' ? {} : record(body.contents, 'contents');
    for (const obj of [body, contents]) {
      if ((obj.subpages !== undefined && obj.subpages !== 0) || obj.subpageTarget !== undefined) unsupported('Recursive subpage crawling is outside the single-page scope');
      if (obj.summary || obj.outputSchema || obj.output_schema) unsupported('Generated summaries and structured extraction are not supported');
    }
    if (body.stream) unsupported('Streaming search is not supported');
  }
  if (protocol === 'tavily' && body.include_answer) unsupported('Generated answers are not supported');
  if (protocol === 'firecrawl') {
    if (body.actions !== undefined && (!Array.isArray(body.actions) || body.actions.length)) unsupported('Browser actions are not supported');
    if (body.formats !== undefined) {
      if (!Array.isArray(body.formats) || !body.formats.length) fail('formats must be a nonempty array');
      for (const f of body.formats as unknown[]) {
        const name = typeof f === 'string' ? f : record(f, 'format').type;
        if (!['markdown', 'html', 'rawHtml', 'links'].includes(String(name))) unsupported('Only single-page markdown, HTML and links formats are in scope');
      }
    }
  }
}

function makePlan(gateway: Gateway, protocol: ClientProtocol, path: string, body: Body): Plan {
  const op = operation(protocol, path, body);
  const t0 = Date.now();
  const requestId = id();
  const providersUsed = new Set<string>();
  const elapsed = () => (Date.now() - t0) / 1000;
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
      return { op, providersUsed, async run(provider, signal) {
        const result = await crawl(url(body.url), provider, signal);
        return { crawlParameters: { url: body.url }, results: { title: result.title ?? '', link: result.url, content: result.content, metadata: {} } };
      } };
    }
    if (protocol === 'firecrawl') {
      only(body, ['url', 'formats', 'origin'], { actions: [] });
      if (body.origin !== undefined && typeof body.origin !== 'string') fail('origin must be a string');
      const formats = body.formats ?? ['markdown'];
      if (JSON.stringify(formats) !== JSON.stringify(['markdown']) && JSON.stringify(formats) !== JSON.stringify([{ type: 'markdown' }])) unsupported('Translated Firecrawl scrape supports only markdown');
      return { op, providersUsed, async run(provider, signal) {
        const result = await crawl(url(body.url), provider, signal);
        return { success: true, data: { markdown: result.content, metadata: { sourceURL: result.url, ...(result.title ? { title: result.title } : {}) } } };
      } };
    }
    const targets = urls(body.urls);
    let textLimit: number | undefined;
    if (protocol === 'exa') {
      only(body, ['urls', 'text'], { subpages: 0, filterEmptyResults: true });
      if (body.text !== undefined && body.text !== true) {
        const options = record(body.text, 'text');
        only(options, ['maxCharacters']);
        textLimit = integer(options.maxCharacters, 10_000, 1_000_000, 'text.maxCharacters');
      }
    } else {
      only(body, ['urls'], { extract_depth: 'basic', format: 'markdown', include_images: false, include_favicon: false, include_usage: false });
    }
    return { op, providersUsed, async run(provider, signal) {
      const results = await batch(targets, (target) => crawl(target, provider, signal), signal);
      if (protocol === 'exa') {
        return {
          requestId,
          results: results.flatMap((r) => r.status === 'fulfilled' ? [{ id: r.value.url, url: r.value.url, title: r.value.title ?? '', text: textLimit ? r.value.content.slice(0, textLimit) : r.value.content }] : []),
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
  if (protocol === 'searxng') {
    only(body, ['q', 'format', 'categories', 'language', 'numResults'], { pageno: '1', engines: '', time_range: '', safesearch: '0', imageProxy: 'true' });
    if (body.categories !== undefined && !['general', 'news'].includes(String(body.categories))) unsupported('Translated SearXNG supports only general and news categories');
    request = { query: string(body.q, 'q'), max_results: integer(body.numResults === undefined ? undefined : Number(body.numResults), 10, 50, 'numResults'), crawl_results: 0 };
    if (/(?:^|\s)(?:!{1,2}\S+|:[a-z][\w-]*)(?=\s|$)/i.test(String(body.q))) unsupported('SearXNG bang and language query syntax requires a SearXNG upstream');
    if (body.language) {
      if (typeof body.language !== 'string' || !/^[a-z]{2}$/i.test(body.language)) unsupported('Translated language must be a two-letter language code');
      request.search_language_filter = [String(body.language)];
    }
  } else if (protocol === 'search1api') {
    only(body, ['query', 'max_results', 'crawl_results'], { page: 1, search_service: '', image: false, include_sites: [], exclude_sites: [], language: '', time_range: '' });
    const count = body.crawl_results ?? 0;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > 10) unsupported('Translated crawl_results must be between 0 and 10');
    request = { query: string(body.query, 'query'), max_results: integer(body.max_results, 5, 50, 'max_results'), crawl_results: 0 };
    // Require requested content instead of silently returning a warning without it.
    readText = Number(count) > 0;
  } else if (protocol === 'tavily') {
    only(body, ['query', 'max_results', 'topic', 'include_raw_content'], {
      search_depth: 'basic', include_answer: false, include_images: false, include_image_descriptions: false,
      include_favicon: false, include_domains: [], exclude_domains: [], auto_parameters: false, include_usage: false,
    });
    if (body.topic !== undefined && !['general', 'news'].includes(String(body.topic))) unsupported('Translated Tavily supports only general and news topics');
    if (body.include_raw_content !== undefined && ![false, true, 'markdown'].includes(body.include_raw_content as boolean)) unsupported('Translated raw content supports only markdown');
    readText = !!body.include_raw_content;
    request = { query: string(body.query, 'query'), max_results: integer(body.max_results, 5, 20, 'max_results'), crawl_results: 0 };
  } else {
    only(body, ['query', 'numResults', 'contents', 'type', 'category']);
    if (body.type !== undefined && body.type !== 'auto') unsupported('Only Exa type=auto can be translated');
    if (body.category !== undefined && body.category !== 'news') unsupported('Only Exa category=news can be translated');
    const contents = body.contents ?? { text: { maxCharacters: 10_000 } };
    if (contents !== false) {
      const options = contents === true ? { text: true } : record(contents, 'contents');
      only(options, ['text']);
      readText = options.text !== undefined && options.text !== false;
      if (readText && options.text !== true) {
        const text = record(options.text, 'contents.text');
        only(text, ['maxCharacters']);
        textLimit = integer(text.maxCharacters, 10_000, 1_000_000, 'contents.text.maxCharacters');
      }
    }
    request = { query: string(body.query, 'query'), max_results: integer(body.numResults, 10, 50, 'numResults'), crawl_results: 0 };
  }

  return { op, providersUsed, async run(provider, signal) {
    if (request.search_language_filter && !['search1api', 'searxng'].includes(provider)) unsupported(`${provider} cannot apply the requested language filter`);
    const limit = { tavily: 20, brave: 20, google: 10 }[provider as 'tavily' | 'brave' | 'google'];
    if (limit && request.max_results! > limit) unsupported(`${provider} supports at most ${limit} results per request`);
    if (readText && !gateway.chain('crawl').length) throw new GatewayError(503, 'no_provider', 'This request requires a configured single-page crawl provider');
    const result: SearchResponse = await gateway[op as 'search' | 'news']({ ...request, providers: [provider] }, { signal });
    providersUsed.add(result.provider);
    if (readText) {
      const count = protocol === 'search1api' ? Number(body.crawl_results) : result.results.length;
      const targets = result.results.slice(0, count);
      const settled = await batch(targets.map((r) => r.url), (target) => gateway.crawl({ url: target }, { signal }), signal);
      for (let i = 0; i < settled.length; i++) {
        const page = settled[i];
        if (page.status === 'rejected') throw new GatewayError(502, 'crawl_failed', 'A requested search result could not be read');
        providersUsed.add(page.value.provider);
        targets[i].content = textLimit ? page.value.content.slice(0, textLimit) : page.value.content;
      }
    }
    if (protocol === 'searxng') return {
      query: body.q,
      results: result.results.map((r) => ({ url: r.url, title: r.title, content: r.snippet, ...(r.date ? { publishedDate: r.date } : {}) })),
      answers: [], corrections: [], infoboxes: [], suggestions: [], unresponsive_engines: [],
    };
    if (protocol === 'search1api') return {
      searchParameters: { ...body, query: request.query, max_results: request.max_results, crawl_results: body.crawl_results ?? 0 },
      results: result.results.map((r) => ({ title: r.title, link: r.url, snippet: r.snippet, ...(r.content !== undefined ? { content: r.content } : {}), ...(r.date ? { published_date: r.date } : {}) })),
      images: [],
    };
    if (protocol === 'tavily') return {
      query: request.query,
      results: result.results.map((r) => ({ title: r.title, url: r.url, content: r.snippet, raw_content: r.content ?? null, ...(r.date ? { published_date: r.date } : {}) })),
      images: [], response_time: elapsed(), request_id: requestId,
    };
    return { requestId, results: result.results.map((r) => ({ id: r.url, url: r.url, title: r.title, ...(r.date ? { publishedDate: r.date } : {}), ...(r.content !== undefined ? { text: r.content } : {}) })) };
  } };
}

async function execute(gateway: Gateway, protocol: ClientProtocol, path: string, body: Body, signal: AbortSignal, headers?: Record<string, string>): Promise<Response> {
  validate(protocol, path, body);
  const op = operation(protocol, path, body);
  const configured = gateway.chain(op);
  const chain = protocol === 'search1api' && op === 'crawl' && body.enableFallback === false ? configured.slice(0, 1) : configured;
  if (!chain.length) throw new GatewayError(503, 'no_provider', `No provider configured for ${op}`);
  let lastError: unknown;
  let nativeError: Response | undefined;
  let firstEmpty: { response: Response; provider: string; mode: string } | undefined;
  let plan: Plan | undefined;
  let planError: unknown;
  try {
    if (headers?.['Exa-Beta']) unsupported('Exa beta features require an Exa upstream');
    plan = makePlan(gateway, protocol, path, body);
  } catch (error) { planError = error; }
  const skipped: string[] = [];
  const outgoing = (response: Response, provider: string, mode: string) => {
    const headers = new Headers(response.headers);
    headers.set('X-Search2AI-Provider', provider);
    headers.set('X-Search2AI-Mode', mode);
    if (skipped.length) headers.set('X-Search2AI-Skipped', skipped.join(','));
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
      } else if (plan) {
        translatingPages = plan.op === 'crawl';
        plan.providersUsed.clear();
        const result = await plan.run(provider, signal);
        const response = Response.json(result);
        const used = [...plan.providersUsed].join(',') || provider;
        // Each translated page already runs the remaining core crawl chain. Do not retry that tail here.
        if (!translatingPages && index < chain.length - 1 && await isEmpty(response)) firstEmpty ??= { response, provider: used, mode: 'translated' };
        else return outgoing(response, used, 'translated');
      }
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof GatewayError && error.code === 'unsupported' && lastError)) lastError = error;
      if (translatingPages) break;
    }
    skipped.push(provider);
  }
  if (firstEmpty) return outgoing(firstEmpty.response, firstEmpty.provider, firstEmpty.mode);
  if (nativeError) return outgoing(nativeError, protocol, 'native');
  throw lastError ?? planError ?? new GatewayError(503, 'no_provider', 'No compatible provider configured');
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
