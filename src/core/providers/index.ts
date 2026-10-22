/**
 * provider 注册表: 新增一家后端只需实现 SearchProvider 并在此登记。
 */
import { createParallel, type ParallelOptions } from './parallel.ts';
import { createBrave, type BraveOptions } from './brave.ts';
import { createExa, type ExaOptions } from './exa.ts';
import { createFirecrawl, type FirecrawlOptions } from './firecrawl.ts';
import { createGoogle, type GoogleOptions } from './google.ts';
import { createJina, type JinaOptions } from './jina.ts';
import { createSearch1api, type Search1apiOptions } from './search1api.ts';
import { createSearxng, type SearxngOptions } from './searxng.ts';
import { createSerpapi, type SerpapiOptions } from './serpapi.ts';
import { createSerper, type SerperOptions } from './serper.ts';
import { createTavily, type TavilyOptions } from './tavily.ts';
import type { Operation, ProviderInfo, SearchProvider } from '../types.ts';

export interface ProviderOptionsMap {
  parallel: ParallelOptions;
  search1api: Search1apiOptions;
  tavily: TavilyOptions;
  brave: BraveOptions;
  exa: ExaOptions;
  serper: SerperOptions;
  serpapi: SerpapiOptions;
  google: GoogleOptions;
  searxng: SearxngOptions;
  jina: JinaOptions;
  firecrawl: FirecrawlOptions;
}

export type ProviderName = keyof ProviderOptionsMap;

type Factories = { [K in ProviderName]: (opts: ProviderOptionsMap[K]) => SearchProvider };

export const providerFactories: Factories = {
  parallel: createParallel,
  search1api: createSearch1api,
  tavily: createTavily,
  brave: createBrave,
  exa: createExa,
  serper: createSerper,
  serpapi: createSerpapi,
  google: createGoogle,
  searxng: createSearxng,
  jina: createJina,
  firecrawl: createFirecrawl,
};

/** 未显式指定链时的默认优先级(只取已配置的) */
export const defaultPriority: ProviderName[] = [
  'search1api',
  'tavily',
  'brave',
  'exa',
  'serper',
  'serpapi',
  'google',
  'searxng',
  'jina',
  'firecrawl',
  'parallel',
];

export function isProviderName(name: string): name is ProviderName {
  return Object.prototype.hasOwnProperty.call(providerFactories, name);
}

export function createProvider<K extends ProviderName>(name: K, opts: ProviderOptionsMap[K]): SearchProvider {
  return providerFactories[name](opts);
}

export function capabilitiesOf(p: SearchProvider): Operation[] {
  const caps: Operation[] = [];
  if (p.search) caps.push('search');
  if (p.news) caps.push('news');
  if (p.crawl) caps.push('crawl');
  return caps;
}

export function describeProvider(p: SearchProvider): ProviderInfo {
  return { name: p.name, capabilities: capabilitiesOf(p) };
}

export type {
  ParallelOptions,
  BraveOptions,
  ExaOptions,
  FirecrawlOptions,
  GoogleOptions,
  JinaOptions,
  Search1apiOptions,
  SearxngOptions,
  SerpapiOptions,
  SerperOptions,
  TavilyOptions,
};
export { createParallel, createBrave, createExa, createFirecrawl, createGoogle, createJina, createSearch1api, createSearxng, createSerpapi, createSerper, createTavily };
