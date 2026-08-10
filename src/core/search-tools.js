'use strict';
/**
 * 搜索工具唯一实现: search / news / crawler。
 * 支持 search1api(默认推荐)、google、bing、serpapi、serper、searxng。
 * 所有模型适配层共用此模块, 修改一处全局生效。
 */
const { getConfig } = require('./config');

function readSearchConfig() {
  const cfg = getConfig();
  const service = cfg.searchService || 'search1api'; // 默认 search1api(配套搜索服务)
  return { cfg, service };
}

// 统一封装: 请求失败时返回可读错误, 成功时返回 JSON 字符串(与原实现一致)
async function search1apiCall(path, body, key) {
  const url = `https://api.search1api.com${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: key ? `Bearer ${key}` : '',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = `Search1API 请求失败(状态码 ${res.status})。请检查 SEARCH1API_KEY 是否有效；可在 https://www.search1api.com 获取。`;
    return detail;
  }
  return JSON.stringify(await res.json());
}

async function search(query) {
  const { cfg, service } = readSearchConfig();
  const limit = Number(cfg.maxResults) || 5;
  try {
    let results;
    switch (service) {
      case 'search1api': {
        const body = {
          query,
          search_service: 'google',
          max_results: limit,
          crawl_results: Number(cfg.crawlResults) || 0,
        };
        return await search1apiCall('/search/', body, cfg.search1apiKey);
      }
      case 'google': {
        const url = `https://www.googleapis.com/customsearch/v1?cx=${cfg.googleCx}&key=${cfg.googleKey}&q=${encodeURIComponent(query)}`;
        const res = await fetch(url);
        const data = await res.json();
        results = (data.items || []).slice(0, limit).map((i) => ({ title: i.title, link: i.link, snippet: i.snippet }));
        break;
      }
      case 'bing': {
        const url = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}`;
        const res = await fetch(url, { headers: { 'Ocp-Apim-Subscription-Key': cfg.bingKey } });
        const data = await res.json();
        results = (data.webPages?.value || []).slice(0, limit).map((i) => ({ title: i.name, link: i.url, snippet: i.snippet }));
        break;
      }
      case 'serpapi': {
        const url = `https://serpapi.com/search?api_key=${cfg.serpapiKey}&engine=google&q=${encodeURIComponent(query)}&google_domain=google.com`;
        const res = await fetch(url);
        const data = await res.json();
        results = (data.organic_results || []).slice(0, limit).map((i) => ({ title: i.title, link: i.link, snippet: i.snippet }));
        break;
      }
      case 'serper': {
        const res = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: { 'X-API-KEY': cfg.serperKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: query, gl: cfg.gl, hl: cfg.hl }),
        });
        const data = await res.json();
        results = (data.organic || []).slice(0, limit).map((i) => ({ title: i.title, link: i.link, snippet: i.snippet }));
        break;
      }
            case 'talordata': {
            const url = `https://talordata.com{cfg.talordataKey}&q=${encodeURIComponent(query)}`;
            const res = await fetch(url);
            const data = await res.json();
            results = (data.organic_results || []).slice(0, limit).map((i) => ({ title: i.title, link: i.link, snippet: i.snippet }));
            break;
        }
      case 'duckduckgo': {
        // 自托管 DDG 端点(原项目自带, 可能不可用)
        const res = await fetch('https://ddg.search2ai.online/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: query, max_results: limit }),
        });
        const data = await res.json();
        results = (data.results || []).map((i) => ({ title: i.title, link: i.href, snippet: i.body }));
        break;
      }
      case 'searxng': {
        const url = `${cfg.searxngBaseUrl}/search?q=${encodeURIComponent(query)}&category=general&format=json`;
        const res = await fetch(url);
        const data = await res.json();
        results = (data.results || []).slice(0, limit).map((i) => ({ title: i.title, link: i.url, snippet: i.content }));
        break;
      }
      default:
        return `不支持的搜索服务: ${service}`;
    }
    return JSON.stringify({ results });
  } catch (error) {
    console.error('search 函数捕获到错误:', error);
    return `在 search 函数中捕获到错误: ${error}`;
  }
}

