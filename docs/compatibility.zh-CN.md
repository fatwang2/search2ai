# 客户端 API 兼容

[English](compatibility.md)

**兼容端点从 v0.3.1 起提供，尽力转换行为从 v0.3.2 起生效。** 使用 `npm install search2ai@latest` 升级。

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

客户端协议不决定后端，尝试顺序仍由 `SEARCH_SERVICE`、`NEWS_SERVICE`、`CRAWL_SERVICE` 决定。没有支持所选操作的已配置后端时返回 `503`，不会默认外呼。

- **同协议后端**：链走到对应后端时，保留原生请求、响应和上游实际提供的元数据、分数、费用。网关凭据替换为部署者配置的上游凭据。在下述搜索与单页范围内，原生参数由上游验证。原生 Exa 调用保留 `Exa-Beta` header。
- **其他后端**：尽力转换，能映射的参数映射，未知或无法实现的选项忽略。这些选项不会导致 `422`，也不会使可用后端被跳过；没有严格模式。例如 Tavily 的 `include_domains` 映射到网关域名过滤，所选适配器没有对应能力时忽略 `search_depth=advanced`。
- **失败与回退**：上游失败后按配置顺序继续尝试，原生专属参数也可降级转换。没有回退成功时保留原生错误。成功的空响应默认原样返回，设置 `FALLBACK_ON_EMPTY=true` 后才继续尝试，原生调用同样适用。原生响应不使用归一化结果缓存，转换调用使用核心缓存。
- **范围**：搜索与读取明确指定的页面 URL。递归发现、生成答案、结构化提取、流式输出、浏览器操作与截图选项会被忽略，同协议调用也如此。整站抓取、任务、轮询、取消任务、map、webhook 等路由仍不提供，返回 `404`。

响应 header 说明路由与降级情况，不修改客户端响应结构：

- `X-Search2AI-Mode`：`native` 或 `translated`。
- `X-Search2AI-Provider`：实际使用的后端，包括补充正文的读取后端。
- `X-Search2AI-Skipped`：回退过程中跳过的失败或空结果尝试。
- `X-Search2AI-Ignored`：逗号分隔的被忽略参数名，支持 `contents.highlights` 等嵌套路径。参数名使用百分号编码；最多记录 50 个，每个最多 120 个编码字符，过长名称替换为 `option_name_truncated`。不会写入参数值。
- `X-Search2AI-Warnings`：逗号分隔的降级代码：`result_limit_clamped`（搜索条数限制）、`crawl_limit_clamped`（正文条数限制）、`language_normalized`（语言码归一）、`markdown_fallback`（退回 Markdown）、`content_unavailable`（无正文读取后端）、`content_partial`（部分正文读取失败）。

这些 header 已通过 CORS 暴露。业务依赖特定过滤或功能时可检查它们：忽略过滤可能扩大结果范围，忽略分页可能重复第一页。兼容保证客户端格式转换，不保证所有原厂功能、排名或字段都可获得。

参数本身无效仍返回 `400`，鉴权失败 `401`，没有后端 `503`，原生超时 `504`；其他上游失败为 `502` 或保留原生错误。原生上游仍可能返回自己的参数错误（包括 `422`），网关不会因转换能力不足主动返回 `422`。网关错误按客户端协议封装：Exa `error`/`tag`、Tavily `detail.error`、Search1API `ok: false`/`error`/`message`、Firecrawl `success: false`/`error`、SearXNG `error`。客户端取消会中止调用，不触发回退。

## 跨后端转换

同协议后端可处理范围内的更多原生选项。跨后端实现以下映射；其他选项忽略并通过上述 header 提示。不编造缺失的分数、费用、作者元数据或生成内容。

### SearXNG

- 支持 GET 查询参数、POST `application/x-www-form-urlencoded` 表单，也支持参数在 URL 上且请求体为空的 POST。始终返回 JSON，其他 `format` 会被忽略。
- 支持 `q`、`categories=general|news`、`numResults`（默认 10）、`language`、`time_range`。转换时将 `en-US` 等语言码归一为两位码；语言传给 Search1API、SearXNG、Serper、Brave、Google，其他适配器忽略。语言和时间效果由实际后端决定。
- `pageNumber` 是 `pageno` 别名。转换时忽略非默认分页、`engines`、安全搜索等级和不支持的分类。查询中存在普通关键词时会去掉 SearXNG bang/语言语法标记。原生 SearXNG 保留分页和引擎选择。引擎名不是网关后端选择。
- 转换响应提供 `query`、`results[].title/url/content` 与空的答案、信息卡和建议数组，不编造总数、引擎元数据或分数。原生结果不按网关默认条数裁剪。

