# 客户端 API 兼容

[English](compatibility.md)

**v0.3.1 起提供。** 使用 `npm install search2ai@latest` 升级。

在下述已支持的方法和参数范围内，保留原 SDK 与业务调用，只调整服务地址和网关凭据。兼容不代表搜索排名相同、所有原厂功能可用，或支持任意版本的 SDK。

本指南说明 HTTP API 与 SDK 兼容。MCP 客户端使用 search2ai 自己的 `search`、`news`、`crawl` 工具，参数和结果保持统一，与所选后端独立。HTTP 适配器不会为各家服务增加不同的 MCP 工具格式。

## 服务地址与路由

将 `https://gateway.example.com` 替换为部署地址；若挂载在其他路径下，也要包含该路径前缀。

| 客户端协议 | API base | 客户端追加的路由 | 网关鉴权 |
| --- | --- | --- | --- |
| SearXNG | `/compat/searxng` | `/` 或 `/search`，GET 或 POST | 配置 `AUTH_KEYS` 时使用 Bearer header |
| Exa | `/compat/exa` | `POST /search`、`POST /contents` | `x-api-key` 或 Bearer |
| Tavily | `/compat/tavily` | `POST /search`、`POST /extract` | Bearer；也接受旧版 body `api_key` |
| Search1API | `/compat/search1api` | `POST /search`、`POST /news`、`POST /crawl` | Bearer |
| Firecrawl | `/compat/firecrawl` | `POST /v2/scrape`、`POST /v1/scrape` | Bearer |

客户端填写 `AUTH_KEYS` 中的网关 key，上游 key 保留在部署配置中。兼容入口的 key 区分大小写；同一请求携带冲突凭据时拒绝访问。未配置 `AUTH_KEYS` 时，与现有网关端点一样不鉴权。

除非客户端要求填写完整端点，否则不要在 SDK 的 base 后额外添加 `/search` 或 `/v2`，本文验证过的 SDK 会自行追加。SearXNG 客户端各不相同：有的接受实例 base，有的要求完整搜索 URL。固定原厂域名或无法添加鉴权 header 的客户端，需要相应客户端配置或反向代理，网关无法改变其写死的地址。

## 后端路由与范围

客户端协议不决定后端，尝试顺序仍由 `SEARCH_SERVICE`、`NEWS_SERVICE`、`CRAWL_SERVICE` 决定。没有已配置后端时返回 `503`，不会默认外呼。

- **同协议后端**：链走到对应后端时，保留原生请求、响应和上游实际返回的元数据、分数、费用。网关凭据替换为部署者配置的上游凭据。在下述单页范围与限制内，原生参数由上游验证。原生 Exa 调用保留 `Exa-Beta` header。
- **其他后端**：只转换下述已支持子集。无法满足选项时跳过该后端，不发起请求；链中后续同协议后端仍可处理原生选项。如果都无法处理，返回 `422`。
- **失败与回退**：只有下一家能够满足请求时才回退。没有回退成功时保留原生错误。成功的空响应默认原样返回，设置 `FALLBACK_ON_EMPTY=true` 后才继续尝试，此策略也适用于原生调用。原生响应不使用归一化结果缓存，转换后的调用使用核心缓存。
- **范围**：搜索与读取明确指定的页面 URL。不包含链接递归发现、整站 crawl、抓取任务、轮询、取消任务端点、webhook、截图、浏览器操作、生成答案或结构化提取。

响应 header `X-Search2AI-Mode` 为 `native` 或 `translated`；`X-Search2AI-Provider` 列出实际使用的后端，搜索正文补充可能另用抓取后端；`X-Search2AI-Skipped` 列出跳过的尝试。这些信息不加入原厂响应结构。

原生调用保留上游错误状态与内容。网关自身错误按客户端协议封装：Exa `error`/`tag`、Tavily `detail.error`、Search1API `ok: false`/`error`/`message`、Firecrawl `success: false`/`error`、SearXNG `error`。参数错误为 `400`、鉴权失败 `401`、无法转换 `422`、未配置后端 `503`、原生超时 `504`；其他上游失败可能为 `502` 或保留的原生错误。客户端取消会中止后端调用，不会触发回退。