async function news(query) {
  const { cfg, service } = readSearchConfig();
  const limit = Number(cfg.maxResults) || 5;
  try {
    let results;
    switch (service) {
      case 'search1api': {
        const body = { query, max_results: limit };
        return await search1apiCall('/news', body, cfg.search1apiKey);
      }
      case 'google': {
        const url = `https://www.googleapis.com/customsearch/v1?cx=${cfg.googleCx}&key=${cfg.googleKey}&q=${encodeURIComponent(query)}`;
        const res = await fetch(url);
        const data = await res.json();
        results = (data.items || []).slice(0, limit).map((i) => ({ title: i.title, link: i.link, snippet: i.snippet }));
        break;
      }
      case 'bing': {
        const url = `https://api.bing.microsoft.com/v7.0/news/search?q=${encodeURIComponent(query)}`;
        const res = await fetch(url, { headers: { 'Ocp-Apim-Subscription-Key': cfg.bingKey } });
        const data = await res.json();
        results = (data.value || []).slice(0, limit).map((i) => ({ title: i.name, link: i.url, snippet: i.description }));
        break;
      }
      case 'serpapi': {
        const url = `https://serpapi.com/search?api_key=${cfg.serpapiKey}&engine=google_news&q=${encodeURIComponent(query)}`;
        const res = await fetch(url);
        const data = await res.json();
        results = (data.news_results || []).slice(0, limit).map((i) => ({ title: i.title, link: i.link, snippet: i.snippet }));
        break;
      }
      case 'serper': {
        const res = await fetch('https://google.serper.dev/news', {
          method: 'POST',
          headers: { 'X-API-KEY': cfg.serperKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: query, gl: cfg.gl, hl: cfg.hl }),
        });
        const data = await res.json();
        results = (data.news || []).slice(0, limit).map((i) => ({ title: i.title, link: i.link, snippet: i.snippet }));
        break;
      }
      case 'searxng': {
        const url = `${cfg.searxngBaseUrl}/search?q=${encodeURIComponent(query)}&category=news&format=json`;
        const res = await fetch(url);
        const data = await res.json();
        results = (data.results || []).slice(0, limit).map((i) => ({ title: i.title, link: i.url, snippet: i.content }));
        break;
      }
      default:
        return `不支持的搜索服务: ${service}`;
    }
    return JSON.stringify({ results });
  } catch (error) {
    console.error('news 函数捕获到错误:', error);
    return `在 news 函数中捕获到错误: ${error}`;
  }
}

async function crawler(url) {
  const { cfg } = readSearchConfig();
  try {
    const res = await fetch('https://crawl.search1api.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      return `爬取请求失败, 状态码: ${res.status}`;
    }
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return '收到的响应不是有效的 JSON 格式';
    }
    return JSON.stringify(await res.json());
  } catch (error) {
    console.error('crawler 函数捕获到错误:', error);
    return `在 crawler 函数中捕获到错误: ${error}`;
  }
}

const tools = {
  search: { name: 'search', description: '搜索网络获取最新信息', execute: search },
  news: { name: 'news', description: '搜索最新新闻', execute: news },
  crawler: { name: 'crawler', description: '获取指定网址的网页内容', execute: crawler },
};

// 供注入到模型请求的 tool 定义(OpenAI 格式)
function getToolDefinitions() {
  return Object.values(tools).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties:
          t.name === 'crawler'
            ? { url: { type: 'string', description: '要抓取的网页 URL' } }
            : { query: { type: 'string', description: '要搜索的查询词' } },
        required: [t.name === 'crawler' ? 'url' : 'query'],
      },
    },
  }));
}

// 执行工具调用, 返回函数响应字符串
async function executeToolCall(name, args) {
  const t = tools[name];
  if (!t) return `未知工具: ${name}`;
  if (name === 'crawler') {
    if (typeof args.url !== 'string') return '无效参数: 缺少 url';
    return await t.execute(args.url);
  }
  if (typeof args.query !== 'string') return '无效参数: 缺少 query';
  return await t.execute(args.query);
}

module.exports = { search, news, crawler, getToolDefinitions, executeToolCall };
