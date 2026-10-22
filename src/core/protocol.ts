/** Raw calls for supported client protocols. Credentials stay inside the gateway. */
import type { GatewayConfig } from './config.ts';
import { GatewayError } from './errors.ts';

export type ClientProtocol = 'searxng' | 'exa' | 'tavily' | 'search1api' | 'firecrawl';
export interface ProtocolRequest {
  protocol: ClientProtocol;
  path: string;
  body: Record<string, unknown>;
  /** Allowlisted protocol headers; gateway authentication is never forwarded. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

const paths: Record<ClientProtocol, readonly string[]> = {
  searxng: ['/search'], exa: ['/search', '/contents'], tavily: ['/search', '/extract'],
  search1api: ['/search', '/news', '/crawl'], firecrawl: ['/v1/scrape', '/v2/scrape'],
};
const defaults = {
  exa: 'https://api.exa.ai', tavily: 'https://api.tavily.com',
  search1api: 'https://api.search1api.com', firecrawl: 'https://api.firecrawl.dev',
};

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

async function boundedText(response: Response): Promise<string> {
  if (Number(response.headers.get('Content-Length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new GatewayError(502, 'response_too_large', 'Native upstream response exceeds 4 MiB');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new GatewayError(502, 'response_too_large', 'Native upstream response exceeds 4 MiB');
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
}

export function createProtocolTransport(config: GatewayConfig): (req: ProtocolRequest) => Promise<Response> {
  const fetchFn = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  return async ({ protocol, path, body, signal, headers: protocolHeaders }) => {
    if (!paths[protocol].includes(path)) throw new GatewayError(404, 'not_found', 'Unsupported protocol route');
    const options = config.providers[protocol];
    if (!options) throw new GatewayError(503, 'no_provider', `${protocol} is not configured`);
    const base = (options.baseUrl ?? (protocol === 'searxng' ? '' : defaults[protocol])).replace(/\/+$/, '');
    const headers = new Headers({ Accept: 'application/json' });
    if (protocol === 'exa' && protocolHeaders?.['Exa-Beta']) headers.set('Exa-Beta', protocolHeaders['Exa-Beta']);
    if ('apiKey' in options && options.apiKey) {
      headers.set(protocol === 'exa' ? 'x-api-key' : 'Authorization', protocol === 'exa' ? options.apiKey : `Bearer ${options.apiKey}`);
    }
    const payload = { ...body };
    // Never send gateway credentials to an upstream, including legacy Tavily body auth.
    delete payload.api_key;
    if (protocol === 'searxng') {
      payload.format = 'json';
      // Integration-side result limits and HTML image proxy settings are not engine parameters.
      delete payload.numResults;
      delete payload.imageProxy;
      if (!payload.language && config.providers.searxng?.language) payload.language = config.providers.searxng.language;
    }
    if (protocol === 'search1api' && path !== '/crawl' && !payload.search_service && config.providers.search1api?.searchService) {
      payload.search_service = config.providers.search1api.searchService;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : 15_000);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      combined.throwIfAborted();
      const url = protocol === 'searxng'
        ? `${base}${path}?${new URLSearchParams(Object.entries(payload).map(([k, v]) => [k, String(v)]))}`
        : `${base}${path}`;
      if (protocol !== 'searxng') headers.set('Content-Type', 'application/json');
      const response = await fetchFn(url, { method: protocol === 'searxng' ? 'GET' : 'POST', headers, body: protocol === 'searxng' ? undefined : JSON.stringify(payload), signal: combined });
      // Buffer while the timer is active, including a stalled response body.
      const text = await boundedText(response);
      const outgoing = new Headers({ 'Content-Type': response.headers.get('Content-Type') ?? 'application/json' });
      for (const name of ['Retry-After', 'X-Request-Id']) {
        const value = response.headers.get(name);
        if (value) outgoing.set(name, value);
      }
      if (response.ok) {
        try { JSON.parse(text); } catch { throw new GatewayError(502, 'upstream_error', `${protocol} returned invalid JSON`); }
      }
      return new Response(text, { status: response.status, headers: outgoing });
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof GatewayError) throw error;
      throw new GatewayError(controller.signal.aborted ? 504 : 502, controller.signal.aborted ? 'timeout' : 'upstream_error', `${protocol} request ${controller.signal.aborted ? 'timed out' : 'failed'}`);
    } finally { clearTimeout(timer); }
  };
}
