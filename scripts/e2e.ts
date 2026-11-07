#!/usr/bin/env node
/**
 * 真实上游端到端测试(需要 .env.local 中的真实 key)。
 *
 *   npm run test:e2e
 *
 * 读取的变量:
 *   SEARCH1API_KEY 等任一 provider key   → 测试 /v1/search /v1/news /v1/crawl /mcp
 *   APIBASE + TEST_OPENAI_KEY + TEST_MODEL → 额外测试兼容旧版的聊天代理(非流式 + 流式)
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { createAppFromEnv } from '../src/hono.ts';

for (const file of ['.env.local', '.env']) {
  const p = resolve(process.cwd(), file);
  if (existsSync(p)) process.loadEnvFile(p);
}

const PORT = Number(process.env.E2E_PORT ?? 3099);
const BASE = `http://127.0.0.1:${PORT}`;
const results: Array<{ name: string; ok: boolean; detail: string }> = [];

async function step(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`✓ ${name}  ${detail}`);
  } catch (error) {
    results.push({ name, ok: false, detail: (error as Error).message });
    console.log(`✗ ${name}  ${(error as Error).message}`);
  }
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

async function main(): Promise<void> {
  const app = createAppFromEnv(process.env);
  const server = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' });
  await new Promise((r) => setTimeout(r, 200));

  const info = (await (await fetch(`${BASE}/v1/health`)).json()) as { chains: Record<string, string[]>; endpoints: string[] };
  console.log(`chains: ${JSON.stringify(info.chains)}`);
  console.log(`endpoints: ${info.endpoints.join(' ')}\n`);

  await step('POST /v1/search', async () => {
    const r = await post('/v1/search', { query: 'Node.js latest LTS version', max_results: 3 });
    const d = (await r.json()) as { provider: string; results: Array<{ url: string }>; warnings?: unknown[] };
    if (r.status !== 200) throw new Error(`HTTP ${r.status} ${JSON.stringify(d)}`);
    if (!d.results.length) throw new Error('no results');
    return `provider=${d.provider} results=${d.results.length} first=${d.results[0].url}${d.warnings ? ` warnings=${JSON.stringify(d.warnings)}` : ''}`;
  });

  await step('POST /v1/news', async () => {
    const r = await post('/v1/news', { query: 'artificial intelligence', max_results: 3 });
    const d = (await r.json()) as { provider: string; results: Array<{ url: string; date?: string }> };
    if (r.status !== 200) throw new Error(`HTTP ${r.status} ${JSON.stringify(d)}`);
    return `provider=${d.provider} results=${d.results.length} date=${d.results[0]?.date ?? '-'}`;
  });

  if (info.chains.crawl.length) {
    await step('POST /v1/crawl', async () => {
      const r = await post('/v1/crawl', { url: 'https://s1.dev' });
      const d = (await r.json()) as { provider: string; title?: string; content: string };
      if (r.status !== 200) throw new Error(`HTTP ${r.status} ${JSON.stringify(d)}`);
      return `provider=${d.provider} title=${JSON.stringify(d.title)} content=${d.content.length} chars`;
    });
    await step('POST /v1/search with crawl_results', async () => {
      const r = await post('/v1/search', { query: 'hono web framework', max_results: 2, crawl_results: 1, max_tokens_per_page: 200 });
      const d = (await r.json()) as { results: Array<{ content?: string }> };
      if (r.status !== 200) throw new Error(`HTTP ${r.status} ${JSON.stringify(d)}`);
      return `content[0]=${d.results[0]?.content?.length ?? 0} chars content[1]=${d.results[1]?.content?.length ?? 0}`;
    });
  }

  await step('MCP tools/list + tools/call', async () => {
    const rpc = (id: number, method: string, params: unknown) =>
      fetch(`${BASE}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
    const parse = async (r: Response) => {
      const t = await r.text();
      const line = t.split('\n').find((l) => l.startsWith('data:'));
      return JSON.parse(line ? line.slice(5) : t) as { result: { tools?: Array<{ name: string }>; content?: Array<{ text: string }> } };
    };
    const list = await parse(await rpc(1, 'tools/list', {}));
    const call = await parse(await rpc(2, 'tools/call', { name: 'search', arguments: { query: 'cloudflare workers', max_results: 2 } }));
    const text = call.result.content?.[0]?.text ?? '';
    return `tools=${list.result.tools?.map((t) => t.name).join(',')} call=${text.slice(0, 80)}...`;
  });

  if (process.env.APIBASE && process.env.TEST_OPENAI_KEY && process.env.TEST_MODEL) {
    const auth = { Authorization: `Bearer ${process.env.TEST_OPENAI_KEY}` };
    await step('chat proxy non-stream + search', async () => {
      const r = await post('/v1/chat/completions', { model: process.env.TEST_MODEL, messages: [{ role: 'user', content: '请联网查一下 Node.js 目前最新的 LTS 大版本号是多少，只回答版本号和来源链接。' }] }, auth);
      const d = (await r.json()) as { choices?: Array<{ message: { content: string }; finish_reason: string }>; error?: unknown };
      if (r.status !== 200) throw new Error(`HTTP ${r.status} ${JSON.stringify(d)}`);
      const c = d.choices?.[0];
      return `finish=${c?.finish_reason} content=${JSON.stringify(c?.message.content?.slice(0, 80))}`;
    });
    await step('chat proxy stream (first byte vs total)', async () => {
      const t0 = Date.now();
      const r = await post('/v1/chat/completions', { model: process.env.TEST_MODEL, stream: true, messages: [{ role: 'user', content: '用大约 100 字介绍一下你自己，不需要联网。' }] }, auth);
      if (r.status !== 200) throw new Error(`HTTP ${r.status} ${await r.text()}`);
      const reader = r.body!.getReader();
      let first = -1;
      let text = '';
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (first < 0) first = Date.now() - t0;
        text += dec.decode(value, { stream: true });
      }
      const content = text
        .split('\n\n')
        .filter((e) => e.startsWith('data:') && !e.includes('[DONE]'))
        .map((e) => {
          try {
            return (JSON.parse(e.slice(5)) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content ?? '';
          } catch {
            return '';
          }
        })
        .join('');
      if (!content) throw new Error('no streamed content');
      return `first byte ${first}ms / total ${Date.now() - t0}ms, ${content.length} chars`;
    });
  } else {
    console.log('(skip chat proxy: APIBASE / TEST_OPENAI_KEY / TEST_MODEL not set)');
  }

  server.close();
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