## 跨后端转换支持范围

以下说明的是**跨后端转换**，同协议后端可在本次范围内处理更多原生选项。未知参数或无法满足的有效选项会报错，不会静默丢弃；明确关闭功能的常见空值和默认值可被接受。

### SearXNG：重点兼容对象

- 仅 JSON 输出，传 `format=json` 或省略；不提供 HTML 界面、CSV 或 RSS。
- 支持 GET 查询参数、POST `application/x-www-form-urlencoded` 表单，也支持参数在 URL 上且请求体为空的 POST。
- 支持 `q`、`categories=general|news`、第一页，以及两位 `language` 语言码。语言过滤需要 Search1API 或 SearXNG 后端。
- 接受 LangChain JS 的 `numResults`（1–50）、`pageNumber`（作为 `pageno` 别名）、`imageProxy=true` 和 `safesearch=0`。转换查询按 `numResults` 限制条数，客户端也可裁剪列表；`imageProxy` 不影响 JSON 网页结果。
- SearXNG bang/语言查询语法、第二页及之后、非空 `engines`、`time_range`、安全搜索等级 1/2 需要原生 SearXNG 后端。`google` 等引擎名指 SearXNG 内部引擎，不是网关后端。无法分页时会明确报错，不重复返回第一页。
- 转换响应包含 `query`、`results[].title/url/content` 与空的答案、信息卡和建议数组，不编造总结果数、引擎名或分数。原生响应保留元数据与分页字段，不按网关默认值裁剪成 10 条。

使用 SearXNG 后端时，把实例 base 配到 `SEARXNG_BASE_URL`，并在其 `settings.yml` 的 `search.formats` 中启用 `json`。

### Exa

- 搜索：`query`、`numResults`（1–50，默认 10）、`type=auto`，可选 `category=news`。
- `contents=false` 只返回搜索元数据；正文支持 `contents.text=true` 或 `contents.text.maxCharacters`。省略 `contents` 时遵循已验证 SDK 的默认行为：读取正文并截到 10,000 字符，需要配置抓取后端，会增加页面读取。
- Contents：1–10 个明确的 `urls`，可选 `text=true` 或 `text.maxCharacters`，逐 URL 失败写入 `statuses`。
- highlights、域名/日期过滤、其他搜索模式、beta 选项与摘要需要对应原生上游，或不在本次范围内。普通摘要不会冒充 Exa highlights。即使配置 Exa，递归 subpage 抓取仍会拒绝。
- 转换结果提供 `id`、`url`、`title` 及实际可用的 `text`/`publishedDate`，不编造分数、作者元数据或 `costDollars`。

### Tavily

- 搜索：`query`、`max_results`（1–20，默认 5）、`topic=general|news`，可选 `include_raw_content=true|markdown`。要求原文时，读取每条返回结果，需要抓取后端。
- Extract：一个或最多 10 个明确的 `urls`，basic 深度、Markdown 输出。成功写入 `results`，失败写入 `failed_results`；按该方法约定，HTTP 200 也可能全部是逐 URL 失败。
- advanced 搜索/提取、过滤和 HTML 输出需要对应原生上游，生成答案不在范围内。转换结果不提供无法获得的分数与用量；业务依赖这些值时，需要真正提供它们的后端。

### Search1API

- 搜索/新闻：`query`、`max_results`（1–50，默认 5）、`crawl_results`（0–10，默认 0）。要求正文时必须实际读取，不会仅返回 warning 并声称请求成功。
- 单页 crawl：`url`，可选 `enableFallback`，设为 `false` 时只尝试抓取链中的第一家。
- 响应保留 `searchParameters`/`crawlParameters` 与 `results`，包括 `link`、`snippet`、`content` 及实际可用的 `published_date`。
- 非空 `search_service`、第二页及之后、语言/时间/域名过滤和图片需要原生 Search1API。`search_service` 是其内部引擎选择，不是网关后端覆盖。搜索/新闻请求数组及其他 Search1API 方法不在首批覆盖范围内。

