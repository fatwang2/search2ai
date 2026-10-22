[English](README.md) · **简体中文**

# search2ai

**给 AI Agent 和 AI 客户端使用的自托管搜索网关。**

将你配置的搜索与网页抓取服务接入统一接口，通过 **MCP、HTTP API 或 JavaScript / TypeScript 库**调用。后端限流、超时或报错时，按配置顺序自动切换，并返回实际使用的服务与失败原因。

搜索接口返回结构化结果与网页正文，由你的 Agent 或应用决定如何使用。启用可选的**聊天代理**后，也可以让支持工具调用的模型在回答过程中搜索网络。

- **统一结果结构**：`title`、`url`、`snippet`，以及可选的 `date`、`content` 等字段。
- **搜索、新闻、网页正文**：通过 `search`、`news`、`crawl` 调用，能力取决于所选后端。
- **用户选择后端**：按需提供服务地址或凭据；未配置的后端不会自动启用。
- **自动回退与缓存**：按操作设置 fallback 链，支持进程内缓存与 Cloudflare KV 缓存。
- **灵活接入**：本地 MCP、独立 HTTP 服务、项目内调用，以及可挂载的 Hono 路由。
- **已有 API 客户端**：已支持的 Exa、Tavily、Search1API、SearXNG 和 Firecrawl 单页调用可使用独立的 [HTTP API／SDK 兼容入口](#compatibility)。

**想直接使用托管搜索？** [Search1API](https://s1.dev/?utm_source=search2ai) 是本项目配套的托管服务，提供搜索、新闻与网页抓取。可以直接使用它的 API，也可以将它配置为 search2ai 的后端。它也提供[托管的兼容 API](https://s1.dev/compatible-apis)，方便已有集成以较少改动切换。下面的示例使用 Search1API；你也可以选择其他[支持的后端](#providers)。

[项目主页](https://s1.dev/open-source/search2ai) · [快速开始](#quick-start) · [选择接入方式](#usage) · [后端与配置](#providers) · [HTTP API](#api) · [API／SDK 兼容](#compatibility) · [部署](#deployment) · [聊天代理](#chat-proxy) · [升级](#upgrading) · [开发与贡献](#development)

<a id="quick-start"></a>

## 快速开始

本地 CLI 与 npm 包要求 **Node.js ≥ 22.18**。先配置至少一个支持目标操作的后端；当前版本未配置搜索后端时，搜索请求返回 `503`。

在工作目录创建 `.env`，填入搜索服务的密钥：

```dotenv
SEARCH1API_KEY=your_provider_key
```

启动本地 HTTP 服务：

```bash
npx -y search2ai serve --host 127.0.0.1
```

在另一个终端发起搜索：

```bash
curl http://localhost:3014/v1/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"hono cloudflare workers","max_results":3}'
```

响应的 `results` 包含标题、链接和摘要。这一步只调用搜索后端，无需大模型密钥。同一个服务还提供 `/v1/news`、`/v1/crawl` 和远程 MCP 入口 `/mcp`。

CLI 会读取当前目录的 `.env.local` 和 `.env`，优先使用已有的环境变量，其次是 `.env.local`，最后是 `.env`。完整配置模板见 [.env.template](.env.template)。

<a id="usage"></a>

## 选择接入方式

| 你想做什么 | 接入方式 | 谁调用大模型 |
| --- | --- | --- |
| 给 Claude Desktop、Cursor 等 AI 客户端提供搜索工具 | 本地或远程 MCP | AI 客户端 |
| 给自己的 Agent、脚本、后端提供搜索数据 | HTTP API 或代码库 | 你的应用，按需调用 |
| 给支持自定义 API 地址的聊天客户端增加联网能力 | 可选的聊天代理 | search2ai 调用你配置的上游模型 |

### 给 AI 客户端：MCP

对于使用 `mcpServers` 配置格式的客户端，添加：

```json
{
  "mcpServers": {
    "search2ai": {
      "command": "npx",
      "args": ["-y", "search2ai", "mcp"],
      "env": {
        "SEARCH1API_KEY": "your_provider_key"
      }
    }
  }
}
```

客户端在本地启动 search2ai，通过 stdio 使用 `search`、`news`、`crawl` 三个工具。每个工具都需要配置支持对应能力的后端。其他 MCP 客户端可使用相同命令、参数与环境变量，按各自格式接入。

MCP 对各后端使用同一套网关工具，参数与结果结构保持统一。面向各家服务的兼容入口用于已有 HTTP API 和 SDK 集成；MCP 客户端直接使用网关工具。

如果已经部署 HTTP 服务，将支持 Streamable HTTP 的 MCP 客户端连接到 `https://your-search2ai-host/mcp`。配置了 `AUTH_KEYS` 时，还需发送 `Authorization: Bearer <gateway_key>`。

### 给程序：HTTP API

调用独立服务的 `/v1/search`、`/v1/news`、`/v1/crawl`，获取 JSON 数据。完整参数与响应见 [HTTP API](#api)。同一个服务可同时供程序通过 REST 调用、供 AI 客户端通过 MCP 调用。

### 给程序：JavaScript / TypeScript 库

```bash
npm i search2ai
```

```ts
import { createGateway } from 'search2ai/core';

const apiKey = process.env.SEARCH1API_KEY;
if (!apiKey) throw new Error('Set SEARCH1API_KEY before running this example.');

const gateway = createGateway({
  providers: {
    search1api: { apiKey },
  },
});

const { provider, results, warnings } = await gateway.search({
  query: 'hono cloudflare workers',
  max_results: 3,
});

console.log({ provider, results, warnings });
```

也可调用 `gateway.news({ query })` 与 `gateway.crawl({ url })`。库直接在你的进程中运行，无需额外部署搜索网关服务。

`createGateway()` 接收显式配置；也可用 `configFromEnv(env)` 解析配置，或从 `search2ai/hono` 导入 `createGatewayFromEnv(env)`。库入口不会自动读取 `.env` 文件，由你的应用负责加载环境变量。

### 集成到现有 Hono 应用

```ts
import { Hono } from 'hono';
import { createAppFromEnv } from 'search2ai/hono';

const app = new Hono();
app.route('/search', createAppFromEnv(process.env));

export default app;
```

此例挂载 `/search/v1/search`、`/search/v1/news`、`/search/v1/crawl` 与 `/search/mcp` 等路由。环境变量由宿主应用传入；在 Workers 中使用请求处理函数收到的 `env`。

给普通聊天客户端使用时，见[聊天代理](#chat-proxy)。

<a id="providers"></a>

## 后端与配置

### 支持的后端

只配置你要使用的服务。密钥通常由对应服务提供；SearXNG 和自托管 Firecrawl 使用你指定的服务地址，Jina 可显式启用免 key 访问。

| Provider | 搜索 | 新闻 | 正文抓取 | 环境变量 |
| --- | :-: | :-: | :-: | --- |
| `search1api` | ✓ | ✓ | ✓ | `SEARCH1API_KEY`；可选 `SEARCH1API_SERVICE` 指定底层引擎 |
| `tavily` | ✓ | ✓ | ✓ | `TAVILY_KEY` |
| `brave` | ✓ | ✓ | — | `BRAVE_KEY` |
| `exa` | ✓ | ✓ | ✓ | `EXA_KEY` |
| `serper` | ✓ | ✓ | — | `SERPER_KEY` |
| `serpapi` | ✓ | ✓ | — | `SERPAPI_KEY` |
| `google` | ✓ | 日期排序¹ | — | `GOOGLE_KEY` + `GOOGLE_CX` |
| `searxng` | ✓ | ✓ | — | `SEARXNG_BASE_URL`，需开启 JSON 输出 |
| `jina` | — | — | ✓ | `JINA_KEY`，或在 `CRAWL_SERVICE` 中显式列出 `jina` |
| `firecrawl` | — | — | ✓ | `FIRECRAWL_KEY` 或自托管的 `FIRECRAWL_BASE_URL` |
| `parallel` | ✓ | — | 需显式开启 | 免 key；把 `parallel` 写进 `SEARCH_SERVICE`，正文抓取再写进 `CRAWL_SERVICE` |

¹ Google 的 `news` 使用普通搜索的 `sort=date`，并非独立的新闻搜索接口。

以上密钥变量均接受 `*_API_KEY` 别名，例如 `TAVILY_API_KEY`；Google 搜索引擎 ID 也接受 `GOOGLE_CSE_ID`。

### Parallel：免 key，需显式开启

[Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp) 的 Fast 模式提供免费搜索，无需账号或 API key。与 `jina` 一样，它不会自己进链：不写进配置就不会有任何请求发往 Parallel。设 `SEARCH_SERVICE=parallel` 加入搜索链，正文抓取再设 `CRAWL_SERVICE=parallel`。没有配置任何 provider 的安装行为不变，仍然返回 `503`。

库中按普通 provider 传入即可：`createGateway({ providers: { parallel: {} } })` 只做搜索，`{ providers: { parallel: { crawl: true } } }` 同时启用搜索与抓取。

Parallel 返回排序后的摘录，并按 `max_results` 裁剪；实际数量由服务决定。它不支持 `news` 或严格的国家、语言、域名、日期过滤，这些请求会返回 `unsupported` warning/error，请选择支持相应能力的其他 provider。免费服务面向探索和轻量使用，有调用限额；失败沿用现有错误与 warning 机制。

search / crawl 可传入不含个人信息的 UUID `session_id`。同一对话或研究任务中的搜索、抓取、重试、后续调用复用返回的 ID；首次调用失败时也可从库的 `GatewayError.session_id`、REST 的 `error.session_id` 或 MCP 错误的 structured content 取得 ID；新任务或重置时省略或换新 ID。数组查询和 `crawl_results` 共用任务 ID；共享 gateway 的独立调用会生成不同 ID。聊天代理通过 `X-Search2AI-Session-Id` 返回 ID，后续聊天请求可用 `search_session_id` 继续该任务；此字段仅本地使用，不会转发给模型服务。未传入时，每个聊天请求开始新研究任务。库方法第二个参数可传 `{ signal }` 取消调用。

### 配置自动回退

例如，配置 Search1API 和 Tavily，并为不同操作指定顺序：

```dotenv
SEARCH1API_KEY=your_provider_key
TAVILY_KEY=your_backup_provider_key

SEARCH_SERVICE=search1api,tavily
NEWS_SERVICE=tavily,search1api
CRAWL_SERVICE=search1api,jina
```

这个示例还显式启用了 Jina 抓取作为备用。服务的额度、计费与调用限制由对应后端决定。

- 未配置任何链时，按上表顺序选取已配置且支持目标操作的后端。
- `SEARCH_SERVICE` 设置默认链；`NEWS_SERVICE`、`CRAWL_SERVICE` 分别覆盖新闻与抓取顺序。未覆盖的操作会继承 `SEARCH_SERVICE`，并跳过不具备对应能力的后端。
- 每个查询按顺序尝试，第一家成功后返回，不会默认同时查询所有后端。数组中的各个查询并行执行，再合并结果并去重。
- 鉴权失败、限流、HTTP 错误、网络错误与超时触发回退，原因写入 `warnings`。
- 空结果默认也算成功。设置 `FALLBACK_ON_EMPTY=true` 才会继续尝试；所有后端都无结果时，仍可能返回成功的空结果。
- 单次请求可通过非空的 `providers` 数组覆盖顺序，但只能选择已配置的后端。

### 其他配置

| 变量 | 说明 |
| --- | --- |
| `MAX_RESULTS` | 每个查询的默认结果条数，默认 `10`，网关上限 `50` |
| `CRAWL_RESULTS` | 默认对前几条结果补充正文，默认 `0`，上限 `10` |
| `FALLBACK_ON_EMPTY` | 空结果时继续尝试下一家，默认 `false` |
| `PROVIDER_TIMEOUT_MS` | 每次后端尝试的超时，单位毫秒，默认 `15000` |
| `CACHE_TTL` | 搜索与抓取结果缓存秒数，默认 `0`，即关闭 |
| `GL` / `HL` | 支持这些配置的后端使用的国家与语言默认值 |
| `AUTH_KEYS` | 网关访问的 Bearer key，多个用逗号分隔；与搜索服务的密钥分别配置 |
| `PORT` / `HOST` | Node 服务监听端口与地址，默认 `3014` / `0.0.0.0`；CLI 参数 `--port` / `--host` 可覆盖 |

设置 `AUTH_KEYS` 后，搜索 API 和 `/mcp` 需要 `Authorization: Bearer <gateway_key>`；`/`、`/v1/health`、`/openapi.json` 仍公开。未设置时，搜索接口无需鉴权。stdio MCP 使用本地进程配置，不经过 HTTP Bearer 鉴权。

`CACHE_TTL` 大于 `0` 时默认使用进程内缓存。在 Workers 上绑定名为 `CACHE` 的 KV 命名空间后改用 KV，KV 缓存 TTL 至少为 60 秒。库也可注入符合 [`Cache`](src/core/types.ts) 接口的实现。

### 后端能力差异

统一接口统一的是调用形式和结果结构，具体过滤能力、数量与内容质量由适配器和后端决定：

- Google 每个查询最多返回 10 条；Brave、Tavily 的当前适配器最多返回 20 条。其他服务也可能返回少于请求数量的结果。
- 部分后端只使用语言数组中的第一项；部分域名过滤通过 `site:` 搜索操作符实现。
- 时间范围可能近似映射，例如将 `hour` 按天处理。当前显式日期范围由 Tavily、Brave、Exa 适配器传递。
- 当前 Exa 适配器不处理国家或语言过滤；Search1API 适配器不处理国家或显式日期范围。未实现的过滤参数可能被忽略，并不一定触发回退。

如果业务依赖严格过滤，请固定并验证对应后端，避免在具有不同能力的后端之间自动切换。各家映射见 [`src/core/providers/`](src/core/providers)。

<a id="api"></a>

## HTTP API

### 搜索：`POST /v1/search`

这是 search2ai 稳定的统一 HTTP 接口。搜索字段最初参考 Perplexity Search API 并加入网关扩展，不承诺完整 Perplexity 兼容；选择不同后端不会改变其格式。已有 SDK 可使用 v0.3.1 起提供的独立[兼容入口](#compatibility)。

| 字段 | 说明 |
| --- | --- |
| `query` | 必填；字符串或最多 10 个字符串的数组，每项最长 2000 字符 |
| `max_results` | 每个查询的结果条数，`1–50`，默认 `10`；实际数量受后端限制，数组合并后可能超过此值 |
| `country` | 两位国家码，支持情况取决于后端 |
| `search_domain_filter` | 域名数组，最多 20 项 |
| `search_language_filter` | 两位语言码数组，最多 20 项 |
| `search_recency_filter` | `hour` / `day` / `week` / `month` / `year` |
| `search_after_date_filter` / `search_before_date_filter` | `YYYY-MM-DD` 或 `MM/DD/YYYY`；支持情况见后端能力说明 |
| `max_tokens_per_page` | 正文截断的近似 token 预算，按每 token 4 个字符估算，不使用 tokenizer |
| `search_type` | 仅接受 `web`，省略时同样执行网页搜索 |
| `providers` | 本次请求使用的已配置后端及尝试顺序 |
| `crawl_results` | 对前 `0–10` 条结果补充正文到 `content`；默认 `0` |

下面是首家限流、回退到 Tavily 后的响应示例：

```json
{
  "object": "search",
  "id": "9f2c-example",
  "provider": "tavily",
  "results": [
    {
      "title": "Example article",
      "url": "https://example.com/article",
      "snippet": "An excerpt relevant to the query.",
      "date": "2026-09-01"
    }
  ],
  "warnings": [
    {
      "provider": "search1api",
      "code": "rate_limit",
      "message": "search1api: HTTP 429",
      "status": 429
    }
  ]
}
```

`provider` 是实际返回搜索结果的后端；数组查询可能使用不同后端，以逗号分隔。`warnings` 在发生回退或正文补充失败等情况时出现，`cached: true` 表示命中缓存。`date`、`last_updated`、`content` 等字段均为可选，取决于实际返回内容。

设置 `crawl_results` 可能增加后端调用与费用。抓取失败时保留搜索结果并返回 warning；`max_tokens_per_page` 只近似截断正文，不控制摘要或整条响应的长度。

### 新闻与网页正文

- `POST /v1/news`：与搜索相同的参数与响应结构，使用各后端的新闻能力或近似实现，Google 的例外见上表。
- `POST /v1/crawl`：请求为 `{ "url": "https://example.com/article" }`，可附加 `providers` 数组；响应含 `object: "crawl"`、`id`、`provider`、`url`、`content`，以及可选的 `title`、`links`、`warnings`、`cached`。

<a id="compatibility"></a>

### HTTP API 与 SDK 兼容

**v0.3.1 起提供** **SearXNG**、Exa、Tavily、Search1API 与 Firecrawl 单页 scrape 的独立入口。使用 `npm install search2ai@latest` 升级。

这些适配器为已有 API 客户端和 SDK 转换 HTTP 请求参数、鉴权、响应字段及错误格式。MCP 继续使用统一的 `search`、`news`、`crawl` 工具接入各个已配置后端。

| API base | 支持的路由 |
| --- | --- |
| `/compat/searxng` | GET/POST `/`、`/search`，JSON 输出 |
| `/compat/exa` | POST `/search`、`/contents` |
| `/compat/tavily` | POST `/search`、`/extract` |
| `/compat/search1api` | POST `/search`、`/news`、`/crawl` |
| `/compat/firecrawl` | POST `/v2/scrape`、`/v1/scrape`，仅单页 |

在已支持范围内，保留原 SDK 调用与结果解析，只更换 API base 和网关凭据；后端仍由配置的链选择。同协议上游保留原生字段，转换到其他后端时尽量映射参数，无法实现的选项忽略并通过响应 header 提示，没有严格拒绝模式。整站抓取与任务接口不在范围内。

SDK 示例、鉴权、支持字段、错误、限制和已验证客户端版本见[兼容指南](docs/compatibility.zh-CN.md)。SearXNG 使用查询参数或表单，不使用 `/v1/search` 的 JSON 请求结构。

如需免部署的托管兼容接口，可查看 [Search1API 兼容 API](https://s1.dev/compatible-apis)，具体支持范围与迁移方式以其文档为准。

### 服务信息与错误

| 端点 | 说明 |
| --- | --- |
| `GET /` | 版本、已配置后端、各操作的链与可用端点 |
| `GET /v1/health` | 服务状态与相同的配置信息，不会实际探测后端是否可用 |
| `GET /openapi.json` | OpenAPI 3.1 文档 |
| `/mcp` | MCP Streamable HTTP 入口，由 MCP 客户端访问 |

`/v1/*` 的错误格式为 `{ "error": { "message", "type", "code", "warnings?", "issues?" } }`，`code` 为 HTTP 状态码。常见状态：`400` 参数错误、`401` 网关鉴权失败、`502` 所有可用后端都失败、`503` 没有支持该操作的已配置后端。兼容入口使用对应客户端协议的错误结构。

<a id="deployment"></a>

## 部署

### Node.js

可以直接使用快速开始中的 `npx -y search2ai serve`。从源码运行时：

```bash
git clone https://github.com/fatwang2/search2ai.git
cd search2ai
npm ci
cp .env.template .env
```

编辑 `.env` 填入所选后端的配置，然后构建并启动：

```bash
npm run build
npm start
```

生产运行入口为 `dist/cli.js`，默认监听 `0.0.0.0:3014`。开发时使用 `npm run dev`。

### Docker

在仓库根目录准备好 `.env` 后运行：

```bash
docker build -t search2ai .
docker run --rm -p 3014:3014 --env-file .env search2ai
```

容器通过 `--env-file` 接收配置。进程内缓存随容器重启清空。

### Cloudflare Workers

在仓库根目录安装依赖，将所选后端密钥写入 Workers secrets，再部署：

```bash
npm ci
npx wrangler secret put SEARCH1API_KEY
npm run deploy
```

配置见 [wrangler.toml](wrangler.toml)，入口为 [`src/worker.ts`](src/worker.ts)。Workers 通过 `env` 接收变量与绑定；本地 CLI 的 `.env` 文件不会自动变成线上 secrets。需要网关鉴权时也应配置 `AUTH_KEYS`。KV 绑定和 `CACHE_TTL` 的用法见[其他配置](#providers)。

其他 Node 托管平台可以使用相同的构建、启动命令或 Dockerfile。search2ai 需要后端运行环境，`dist` 是服务端代码，不是可直接托管的静态网站。

<a id="chat-proxy"></a>

## 可选：让聊天客户端联网

原有聊天代理功能适用于支持自定义 OpenAI 兼容 API 地址的客户端，例如 NextChat、Cherry Studio、Chatbox。**上游模型必须支持 `tools` / tool calling**，并自行决定是否搜索。

在 `.env` 中同时配置搜索后端、模型上游和网关访问密钥：

```dotenv
SEARCH1API_KEY=your_provider_key
APIBASE=https://api.openai.com/v1
OPENAI_API_KEY=your_model_key
AUTH_KEYS=your_gateway_key
```

运行 `npx -y search2ai serve`，然后在聊天客户端填写：

- API Base URL：`http://localhost:3014/v1`，或你的部署地址加 `/v1`。
- API key：此例中的 `your_gateway_key`。
- 模型：上游服务提供且支持工具调用的模型。

search2ai 向模型提供可用的 `search`、`news`、`crawler` 工具，执行模型请求的搜索或抓取，将结果交回模型生成回答。**这条路径同时使用搜索后端和模型上游，可能产生两类服务的费用。**

- 支持流式回答，包括搜索后的最终回答；普通 REST / MCP 搜索接口仍返回数据，不生成回答。
- `APIBASE` 是上游完整前缀，包含所需版本段；也可设置 `CHAT_PROXY=true` 启用默认上游地址。
- 配置 `AUTH_KEYS` 时，客户端使用网关 key，上游使用 `OPENAI_API_KEY`。未配置 `AUTH_KEYS` 时，请求中的 key 直接作为上游模型 key；单独设置 `OPENAI_API_KEY` 不会替换它。
- Azure 使用 `OPENAI_TYPE=azure`、`RESOURCE_NAME`、`DEPLOY_NAME`、`API_VERSION`、`AZURE_API_KEY`，该模式也会启用代理。
- 合并客户端自带的工具，保留 `temperature`、`response_format` 等参数；客户端工具由客户端处理。可用 `tool_choice: "none"` 禁止模型调用工具。
- 当前最新用户消息的 `content` 为数组时，不注入搜索工具，包括常见的多模态消息格式。
- `/v1/models`、embeddings、audio 等其他 `/v1/*` 路径会转发至模型上游，实际支持情况由上游决定。

<a id="upgrading"></a>

## 从旧版升级

v0.3 将原有聊天代理扩展为可独立使用的搜索网关，保留了常用的模型与搜索环境变量。升级时请核对：

- **启动方式**：npm 包使用 `npx -y search2ai serve`；源码使用 `npm run build && npm start`。
- **Workers 入口**：改用 `src/worker.ts` 与 `wrangler.toml`，旧单文件脚本不再是当前部署入口。
- **模型上游**：确认 `APIBASE` 含完整版本前缀，例如 `/v1`；设置后启用聊天代理，也可使用上述其他启用方式。
- **搜索顺序**：`SEARCH_SERVICE` 支持逗号分隔的回退链；按需单独设置 `NEWS_SERVICE`、`CRAWL_SERVICE`。
- **已移除的后端**：`bing` 与 `duckduckgo` 不再是独立 provider，环境配置链中的这些名称会被跳过；如果链中只剩这些名称，请更换后端。Search1API 的底层引擎选择是另一项配置。

<a id="development"></a>

## 开发与贡献

```bash
npm ci
npm run typecheck
npm test
npm run build
```

本地开发先复制 `.env.template` 为 `.env` 并填写配置，再运行 `npm run dev`。真实服务端到端验证使用 `.env.local.example`：复制为 `.env.local`、填写测试凭据，再运行 `npm run test:e2e`；它会调用真实搜索服务，可选测试模型上游。

主要入口：

- [`src/core/`](src/core)：配置、结果归一化、回退、缓存与后端适配器。
- [`src/server/app.ts`](src/server/app.ts)：HTTP 路由；[`src/mcp/server.ts`](src/mcp/server.ts)：MCP 工具。
- [`src/chat/`](src/chat)：可选聊天代理。
- [`tests/`](tests)：后端字段映射、回退、HTTP、MCP 与聊天代理验证。

欢迎提交 issue 和 PR。新增后端需实现 [`SearchProvider`](src/core/types.ts)，补充 provider 注册、环境配置、公共导出与测试，并说明它实际支持的操作、过滤参数和限制。修改使用方式时，请同步更新中英文 README。

<a id="roadmap"></a>

## 后续方向

当前已有进程内与 Workers KV 缓存、按操作回退链和结果去重。后续关注：

- **客户端 API 兼容**：v0.3.1 已加入首批 SearXNG、Exa、Tavily、Search1API、Firecrawl 单页适配器。后续按实际迁移需求扩展跨后端字段覆盖与客户端验证；调用格式仍与后端路由独立。
- **可靠性与运维**：同一后端多 key 轮换、熔断与健康探测、Redis 缓存集成、用量记录。
- **搜索聚合**：多后端并行搜索与结果合并。

## 交流与支持

欢迎在 X 上关注 [@fatwang2ai](https://x.com/fatwang2ai)，获取项目动态与交流反馈。

[MIT License](LICENSE)
