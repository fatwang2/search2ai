/**
 * 兼容旧版的聊天代理(保留模式): 向 OpenAI 兼容的 chat/completions 注入 search / news / crawler 三个工具,
 * 拦截模型的 tool_calls, 用网关执行搜索, 再让模型生成最终回答。
 *
 * - 客户端参数(temperature / top_p / response_format / 自带 tools 等)全部透传, 只合并搜索工具。
 * - 流式请求直接以 stream=true 请求上游并逐条解析 SSE: 文本增量原样转发, 网关工具的 tool_calls 被扣下,
 *   执行搜索后发起下一轮, 最终回答仍由上游真流式输出。
 * - 模型若调用了客户端自己定义的工具, 原样交还客户端处理。
 */
import { searchSessionId, type Gateway, type GatewayRunOptions } from '../core/gateway.ts';
import { callChatCompletions, type ChatProxyConfig } from './upstream.ts';

type Json = Record<string, unknown>;

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  index?: number;
}

interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Json };
}

interface ChatMessage extends Json {
  role: string;
  content?: unknown;
  tool_calls?: ToolCall[];
}

export interface ChatResult {
  status: number;
  headers: Record<string, string>;
  body: string | ReadableStream<Uint8Array>;
}

/** 网关能力 → 注入给模型的工具定义(名称沿用 0.2.x, 保持兼容) */
export function gatewayToolDefinitions(gateway: Gateway): ToolDef[] {
  const defs: ToolDef[] = [];
  const query = { type: 'object', properties: { query: { type: 'string', description: '要搜索的查询词' } }, required: ['query'] };
  if (gateway.chain('search').length) defs.push({ type: 'function', function: { name: 'search', description: '搜索网络获取最新信息', parameters: query } });
  if (gateway.chain('news').length) defs.push({ type: 'function', function: { name: 'news', description: '搜索最新新闻', parameters: query } });
  if (gateway.chain('crawl').length) {
    defs.push({
      type: 'function',
      function: {
        name: 'crawler',
        description: '获取指定网址的网页内容',
        parameters: { type: 'object', properties: { url: { type: 'string', description: '要抓取的网页 URL' } }, required: ['url'] },
      },
    });
  }
  return defs;
}

async function executeGatewayTool(gateway: Gateway, name: string, args: Json, sessionId: string, options: GatewayRunOptions): Promise<string> {
  try {
    if (name === 'search' || name === 'news') {
      if (typeof args.query !== 'string') return '无效参数: 缺少 query';
      const r = await gateway[name]({ query: args.query, session_id: sessionId }, options);
      return JSON.stringify({ provider: r.provider, results: r.results });
    }
    if (name === 'crawler') {
      if (typeof args.url !== 'string') return '无效参数: 缺少 url';
      const r = await gateway.crawl({ url: args.url, session_id: sessionId }, options);
      return JSON.stringify({ provider: r.provider, url: r.url, title: r.title, content: r.content });
    }
    return `未知工具: ${name}`;
  } catch (error) {
    // 调用方取消后整轮请求作废, 不能把取消包装成工具结果继续喂给模型。
    if (options.signal?.aborted) throw error;
    return `工具 ${name} 执行失败: ${(error as Error).message ?? String(error)}`;
  }
}