### Firecrawl：仅单页 scrape

- 支持 `url`、Markdown `formats`（默认 `['markdown']`）、SDK 来源标记 `origin`。
- 返回 `success`、`data.markdown`，以及实际可用的 `data.metadata.title/sourceURL`。
- 显式正文过滤、HTML、链接和其他单页选项需要原生 Firecrawl。即使配置 Firecrawl，也拒绝浏览器操作、截图和生成内容的输出格式。
- 不提供 `/crawl`、`/map`、批量任务或任务管理端点。这些路径返回 `404`，不会被误当作单页读取执行。

明确 URL 列表最多 10 个，转换读取并发为 4，请求体最多 256 KiB，原生上游响应最多 4 MiB。搜索条数也受实际后端约束，例如转换到 Tavily/Brave 时最多 20，Google 最多 10；请配置能满足条数要求的后端，不会静默截成另一种上限。

## 原有 SDK 使用示例

客户端使用网关 key 和服务 base，上游凭据在网关部署侧配置；所选方法需要对应的搜索、新闻或抓取后端。

```ts
import Exa from 'exa-js';

const exa = new Exa(process.env.GATEWAY_KEY, 'https://gateway.example.com/compat/exa');
const search = await exa.search('AI agent frameworks');
const pages = await exa.getContents(['https://example.com/article'], { text: true });
```

```ts
import { tavily } from '@tavily/core';

const client = tavily({
  apiKey: process.env.GATEWAY_KEY,
  apiBaseURL: 'https://gateway.example.com/compat/tavily',
});
const search = await client.search('AI agent frameworks');
const pages = await client.extract(['https://example.com/article']);
```

```ts
import { Search1API } from '@search1api/client';

const client = new Search1API({
  apiKey: process.env.GATEWAY_KEY,
  baseUrl: 'https://gateway.example.com/compat/search1api',
});
const search = await client.search('AI agent frameworks');
const news = await client.news('AI agents');
const page = await client.crawl('https://example.com/article');
```

```ts
import Firecrawl from '@mendable/firecrawl-js';

const client = new Firecrawl({
  apiKey: process.env.GATEWAY_KEY,
  apiUrl: 'https://gateway.example.com/compat/firecrawl',
});
const page = await client.scrape('https://example.com/article', { formats: ['markdown'] });
```

```ts
import { SearxngSearch } from '@langchain/community/tools/searxng_search';

const search = new SearxngSearch({
  apiBase: 'https://gateway.example.com/compat/searxng',
  headers: { Authorization: `Bearer ${process.env.GATEWAY_KEY}` },
});
const result = await search.invoke('AI agent frameworks');
```

## 验证

已验证 `exa-js@2.26.0`、`@tavily/core@0.7.14`、`@search1api/client@0.4.0`、`@mendable/firecrawl-js@4.50.1`，以及通过 `@langchain/community@1.1.29`、`@langchain/core@1.1.38` 接入的 SearXNG。这是实测版本记录，不承诺所有历史或未来版本。

SDK 冒烟检查通过带路径前缀的真实本地 HTTP 服务调用原 SDK 方法，验证原生与转换模式下的路由、鉴权及结果解析。上游使用模拟响应，不需要付费 key，也不代表已验证真实上游可用性或搜索质量。SDK 包与运行时依赖隔离：

```bash
npm ci
npm install --prefix tests/sdk --ignore-scripts --legacy-peer-deps --no-package-lock
npm run test:sdk
```

`--legacy-peer-deps` 避免无关的可选 LangChain 集成解析到冲突的 peer 版本；本测试明确固定了与 SearXNG 工具匹配的 core 版本。LangChain 包当前有弃用提示，这里用于验证已有集成，不作为新应用的依赖推荐。

主检查为 `npm run typecheck`、`npm test` 和 `npm run build`。
