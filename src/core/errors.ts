import type { ProviderErrorCode, ProviderWarning } from './types.ts';

/** 单个 provider 调用失败; fallback 链据此决定是否切换到下一家 */
export class ProviderError extends Error {
  readonly provider: string;
  readonly code: ProviderErrorCode;
  readonly status?: number;

  constructor(provider: string, code: ProviderErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.code = code;
    this.status = status;
  }

  toWarning(): ProviderWarning {
    const w: ProviderWarning = { provider: this.provider, code: this.code, message: this.message };
    if (this.status !== undefined) w.status = this.status;
    return w;
  }
}

/** 网关层错误, 直接映射为 HTTP 状态码 */
export class GatewayError extends Error {
  /** Research-run identity, retained on failures so callers can retry the same run. */
  session_id?: string;
  readonly status: number;
  readonly code: string;
  readonly warnings: ProviderWarning[];

  constructor(status: number, code: string, message: string, warnings: ProviderWarning[] = []) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.code = code;
    this.warnings = warnings;
  }
}

export function codeFromStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 400 && status < 500) return 'bad_request';
  return 'upstream';
}

/** 把任意异常归一为 ProviderError(超时 / 网络 / 未知) */
export function toProviderError(provider: string, error: unknown, signal?: AbortSignal): ProviderError {
  if (error instanceof ProviderError) return error;
  const name = (error as { name?: string } | null)?.name;
  const message = (error as { message?: string } | null)?.message ?? String(error);
  if (signal?.aborted || name === 'AbortError' || name === 'TimeoutError') {
    return new ProviderError(provider, 'timeout', `${provider}: request timed out`);
  }
  return new ProviderError(provider, 'network', `${provider}: ${message}`);
}
