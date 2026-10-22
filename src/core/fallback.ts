/**
 * fallback 链: 依次尝试 provider, 失败(鉴权 / 限流 / 4xx / 5xx / 网络 / 超时)即切换下一家。
 * 空结果默认视为成功返回; 开启 onEmpty 后空结果也切换: 全部为空时返回最后一家的空结果,
 * 若最后几家出错则返回最先拿到的空结果(有空结果总比报错好)。
 * 所有被跳过的 provider 都记录到 warnings, 由响应带回给调用方。
 */
import { GatewayError, ProviderError, toProviderError } from './errors.ts';
import type { Operation, ProviderContext, ProviderWarning, SearchProvider } from './types.ts';

export interface ChainOptions {
  fetch: typeof fetch;
  timeoutMs: number;
  onEmpty: boolean;
  signal?: AbortSignal;
}

export interface ChainResult<T> {
  value: T;
  provider: string;
  warnings: ProviderWarning[];
}

export async function runChain<T>(
  chain: SearchProvider[],
  op: Operation,
  call: (provider: SearchProvider, ctx: ProviderContext) => Promise<T>,
  isEmpty: (value: T) => boolean,
  opts: ChainOptions
): Promise<ChainResult<T>> {
  const warnings: ProviderWarning[] = [];
  let firstEmpty: { value: T; provider: string } | undefined;

  for (let i = 0; i < chain.length; i++) {
    opts.signal?.throwIfAborted();
    const provider = chain[i];
    const isLast = i === chain.length - 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
      const value = await call(provider, { fetch: opts.fetch, signal });
      opts.signal?.throwIfAborted();
      if (isEmpty(value)) {
        if (!firstEmpty) firstEmpty = { value, provider: provider.name };
        if (opts.onEmpty && !isLast) {
          warnings.push({ provider: provider.name, code: 'empty', message: `${provider.name}: no results` });
          continue;
        }
      }
      return { value, provider: provider.name, warnings };
    } catch (error) {
      opts.signal?.throwIfAborted();
      const pe = error instanceof ProviderError ? error : toProviderError(provider.name, error, controller.signal);
      warnings.push(pe.toWarning());
    } finally {
      clearTimeout(timer);
    }
  }

  if (firstEmpty) return { value: firstEmpty.value, provider: firstEmpty.provider, warnings };
  const names = chain.map((p) => p.name).join(', ');
  throw new GatewayError(502, 'all_providers_failed', `All ${op} providers failed (${names})`, warnings);
}