export function createChatProxy(gateway: Gateway, cfg: ChatProxyConfig) {
  const fetchFn: typeof fetch = cfg.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const maxRounds = cfg.maxRounds ?? 8;

  function buildRequestBody(requestData: Json): { body: Json; ownTools: Set<string> } {
    const body: Json = { ...requestData };
    delete body.stream;
    const messages = Array.isArray(requestData.messages) ? (requestData.messages as ChatMessage[]) : [];
    const latestUser = [...messages].reverse().find((m) => m.role === 'user');
    const isContentArray = Array.isArray(latestUser?.content);
    const ownTools = new Set<string>();
    if (!isContentArray) {
      const clientTools = Array.isArray(requestData.tools) ? (requestData.tools as ToolDef[]) : [];
      const clientNames = new Set(clientTools.map((t) => t.function?.name).filter(Boolean));
      const injected = gatewayToolDefinitions(gateway).filter((t) => !clientNames.has(t.function.name));
      injected.forEach((t) => ownTools.add(t.function.name));
      if (clientTools.length + injected.length > 0) {
        body.tools = [...clientTools, ...injected];
        if (!body.tool_choice) body.tool_choice = 'auto';
      }
    }
    return { body, ownTools };
  }

  function roundBody(base: Json, messages: ChatMessage[], round: number): Json {
    const body: Json = { ...base, messages };
    if (!body.tools) return body;
    if (round === maxRounds - 1) body.tool_choice = 'none';
    else if (round > 0 && body.tool_choice !== 'auto' && body.tool_choice !== 'none') body.tool_choice = 'auto';
    return body;
  }

  function splitToolCalls(toolCalls: ToolCall[] | undefined, ownTools: Set<string>): { own: ToolCall[]; client: ToolCall[] } {
    const own: ToolCall[] = [];
    const client: ToolCall[] = [];
    for (const tc of toolCalls ?? []) (ownTools.has(tc.function?.name) ? own : client).push(tc);
    return { own, client };
  }

  async function runOwnTools(messages: ChatMessage[], assistant: ChatMessage, ownCalls: ToolCall[], sessionId: string, options: GatewayRunOptions): Promise<ChatMessage[]> {
    const results = await Promise.all(
      ownCalls.map(async (tc) => {
        let args: Json = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}') as Json;
        } catch {
          args = {};
        }
        const content = await executeGatewayTool(gateway, tc.function.name, args, sessionId, options);
        return { role: 'tool', tool_call_id: tc.id, name: tc.function.name, content } as ChatMessage;
      })
    );
    return [...messages, assistant, ...results];
  }

  const callUpstream = (apiKey: string, body: Json, stream: boolean, signal?: AbortSignal) =>
    callChatCompletions(cfg, fetchFn, apiKey, body, stream, signal);

  // ---------- 非流式 ----------

  async function handleNonStream(apiKey: string, base: Json, ownTools: Set<string>, messages: ChatMessage[], sessionId: string, options: GatewayRunOptions): Promise<Json> {
    let data: Json = {};
    for (let round = 0; round < maxRounds; round++) {
      options.signal?.throwIfAborted();
      data = (await callUpstream(apiKey, roundBody(base, messages, round), false, options.signal)) as Json;
      const message = (data.choices as Array<{ message?: ChatMessage }> | undefined)?.[0]?.message;
      const { own, client } = splitToolCalls(message?.tool_calls, ownTools);
      if (own.length === 0) return data;
      if (client.length > 0) {
        message!.tool_calls = client;
        return data;
      }
      messages = await runOwnTools(messages, message!, own, sessionId, options);
    }
    const message = (data.choices as Array<{ message?: ChatMessage }> | undefined)?.[0]?.message;
    if (message) delete message.tool_calls;
    return data;
  }

  // ---------- 流式 ----------

  async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          yield buf.slice(0, idx);
          buf = buf.slice(idx + 2);
        }
      }
      buf += decoder.decode();
      if (buf.trim()) yield buf;
    } finally {
      reader.releaseLock();
    }
  }

  function parseSseData(rawEvent: string): string | null {
    const parts: string[] = [];
    for (const line of rawEvent.split('\n')) {
      if (line.startsWith('data:')) parts.push(line.slice(5).replace(/^ /, ''));
    }
    return parts.length ? parts.join('\n') : null;
  }

  function accumulateToolCall(acc: Map<number, ToolCall>, tc: Partial<ToolCall>): void {
    let idx = typeof tc.index === 'number' ? tc.index : undefined;
    if (idx === undefined) {
      const found = tc.id ? [...acc.entries()].find(([, v]) => v.id === tc.id) : undefined;
      if (found) idx = found[0];
      else idx = tc.id || acc.size === 0 ? acc.size : acc.size - 1;
    }
    const cur = acc.get(idx) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } };
    if (tc.id) cur.id = tc.id;
    if (tc.function) {
      if (tc.function.name) cur.function.name = tc.function.name;
      if (tc.function.arguments) cur.function.arguments += tc.function.arguments;
    }
    acc.set(idx, cur);
  }

  interface Choice {
    delta?: { content?: unknown; tool_calls?: Array<Partial<ToolCall>> };
    finish_reason?: string | null;
  }

  type RelayResult = { done: true } | { done: false; assistant: ChatMessage; own: ToolCall[] };

  async function relayRound(body: ReadableStream<Uint8Array>, ownTools: Set<string>, write: (s: string) => void): Promise<RelayResult> {
    const acc = new Map<number, ToolCall>();
    const held: Json[] = [];
    let content = '';
    for await (const raw of readSseEvents(body)) {
      const data = parseSseData(raw);
      if (data === null) continue;
      if (data.trim() === '[DONE]') break;
      let evt: Json;
      try {
        evt = JSON.parse(data) as Json;
      } catch {
        write(`${raw}\n\n`);
        continue;
      }
      const choice = (evt.choices as Choice[] | undefined)?.[0];
      const delta = choice?.delta ?? {};
      if (typeof delta.content === 'string') content += delta.content;
      const tcs = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      if (tcs.length > 0 || choice?.finish_reason === 'tool_calls') {
        tcs.forEach((tc) => accumulateToolCall(acc, tc));
        held.push(evt);
        continue;
      }
      if (acc.size > 0 && (!choice || choice.finish_reason)) {
        held.push(evt);
        continue;
      }
      write(`${raw}\n\n`);
    }

    if (acc.size === 0) return { done: true };

    const indexed = [...acc.entries()].sort((a, b) => a[0] - b[0]);
    const stamp = Date.now().toString(36);
    const toolCalls = indexed.map(([idx, tc]) => ({ ...tc, id: tc.id || `call_${stamp}_${idx}` }));
    const { own, client } = splitToolCalls(toolCalls, ownTools);
    if (own.length > 0 && client.length === 0) {
      return { done: false, assistant: { role: 'assistant', content: content || null, tool_calls: own }, own };
    }

    // 客户端工具: 回放扣下的事件, 剔除网关工具的增量并重排 index
    const keep = new Map<number, number>();
    indexed.filter(([, tc]) => !ownTools.has(tc.function.name)).forEach(([idx], i) => keep.set(idx, i));
    for (const evt of held) {
      const choice = (evt.choices as Choice[] | undefined)?.[0];
      if (choice?.delta && Array.isArray(choice.delta.tool_calls)) {
        const kept = choice.delta.tool_calls
          .filter((tc) => typeof tc.index !== 'number' || keep.has(tc.index))
          .map((tc) => (typeof tc.index === 'number' ? { ...tc, index: keep.get(tc.index) } : tc));
        if (kept.length === 0 && !choice.finish_reason) continue;
        choice.delta.tool_calls = kept;
      }
      write(`data: ${JSON.stringify(evt)}\n\n`);
    }
    return { done: true };
  }

  async function pumpStream(
    apiKey: string,
    base: Json,
    ownTools: Set<string>,
    messages: ChatMessage[],
    firstUpstream: Response,
    controller: ReadableStreamDefaultController<Uint8Array>,
    sessionId: string,
    options: GatewayRunOptions
  ): Promise<void> {
    const encoder = new TextEncoder();
    const write = (text: string) => controller.enqueue(encoder.encode(text));
    const close = () => {
      try { controller.close(); } catch { /* 客户端已断开 */ }
    };
    let upstream: Response | null = firstUpstream;
    try {
      for (let round = 0; round < maxRounds; round++) {
        options.signal?.throwIfAborted();
        if (!upstream) upstream = (await callUpstream(apiKey, { ...roundBody(base, messages, round), stream: true }, true, options.signal)) as Response;
        const r = await relayRound(upstream.body!, ownTools, write);
        upstream = null;
        if (r.done) break;
        messages = await runOwnTools(messages, r.assistant, r.own, sessionId, options);
      }
    } catch (error) {
      // 调用方取消后不再续写: 既不发错误事件, 也不再请求模型。
      if (options.signal?.aborted) {
        close();
        return;
      }
      const e = error as { status?: number; message?: string };
      write(`data: ${JSON.stringify({ error: { message: e?.message ?? 'Internal Server Error', type: 'upstream_error', code: e?.status ?? 500 } })}\n\n`);
    }
    write('data: [DONE]\n\n');
    close();
  }

  /** 处理一次 chat/completions 请求; requestKey 已通过 resolveApiKey 解析为上游 key */
  async function handleChat(apiKey: string, requestData: Json, options: GatewayRunOptions = {}): Promise<ChatResult> {
    const rawSession = requestData.search_session_id;
    const sessionId = searchSessionId(rawSession === undefined ? undefined : typeof rawSession === 'string' ? rawSession : 'invalid');
    requestData = { ...requestData };
    delete requestData.search_session_id;
    const { body: base, ownTools } = buildRequestBody(requestData);
    const messages = Array.isArray(requestData.messages) ? ([...(requestData.messages as ChatMessage[])] as ChatMessage[]) : [];

    if (!requestData.stream) {
      const data = await handleNonStream(apiKey, base, ownTools, messages, sessionId, options);
      return { status: 200, headers: { 'Content-Type': 'application/json', 'X-Search2AI-Session-Id': sessionId }, body: JSON.stringify(data) };
    }

    // 首轮在建流之前发起: 上游 4xx/5xx 仍能以 HTTP 状态码返回给客户端
    const first = (await callUpstream(apiKey, { ...roundBody(base, messages, 0), stream: true }, true, options.signal)) as Response;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        void pumpStream(apiKey, base, ownTools, messages, first, controller, sessionId, options);
      },
    });
    return { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Search2AI-Session-Id': sessionId }, body };
  }

  return { handleChat, toolDefinitions: () => gatewayToolDefinitions(gateway) };
}

export type ChatProxy = ReturnType<typeof createChatProxy>;
