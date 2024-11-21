(() => {
  // openai.js
  var corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    // 允许的HTTP方法
    "Access-Control-Allow-Headers":
      "DNT,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range,Authorization",
    "Access-Control-Max-Age": "86400",
    // 预检请求结果的缓存时间
  };

  var header_auth = "Authorization"; //azure use "api-key"
  var header_auth_val = "Bearer ";

  // get variables from env
  const api_type = typeof OPENAI_TYPE !== "undefined" ? OPENAI_TYPE : "openai";
  const apiBase =
    typeof APIBASE !== "undefined" ? APIBASE : "https://api.openai.com";
  const resource_name =
    typeof RESOURCE_NAME !== "undefined" ? RESOURCE_NAME : "xxxxx";
  const deployName =
    typeof DEPLOY_NAME !== "undefined" ? DEPLOY_NAME : "gpt-35-turbo";
  const api_ver =
    typeof API_VERSION !== "undefined" ? API_VERSION : "2024-03-01-preview";
  let openai_key = typeof OPENAI_API_KEY !== "undefined" ? OPENAI_API_KEY : "";
  const azure_key = typeof AZURE_API_KEY !== "undefined" ? AZURE_API_KEY : "";
  const auth_keys = typeof AUTH_KEYS !== "undefined" ? AUTH_KEYS : [""];

  let fetchAPI = "";
  let request_header = new Headers({
    "Content-Type": "application/json",
    Authorization: "",
    "api-key": "",
  });

  addEventListener("fetch", (event) => {
    console.log(
      `\u6536\u5230\u8BF7\u6C42: ${event.request.method} ${event.request.url}`
    );
    const url = new URL(event.request.url);
    if (event.request.method === "OPTIONS") {
      return event.respondWith(handleOptions());
    }

    const authHeader = event.request.headers.get("Authorization");
    let apiKey = "";
    if (authHeader) {
      apiKey = authHeader.split(" ")[1];
      if (!auth_keys.includes(apiKey) || !openai_key) {
        openai_key = apiKey;
      }
    } else {
      return event.respondWith(
        new Response("Authorization header is missing", {
          status: 400,
          headers: corsHeaders,
        })
      );
    }

    if (api_type === "azure") {
      fetchAPI = `https://${resource_name}.openai.azure.com/openai/deployments/${deployName}/chat/completions?api-version=${api_ver}`;
      header_auth = "api-key";
      header_auth_val = "";
      apiKey = azure_key;
    } else {
      //openai
      fetchAPI = `${apiBase}/v1/chat/completions`;
      header_auth = "Authorization";
      header_auth_val = "Bearer ";
      apiKey = openai_key;
    }

    if (url.pathname === "/v1/chat/completions") {
      //openai-style request
      console.log("接收到 fetch 事件");
      event.respondWith(handleRequest(event.request, fetchAPI, apiKey));
    } else {
      //other request
      event.respondWith(
        handleOtherRequest(apiBase, apiKey, event.request, url.pathname).then(
          (response) => {
            return new Response(response.body, {
              status: response.status,
              headers: { ...response.headers, ...corsHeaders },
            });
          }
        )
      );
    }
  });
  function handleOptions() {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }
  async function handleOtherRequest(apiBase, apiKey, request, pathname) {
    const headers = new Headers(request.headers);
    headers.delete("Host");
    if (api_type === "azure") {
      headers.set("api-key", `${apiKey}`);
    } else {
      headers.set("Authorization", `Bearer ${apiKey}`);
    }

    const response = await fetch(`${apiBase}${pathname}`, {
      method: request.method,
      headers,
      body: request.body,
    });
    let data;
    if (pathname.startsWith("/v1/audio/")) {
      data = await response.arrayBuffer();
      return new Response(data, {
        status: response.status,
        headers: { "Content-Type": "audio/mpeg", ...corsHeaders },
      });
    } else {
      data = await response.json();
      return new Response(JSON.stringify(data), {
        status: response.status,
        headers: corsHeaders,
      });
    }
  }
  async function search(query) {
    console.log(`正在使用 ${SEARCH_SERVICE} 进行自定义搜索: ${JSON.stringify(query)}`);    
    try {
      let results;
      
      switch (SEARCH_SERVICE) {
        case "search1api":
          const search1apiResponse = await fetch("https://api.search1api.com/search/", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: typeof SEARCH1API_KEY !== "undefined" ? `Bearer ${SEARCH1API_KEY}` : "",
            },
            body: JSON.stringify({
              query,
              max_results: typeof MAX_RESULTS !== "undefined" ? MAX_RESULTS : "5",
              crawl_results: typeof CRAWL_RESULTS !== "undefined" ? CRAWL_RESULTS : "0",
            }),
          });
          results = await search1apiResponse.json();
          break;
          
          case "google":
            const googleApiUrl = `https://www.googleapis.com/customsearch/v1?cx=${GOOGLE_CX}&key=${GOOGLE_KEY}&q=${encodeURIComponent(query)}`;
            const googleResponse = await fetch(googleApiUrl);
            const googleData = await googleResponse.json();
            results = googleData.items.slice(0, MAX_RESULTS).map((item) => ({
              title: item.title,
              link: item.link,
              snippet: item.snippet
            }));
            break;
            
          case "bing":
            const bingApiUrl = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}`;
            const bingResponse = await fetch(bingApiUrl, {
              headers: { "Ocp-Apim-Subscription-Key": BING_KEY }
            });
            const bingData = await bingResponse.json();
            results = bingData.webPages.value.slice(0, MAX_RESULTS).map((item) => ({
              title: item.name,
              link: item.url,
              snippet: item.snippet
            }));
            break;
            
          case "serpapi":
            const serpApiUrl = `https://serpapi.com/search?api_key=${SERPAPI_KEY}&engine=google&q=${encodeURIComponent(query)}&google_domain=google.com`;
            const serpApiResponse = await fetch(serpApiUrl);
            const serpApiData = await serpApiResponse.json();
            results = serpApiData.organic_results.slice(0, MAX_RESULTS).map((item) => ({
              title: item.title,
              link: item.link,
              snippet: item.snippet
            }));
            break;
            
          case "serper":
            const gl = typeof GL !== "undefined" ? GL : "us";
            const hl = typeof HL !== "undefined" ? HL : "en";
            const serperApiUrl = "https://google.serper.dev/search";
            const serperResponse = await fetch(serperApiUrl, {
              method: "POST",
              headers: {
                "X-API-KEY": SERPER_KEY,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({ q: query, gl: gl, hl: hl })
            });
            const serperData = await serperResponse.json();
            results = serperData.organic.slice(0, MAX_RESULTS).map((item) => ({
              title: item.title,
              link: item.link,
              snippet: item.snippet
            }));
            break;
            
          case "duckduckgo":
            const duckDuckGoApiUrl = "https://ddg.search2ai.online/search";
            const body = {
              q: query,
              max_results: typeof MAX_RESULTS !== "undefined" ? MAX_RESULTS : "5"
            };
            const duckDuckGoResponse = await fetch(duckDuckGoApiUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json"
              },
              body: JSON.stringify(body)
            });
            const duckDuckGoData = await duckDuckGoResponse.json();
            results = duckDuckGoData.results.map((item) => ({
              title: item.title,
              link: item.href,
              snippet: item.body
            }));
            break;

            case "searxng":
              const searXNGUrl = `${SEARXNG_BASE_URL}/search?q=${encodeURIComponent(
                    query
                )}&category=general&format=json`;
				      const searXNGResponse = await fetch(searXNGUrl);
              const searXNGData = await searXNGResponse.json();
              results = searXNGData.results.slice(0, MAX_RESULTS).map((item) => ({
                title: item.title,
                link: item.url,
                snippet: item.content
              }));
              break;
          
        default:
          console.error(`不支持的搜索服务: ${SEARCH_SERVICE}`);
          return `不支持的搜索服务: ${SEARCH_SERVICE}`;
      }
      
      const data = {
        results: results
      };
      
      console.log('自定义搜索服务调用完成');
      return JSON.stringify(data);
      
    } catch (error) {
      console.error(`在 search 函数中捕获到错误: ${error}`);
      return `在 search 函数中捕获到错误: ${error}`;
    }
  }
  async function news(query) {
    console.log(`正在使用 ${SEARCH_SERVICE} 进行新闻搜索: ${JSON.stringify(query)}`);
    
    try {
      let results;
      
      switch (SEARCH_SERVICE) {
        case "search1api":
          const search1apiResponse = await fetch("https://api.search1api.com/news", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: typeof SEARCH1API_KEY !== "undefined" ? `Bearer ${SEARCH1API_KEY}` : "",
            },
            body: JSON.stringify({
              query,
              max_results: typeof MAX_RESULTS !== "undefined" ? MAX_RESULTS : "10",
              crawl_results: typeof CRAWL_RESULTS !== "undefined" ? CRAWL_RESULTS : "0",
            }),
          });
          results = await search1apiResponse.json();
          break;
          
        case "google":
          const googleApiUrl = `https://www.googleapis.com/customsearch/v1?cx=${GOOGLE_CX}&key=${GOOGLE_KEY}&q=${encodeURIComponent(query)}&tbm=nws`;
          const googleResponse = await fetch(googleApiUrl);
          const googleData = await googleResponse.json();
          results = googleData.items.slice(0, MAX_RESULTS).map((item) => ({
            title: item.title,
            link: item.link,
            snippet: item.snippet
          }));
          break;
          
        case "bing":
          const bingApiUrl = `https://api.bing.microsoft.com/v7.0/news/search?q=${encodeURIComponent(query)}`;
          const bingResponse = await fetch(bingApiUrl, {
            headers: { "Ocp-Apim-Subscription-Key": BING_KEY }
          });
          const bingData = await bingResponse.json();
          results = bingData.value.slice(0, MAX_RESULTS).map((item) => ({
            title: item.name,
            link: item.url,
            snippet: item.description
          }));
          break;
          
        case "serpapi":
          const serpApiUrl = `https://serpapi.com/search?api_key=${SERPAPI_KEY}&engine=google_news&q=${encodeURIComponent(query)}&google_domain=google.com`;
          const serpApiResponse = await fetch(serpApiUrl);
          const serpApiData = await serpApiResponse.json();
          results = serpApiData.news_results.slice(0, MAX_RESULTS).map((item) => ({
            title: item.title,
            link: item.link,
            snippet: item.snippet
          }));
          break;
          
        case "serper":
          const gl = typeof GL !== "undefined" ? GL : "us";
          const hl = typeof HL !== "undefined" ? HL : "en";
          const serperApiUrl = "https://google.serper.dev/news";
          const serperResponse = await fetch(serperApiUrl, {
            method: "POST",
            headers: {
              "X-API-KEY": SERPER_KEY,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ q: query, gl: gl, hl: hl })
          });
          const serperData = await serperResponse.json();
          results = serperData.news.slice(0, MAX_RESULTS).map((item) => ({
            title: item.title,
            link: item.link,
            snippet: item.snippet
          }));
          break;
          
        case "duckduckgo":
          const duckDuckGoApiUrl = "https://ddg.search2ai.online/searchNews";
          const body = {
            q: query,
            max_results: typeof MAX_RESULTS !== "undefined" ? MAX_RESULTS : "10"
          };
          const duckDuckGoResponse = await fetch(duckDuckGoApiUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
          });
          const duckDuckGoData = await duckDuckGoResponse.json();
          results = duckDuckGoData.results.map((item) => ({
            title: item.title,
            link: item.url,
            snippet: item.body
          }));
          break;
        
          case "searxng":
            const searXNGUrl = `${SEARXNG_BASE_URL}/search?q=${encodeURIComponent(
              query
          )}&category=news&format=json`;
          const searXNGResponse = await fetch(searXNGUrl);
            const searXNGData = await searXNGResponse.json();
            results = searXNGData.results.slice(0, MAX_RESULTS).map((item) => ({
              title: item.title,
              link: item.url,
              snippet: item.content
            }));
            break;
          
        default:
          console.error(`不支持的搜索服务: ${SEARCH_SERVICE}`);
          return `不支持的搜索服务: ${SEARCH_SERVICE}`;
      }
      
      const data = {
        results: results
      };
      
      console.log('新闻搜索服务调用完成');
      return JSON.stringify(data);
      
    } catch (error) {
      console.error(`在 news 函数中捕获到错误: ${error}`);
      return `在 news 函数中捕获到错误: ${error}`;
    }
  }
  async function crawler(url) {
    console.log(
      `\u6B63\u5728\u4F7F\u7528 URL \u8FDB\u884C\u81EA\u5B9A\u4E49\u722C\u53D6:${JSON.stringify(
        url
      )}`
    );
    try {
      const response = await fetch("https://crawl.search1api.com", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url,
        }),
      });
      if (!response.ok) {
        console.error(
          `API \u8BF7\u6C42\u5931\u8D25, \u72B6\u6001\u7801: ${response.status}`
        );
        return `API \u8BF7\u6C42\u5931\u8D25, \u72B6\u6001\u7801: ${response.status}`;
      }
      const contentType = response.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        console.error(
          "\u6536\u5230\u7684\u54CD\u5E94\u4E0D\u662F\u6709\u6548\u7684 JSON \u683C\u5F0F"
        );
        return "\u6536\u5230\u7684\u54CD\u5E94\u4E0D\u662F\u6709\u6548\u7684 JSON \u683C\u5F0F";
      }
      const data = await response.json();
      console.log(
        "\u81EA\u5B9A\u4E49\u722C\u53D6\u670D\u52A1\u8C03\u7528\u5B8C\u6210"
      );
      return JSON.stringify(data);
    } catch (error) {
      console.error(
        `\u5728 crawl \u51FD\u6570\u4E2D\u6355\u83B7\u5230\u9519\u8BEF: ${error}`
      );
      return `\u5728 crawler \u51FD\u6570\u4E2D\u6355\u83B7\u5230\u9519\u8BEF: ${error}`;
    }
  }
  async function handleRequest(request, fetchAPI, apiKey) {
    console.log(
      `\u5F00\u59CB\u5904\u7406\u8BF7\u6C42: ${request.method} ${request.url}`
    );
    if (request.method !== "POST") {
      console.log(
        `\u4E0D\u652F\u6301\u7684\u8BF7\u6C42\u65B9\u6CD5: ${request.method}`
      );
      return new Response("Method Not Allowed", {
        status: 405,
        headers: corsHeaders,
      });
    }

    const requestData = await request.json();
    console.log("\u8BF7\u6C42\u6570\u636E:", requestData);
    const stream = requestData.stream || false;
    const userMessages = requestData.messages.filter(
      (message) => message.role === "user"
    );
    const latestUserMessage = userMessages[userMessages.length - 1];
    const model = requestData.model;
    const isContentArray = Array.isArray(latestUserMessage.content);
    const defaultMaxTokens = 3e3;
    const maxTokens = requestData.max_tokens || defaultMaxTokens;
    const body = JSON.stringify({
      model,
      messages: requestData.messages,
      max_tokens: maxTokens,
      ...(isContentArray
        ? {}
        : {
            tools: [
              {
                type: "function",
                function: {
                  name: "search",
                  description: "search for factors and weathers",
                  parameters: {
                    type: "object",
                    properties: {
                      query: {
                        type: "string",
                        description: "The query to search.",
                      },
                    },
                    required: ["query"],
                  },
                },
              },
              {
                type: "function",
                function: {
                  name: "news",
                  description: "Search for news",
                  parameters: {
                    type: "object",
                    properties: {
                      query: {
                        type: "string",
                        description: "The query to search for news.",
                      },
                    },
                    required: ["query"],
                  },
                },
              },
              {
                type: "function",
                function: {
                  name: "crawler",
                  description: "Get the content of a specified url",
                  parameters: {
                    type: "object",
                    properties: {
                      url: {
                        type: "string",
                        description: "The URL of the webpage",
                      },
                    },
                    required: ["url"],
                  },
                },
              },
            ],
            tool_choice: "auto",
          }),
    });

    request_header.set(`${header_auth}`, `${header_auth_val}${apiKey}`);

    if (stream) {
      const openAIResponse = await fetch(fetchAPI, {
        method: "POST",
        headers: request_header,
        body,
      });
      if (openAIResponse.status !== 200) {
        console.error(
          `OpenAI API \u8BF7\u6C42\u5931\u8D25,\u72B6\u6001\u7801: ${openAIResponse.status}`
        );
        return new Response(
          `OpenAI API \u8BF7\u6C42\u5931\u8D25,\u72B6\u6001\u7801: ${openAIResponse.status}`,
          {
            status: 500,
            headers: corsHeaders,
          }
        );
      }
      const data = await openAIResponse.json();
      console.log(
        "OpenAI API \u54CD\u5E94\u72B6\u6001\u7801:",
        openAIResponse.status
      );
      if (!data.choices || data.choices.length === 0) {
        console.log("\u6570\u636E\u4E2D\u6CA1\u6709\u9009\u62E9\u9879");
        return new Response(
          "\u6570\u636E\u4E2D\u6CA1\u6709\u9009\u62E9\u9879",
          { status: 500 }
        );
      }
      console.log(
        "OpenAI API \u54CD\u5E94\u63A5\u6536\u5B8C\u6210\uFF0C\u68C0\u67E5\u662F\u5426\u9700\u8981\u8C03\u7528\u81EA\u5B9A\u4E49\u51FD\u6570"
      );
      let messages = requestData.messages;
      messages.push(data.choices[0].message);
      let calledCustomFunction = false;
      if (data.choices[0].message.tool_calls) {
        const toolCalls = data.choices[0].message.tool_calls;
        const availableFunctions = {
          search: search,
          news: news,
          crawler: crawler,
        };
        for (const toolCall of toolCalls) {
          const functionName = toolCall.function.name;
          const functionToCall = availableFunctions[functionName];
          const functionArgs = JSON.parse(toolCall.function.arguments);
          let functionResponse;
          if (functionName === "search") {
            functionResponse = await functionToCall(functionArgs.query);
          } else if (functionName === "crawler") {
            functionResponse = await functionToCall(functionArgs.url);
          } else if (functionName === "news") {
            functionResponse = await functionToCall(functionArgs.query);
          }
          messages.push({
            tool_call_id: toolCall.id,
            role: "tool",
            name: functionName,
            content: functionResponse,
          });
          if (
            functionName === "search" ||
            functionName === "crawler" ||
            functionName === "news"
          ) {
            calledCustomFunction = true;
          }
        }
      }
      if (calledCustomFunction) {
        console.log(
          "\u51C6\u5907\u53D1\u9001\u7B2C\u4E8C\u6B21 OpenAI API \u8BF7\u6C42"
        );

        const secondRequestBody = JSON.stringify({
          model,
          messages,
        });

        const secondResponse = await fetch(fetchAPI, {
          method: "POST",
          headers: request_header,
          body: secondRequestBody,
        });

        console.log("Second response status:", secondResponse.status);
        console.log("Second response headers:", secondResponse.headers);
        if (secondResponse.status !== 200) {
          throw new Error(
            `OpenAI API 第二次请求失败,状态码: ${secondResponse.status}`
          );
        }

        const data = await secondResponse.json();
        const content = data.choices[0].message.content;
        const words = content.split(/(\s+)/);

        const stream = new ReadableStream({
          async start(controller) {
            const baseData = {
              id: data.id,
              object: "chat.completion.chunk",
              created: data.created,
              model: data.model,
              system_fingerprint: data.system_fingerprint,
              choices: [
                {
                  index: 0,
                  delta: {},
                  logprobs: null,
                  finish_reason: null,
                },
              ],
              x_groq: {
                id: data.x_groq ? data.x_groq.id : null, 
              },
            };

            for (const word of words) {
              const chunkData = {
                ...baseData,
                choices: [
                  {
                    ...baseData.choices[0],
                    delta: { content: word.includes("\n") ? word : word + " " },
                  },
                ],
              };
              const sseMessage = `data: ${JSON.stringify(chunkData)}\n\n`;
              controller.enqueue(new TextEncoder().encode(sseMessage));
              await new Promise((resolve) => setTimeout(resolve, 5));
            }

            const finalChunkData = {
              ...baseData,
              choices: [
                {
                  ...baseData.choices[0],
                  finish_reason: data.choices[0].finish_reason,
                },
              ],
              x_groq: {
                ...baseData.x_groq,
                usage: data.usage,
              },
            };
            const finalSseMessage = `data: ${JSON.stringify(
              finalChunkData
            )}\n\ndata: [DONE]\n\n`;
            controller.enqueue(new TextEncoder().encode(finalSseMessage));
            controller.close();
          },
        });

        return new Response(stream, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            ...corsHeaders,
          },
        });
      } else {
        const content = data.choices[0].message.content;
        const words = content.split(/(\s+)/);

        const stream = new ReadableStream({
          async start(controller) {
            const baseData = {
              id: data.id,
              object: "chat.completion.chunk",
              created: data.created,
              model: data.model,
              system_fingerprint: data.system_fingerprint,
              choices: [
                {
                  index: 0,
                  delta: {},
                  logprobs: null,
                  finish_reason: null,
                },
              ],
              x_groq: {
                id: data.x_groq ? data.x_groq.id : null, 
              },
            };

            for (const word of words) {
              const chunkData = {
                ...baseData,
                choices: [
                  {
                    ...baseData.choices[0],
                    delta: { content: word.includes("\n") ? word : word + " " },
                  },
                ],
              };
              const sseMessage = `data: ${JSON.stringify(chunkData)}\n\n`;
              controller.enqueue(new TextEncoder().encode(sseMessage));
              await new Promise((resolve) => setTimeout(resolve, 5));
            }

            const finalChunkData = {
              ...baseData,
              choices: [
                {
                  ...baseData.choices[0],
                  finish_reason: data.choices[0].finish_reason,
                },
              ],
              x_groq: {
                ...baseData.x_groq,
                usage: data.usage,
              },
            };
            const finalSseMessage = `data: ${JSON.stringify(
              finalChunkData
            )}\n\ndata: [DONE]\n\n`;
            controller.enqueue(new TextEncoder().encode(finalSseMessage));
            controller.close();
          },
        });

        return new Response(stream, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            ...corsHeaders,
          },
        });
      }
    } else {
      const openAIResponse = await fetch(fetchAPI, {
        method: "POST",
        headers: request_header,
        body,
      });
      if (openAIResponse.status !== 200) {
        console.error(
          `OpenAI API \u8BF7\u6C42\u5931\u8D25,\u72B6\u6001\u7801: ${openAIResponse.status}`
        );
        return new Response(
          `OpenAI API \u8BF7\u6C42\u5931\u8D25,\u72B6\u6001\u7801: ${openAIResponse.status}`,
          {
            status: 500,
            headers: corsHeaders,
          }
        );
      }
      const data = await openAIResponse.json();
      console.log(
        "OpenAI API \u54CD\u5E94\u72B6\u6001\u7801:",
        openAIResponse.status
      );
      if (!data.choices || data.choices.length === 0) {
        console.log("\u6570\u636E\u4E2D\u6CA1\u6709\u9009\u62E9\u9879");
        return new Response(
          "\u6570\u636E\u4E2D\u6CA1\u6709\u9009\u62E9\u9879",
          { status: 500 }
        );
      }
      console.log(
        "OpenAI API \u54CD\u5E94\u63A5\u6536\u5B8C\u6210\uFF0C\u68C0\u67E5\u662F\u5426\u9700\u8981\u8C03\u7528\u81EA\u5B9A\u4E49\u51FD\u6570"
      );
      let messages = requestData.messages;
      messages.push(data.choices[0].message);
      let calledCustomFunction = false;
      if (data.choices[0].message.tool_calls) {
        const toolCalls = data.choices[0].message.tool_calls;
        const availableFunctions = {
          search: search,
          news: news,
          crawler: crawler,
        };
        for (const toolCall of toolCalls) {
          const functionName = toolCall.function.name;
          const functionToCall = availableFunctions[functionName];
          const functionArgs = JSON.parse(toolCall.function.arguments);
          let functionResponse;
          if (functionName === "search") {
            functionResponse = await functionToCall(functionArgs.query);
          } else if (functionName === "crawler") {
            functionResponse = await functionToCall(functionArgs.url);
          } else if (functionName === "news") {
            functionResponse = await functionToCall(functionArgs.query);
          }
          messages.push({
            tool_call_id: toolCall.id,
            role: "tool",
            name: functionName,
            content: functionResponse,
          });
          if (
            functionName === "search" ||
            functionName === "crawler" ||
            functionName === "news"
          ) {
            calledCustomFunction = true;
          }
        }
      }
      if (calledCustomFunction) {
        console.log(
          "\u51C6\u5907\u53D1\u9001\u7B2C\u4E8C\u6B21 OpenAI API \u8BF7\u6C42"
        );

        const requestBody = {
          model,
          messages,
        };
        const secondResponse = await fetch(fetchAPI, {
          method: "POST",
          headers: request_header,
          body: JSON.stringify(requestBody),
        });
        console.log("\u54CD\u5E94\u72B6\u6001\u7801: 200");
        const data2 = await secondResponse.json();
        return new Response(JSON.stringify(data2), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        });
      } else {
        console.log("\u54CD\u5E94\u72B6\u6001\u7801: 200");
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        });
      }
    }
  }
})();
//# sourceMappingURL=openai.js.map