使用 SearXNG 后端时，将实例 base 配到 `SEARXNG_BASE_URL`，并在其 `settings.yml` 的 `search.formats` 中启用 `json`。

### Exa

- 搜索映射 `query`、`numResults`（默认 10）、`category=news`、`includeDomains`、`excludeDomains`、`startPublishedDate`、`endPublishedDate`。转换时忽略其他搜索模式和分类。
- `contents=false` 只返回搜索元数据；通过 `contents.text=true` 或 `contents.text.maxCharacters` 请求正文。省略 `contents` 时按已验证 SDK 默认行为尝试补充正文，限制 10,000 字符。缺少读取后端或读取失败时保留搜索结果并提示，不把摘要冒充全文或 highlights。
- Contents 接受 1–10 个明确的 `urls`，可选 `text=true|false` 或 `text.maxCharacters`，逐 URL 失败写入 `statuses`。
- 转换时忽略无法实现的嵌套正文选项、highlights 和 beta 功能。生成摘要、流式和递归 subpage 选项在原生路由上也会忽略。

### Tavily

- 搜索映射 `query`、`max_results`（默认 5）、`topic=general|news`、`include_domains`、`exclude_domains`、`time_range`、`start_date`、`end_date`，以及后端支持时的两位 `country`。
- `include_raw_content=true|markdown|text` 尝试读取所有返回结果的正文。缺失正文为 `null`，通过 warning header 提示，不导致搜索失败。
- Extract 接受一个或最多 10 个明确的 `urls`，输出 Markdown，忽略无法实现的提取深度和格式选项。成功写入 `results`，失败写入 `failed_results`；按该方法约定，HTTP 200 也可能全部是逐 URL 失败。
- 转换时忽略 advanced 搜索、图片、用量等无法实现的选项。生成答案在原生路由上也会忽略。

### Search1API

- 搜索/新闻映射 `query`、`max_results`（默认 5）、`crawl_results`（默认 0，最多 10）、`include_sites`、`exclude_sites`、`language`、`time_range`。
- 正文尽力补充，缺少读取后端或读取失败时提示并保留搜索结果。
- 单页 crawl 接受 `url` 与可选 `enableFallback`，设为 `false` 时只尝试抓取链中的第一家。
- 响应保留 `searchParameters`/`crawlParameters` 与 `results`，包括实际可用的 `link`、`snippet`、`content`、`published_date`。
- 转换时忽略内部引擎选择（`search_service`）、分页、图片和其他无法实现的选项。`search_service` 不覆盖网关后端。搜索/新闻的请求数组仍不属于已支持的请求结构。

### Firecrawl：单页 scrape

- 接受 `url`、Markdown `formats`（默认 `['markdown']`）、SDK 来源标记 `origin`。
- 返回 `success`、`data.markdown`、实际可用的链接及 `data.metadata.title/sourceURL`。
- HTML、raw HTML、links 格式可透传原生 Firecrawl；跨后端不支持的格式退回 Markdown 并提示，不把 Markdown 冒充 HTML。无法实现的单页选项会被忽略。
- 浏览器操作、截图和生成内容格式在原生调用中也会忽略，没有剩余受支持格式时改用 Markdown。独立的 `/crawl`、`/map`、批量及任务路由返回 `404`。

域名包含使用原生字段或 `site:` 操作符，排除使用 `-site:` 操作符。绝对日期过滤映射到 Exa、Tavily、Brave，其他适配器忽略并提示。新鲜度和语言按后端现有能力映射，不承诺精确等价。

明确 URL 列表最多 10 个，转换读取并发为 4，请求体最多 256 KiB，原生响应最多 4 MiB。转换搜索接受正整数条数，超过所选适配器上限时自动限制并提示：Tavily/Brave 为 20、Google 为 10、其他为 50。类型错误、非正数条数及无效 URL 仍会校验失败。

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
