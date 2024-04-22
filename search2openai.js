(() => {
  // openai.js
  var corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    // 允许的HTTP方法
    "Access-Control-Allow-Headers": "DNT,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range,Authorization",
    "Access-Control-Max-Age": "86400"
    // 预检请求结果的缓存时间
  };

  var header_auth="Authorization"; //azure use "api-key"
  var header_auth_val="Bearer ";

  // get variables from env
  const api_type = typeof OPENAI_API !== "undefined" ? OPENAI_API : "openai";
  const chat_model = typeof MODEL !== "undefined" ? MODEL : "gpt-3.5-turbo";
  const apiBase = typeof APIBASE !== "undefined" ? APIBASE : "https://api.openai.com";
  const resource_name = typeof RESOURCE_NAME !== "undefined" ? RESOURCE_NAME : "xxxxx";
  const deployName = typeof DEPLOY_NAME !== "undefined" ? DEPLOY_NAME : "gpt-35-turbo";
  const api_ver = typeof API_VERSION !== "undefined" ? API_VERSION : "2024-03-01-preview";
  const openai_key = typeof OPENAI_API_KEY !== "undefined" ? OPENAI_API_KEY : "sk-xxxx";
  const azure_key = typeof AZURE_API_KEY !== "undefined" ? AZURE_API_KEY : "0000";
  const auth_keys = typeof AUTH_KEYS !== "undefined" ? AUTH_KEYS : [""];
  
  let fetchAPI = "";
  let request_header = new Headers({
    "Content-Type": "application/json",
    "Authorization": "",
    "api-key": ""        
  });
  
  addEventListener("fetch", (event) => {     
    console.log(`\u6536\u5230\u8BF7\u6C42: ${event.request.method} ${event.request.url}`);
    const url = new URL(event.request.url);
    if (event.request.method === "OPTIONS") {
      return event.respondWith(handleOptions());
    }

    const authHeader = event.request.headers.get("Authorization");
    let apiKey = "";
    if (authHeader) {
      apiKey = authHeader.split(" ")[1];
      if ( !auth_keys.includes(apiKey) ){
        return event.respondWith(new Response("invaild Auth code", { status: 400, headers: corsHeaders }));
      }
    } else {
      return event.respondWith(new Response("Authorization header is missing", { status: 400, headers: corsHeaders }));
    }

    if ( api_type === "azure" ){
      fetchAPI = `https://${resource_name}.openai.azure.com/openai/deployments/${deployName}/chat/completions?api-version=${api_ver}`;
      header_auth = "api-key";
      header_auth_val = "";
      apiKey = azure_key;       
    }else{ //openai
      fetchAPI = `${apiBase}/v1/chat/completions`;
      header_auth = "Authorization";
      header_auth_val = "Bearer ";
      apiKey = openai_key;
    }    

    if (url.pathname === '/v1/chat/completions') { //openai-style request
      console.log('接收到 fetch 事件');
      event.respondWith(handleRequest(event.request, apiBase, apiKey));
    } else { //other request
      event.respondWith(handleOtherRequest(apiBase, apiKey, event.request, url.pathname).then((response) => {
        return new Response(response.body, {
          status: response.status,
          headers: { ...response.headers, ...corsHeaders }
        });
      }));
    }
  });
  function handleOptions() {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }
  async function handleOtherRequest(apiBase, apiKey, request, pathname) {
    const headers = new Headers(request.headers);
    headers.delete("Host");
    if ( api_type === "azure"){
      headers.set("api-key", `${apiKey}`);
    }else{
      headers.set("Authorization", `Bearer ${apiKey}`);
    }
    
    const response = await fetch(`${apiBase}${pathname}`, {
      method: request.method,
      headers,
      body: request.body
    });
    let data;
    if (pathname.startsWith("/v1/audio/")) {
      data = await response.arrayBuffer();
      return new Response(data, {
        status: response.status,
        headers: { "Content-Type": "audio/mpeg", ...corsHeaders }
      });
    } else {
      data = await response.json();
      return new Response(JSON.stringify(data), {
        status: response.status,
        headers: corsHeaders
      });
    }
  }
  async function search(query) {
    console.log(`正在使用查询进行自定义搜索: ${JSON.stringify(query)}`);
    try {
      const response = await fetch("https://search.search2ai.one", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": typeof SEARCH1API_KEY !== "undefined" ? `Bearer ${SEARCH1API_KEY}` : "",
          "google_cx": typeof GOOGLE_CX !== "undefined" ? GOOGLE_CX : "",
          "google_key": typeof GOOGLE_KEY !== "undefined" ? GOOGLE_KEY : "",
          "serpapi_key": typeof SERPAPI_KEY !== "undefined" ? SERPAPI_KEY : "",
          "serper_key": typeof SERPER_KEY !== "undefined" ? SERPER_KEY : "",
          "bing_key": typeof BING_KEY !== "undefined" ? BING_KEY : "",
          "apibase": typeof APIBASE !== "undefined" ? APIBASE : "https://api.openai.com"
        },
        body: JSON.stringify({
          query,
          search_service: SEARCH_SERVICE,
          max_results: typeof MAX_RESULTS !== "undefined" ? MAX_RESULTS : "5",
          crawl_results:typeof CRAWL_RESULTS !== "undefined" ? MAX_RESULTS : "0",
        })
      });
      if (!response.ok) {
        console.error(`API 请求失败, 状态码: ${response.status}`);
        return `API 请求失败, 状态码: ${response.status}`;
      }
      const contentType = response.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        console.error("收到的响应不是有效的 JSON 格式");
        return "收到的响应不是有效的 JSON 格式";
      }
      const data = await response.json();
      console.log('自定义搜索服务调用完成');
      return JSON.stringify(data);
    } catch (error) {
      console.error(`在 search 函数中捕获到错误: ${error}`);
      return `在 search 函数中捕获到错误: ${error}`;
    }
  }
  async function news(query) {
    console.log(`正在使用查询进行新闻搜索: ${JSON.stringify(query)}`);
    try {
      const response = await fetch("https://search.search2ai.one/news", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": typeof SEARCH1API_KEY !== "undefined" ? `Bearer ${SEARCH1API_KEY}` : "",
          "google_cx": typeof GOOGLE_CX !== "undefined" ? GOOGLE_CX : "",
          "google_key": typeof GOOGLE_KEY !== "undefined" ? GOOGLE_KEY : "",
          "serpapi_key": typeof SERPAPI_KEY !== "undefined" ? SERPAPI_KEY : "",
          "serper_key": typeof SERPER_KEY !== "undefined" ? SERPER_KEY : "",
          "bing_key": typeof BING_KEY !== "undefined" ? BING_KEY : "",
          "apibase": typeof APIBASE !== "undefined" ? APIBASE : "https://api.openai.com"
        },
        body: JSON.stringify({
          query,
          search_service: SEARCH_SERVICE,
          max_results: typeof MAX_RESULTS !== "undefined" ? MAX_RESULTS : "10",
          crawl_results:typeof CRAWL_RESULTS !== "undefined" ? MAX_RESULTS : "0",
        })
      });
      if (!response.ok) {
        console.error(`API 请求失败, 状态码: ${response.status}`);
        return `API 请求失败, 状态码: ${response.status}`;
      }
      const contentType = response.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        console.error("收到的响应不是有效的 JSON 格式");
        return "收到的响应不是有效的 JSON 格式";
      }
      const data = await response.json();
      console.log('新闻搜索服务调用完成');
      return JSON.stringify(data);
    } catch (error) {
      console.error(`\u5728 news \u51FD\u6570\u4E2D\u6355\u83B7\u5230\u9519\u8BEF: ${error}`);
      return `\u5728 news \u51FD\u6570\u4E2D\u6355\u83B7\u5230\u9519\u8BEF: ${error}`;
    }
  }
  async function crawler(url) {
    console.log(`\u6B63\u5728\u4F7F\u7528 URL \u8FDB\u884C\u81EA\u5B9A\u4E49\u722C\u53D6:${JSON.stringify(url)}`);
    try {
      const response = await fetch("https://crawler.search2ai.one", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          url
        })
      });
      if (!response.ok) {
        console.error(`API \u8BF7\u6C42\u5931\u8D25, \u72B6\u6001\u7801: ${response.status}`);
        return `API \u8BF7\u6C42\u5931\u8D25, \u72B6\u6001\u7801: ${response.status}`;
      }
      const contentType = response.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        console.error("\u6536\u5230\u7684\u54CD\u5E94\u4E0D\u662F\u6709\u6548\u7684 JSON \u683C\u5F0F");
        return "\u6536\u5230\u7684\u54CD\u5E94\u4E0D\u662F\u6709\u6548\u7684 JSON \u683C\u5F0F";
      }
      const data = await response.json();
      console.log("\u81EA\u5B9A\u4E49\u722C\u53D6\u670D\u52A1\u8C03\u7528\u5B8C\u6210");
      return JSON.stringify(data);
    } catch (error) {
      console.error(`\u5728 crawl \u51FD\u6570\u4E2D\u6355\u83B7\u5230\u9519\u8BEF: ${error}`);
      return `\u5728 crawler \u51FD\u6570\u4E2D\u6355\u83B7\u5230\u9519\u8BEF: ${error}`;
    }
  }
  async function handleRequest(request, apiBase, apiKey) {

    console.log(`\u5F00\u59CB\u5904\u7406\u8BF7\u6C42: ${request.method} ${request.url}`);
    if (request.method !== "POST") {
      console.log(`\u4E0D\u652F\u6301\u7684\u8BF7\u6C42\u65B9\u6CD5: ${request.method}`);
      return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
    }

    const requestData = await request.json();
    console.log("\u8BF7\u6C42\u6570\u636E:", requestData);
    const stream = requestData.stream || false;
    const userMessages = requestData.messages.filter((message) => message.role === "user");
    const latestUserMessage = userMessages[userMessages.length - 1];
    const model = requestData.model;
    const isContentArray = Array.isArray(latestUserMessage.content);
    const defaultMaxTokens = 3e3;
    const maxTokens = requestData.max_tokens || defaultMaxTokens;
    const body = JSON.stringify({
      model,
      messages: requestData.messages,
      stream,
      max_tokens: maxTokens,
      ...isContentArray ? {} : {
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
                    "description": "The query to search." 
                  }
                },
                required: ["query"]
              }
            }
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
                    description: "The query to search for news." 
                  }
                },
                required: ["query"]
              }
            }
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
                    description: "The URL of the webpage"
                  }
                },
                required: ["url"]
              }
            }
          }
        ],
        tool_choice: "auto"
      }
    });    

    request_header.set(`${header_auth}`, `${header_auth_val} ${apiKey}`);

    if (stream) {   

      const openAIResponse = await fetch(fetchAPI, {
        method: "POST",
        headers: request_header,
        body
      });
      
      let messages = requestData.messages;
      let toolCalls = [];
      let currentToolCall = null;
      let currentArguments = "";
      let responseContent = "";

      // 这里不再直接检查 shouldDirectlyReturn，而是读取流来做判断
      const reader = openAIResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let shouldDirectlyReturn = true; // 默认直接返回

      async function processFirstBlock() {
        const { value, done } = await reader.read();
        if (done) {
          return;
        }
        const block = decoder.decode(value, { stream: true });
        buffer += block;
        if (buffer.includes('"function"')) {
          shouldDirectlyReturn = false;
          console.log("发现 function,将进行特定处理");
        }
      }

      await processFirstBlock();

      if (shouldDirectlyReturn) {
        console.log("直接返回流,因为没有发现 function");
        const remainingStream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(buffer));
            function push() {
              reader.read().then(({ done, value }) => {
                if (done) {
                  console.log("流结束");
                  controller.close();
                  return;
                }
                controller.enqueue(value);
                push();
              });
            }
            push();
          },
        });
        return new Response(remainingStream, {
          headers: {
            "Content-Type": "text/event-stream",
            ...corsHeaders,
          },
        });
      } else {
        console.log("开始处理流数据,因为发现了 function");
        let functionArguments = "";
        const customStream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(buffer));
            function push() {
              reader.read().then(({ done, value }) => {
                if (done) {
                  console.log("Custom function called, processing tool calls");
                  console.log("Function arguments:", functionArguments);
                  controller.close();
                  return;
                }
                const chunk = decoder.decode(value, { stream: true });
                functionArguments += chunk;

                // 检查是否获得完整的 JSON 字符串
                if (functionArguments.startsWith('{"') && functionArguments.endsWith('"}')) {
                  console.log("Custom function called, processing tool calls");
                  console.log("Function arguments:", functionArguments);
                } else {
                  console.log("Incomplete JSON, buffering");
                }

                controller.enqueue(value);
                push();
              });
            }
            push();
          },
        });

        const customReader = customStream.getReader();

        while (true) {
          const { done, value } = await customReader.read();
          if (done) {
            break;
          }

          const chunk = decoder.decode(value);
          buffer += chunk;
          responseContent += chunk;

          let position;
          while ((position = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, position);
            buffer = buffer.slice(position + 1);

            if (line.startsWith('data:')) {
              const data = line.slice(5).trim();
              if (data === '[DONE]') {
                break;
              }

              try {
                const parsed = JSON.parse(data);
                if (parsed.choices && parsed.choices[0].delta.content) {
                  // 将新接收到的内容追加到助手回复的最后一条消息中
                  messages[messages.length - 1].content += parsed.choices[0].delta.content;
                }

                if (parsed.choices && parsed.choices[0].delta.tool_calls) {
                  for (const toolCall of parsed.choices[0].delta.tool_calls) {
                    if (toolCall.function.arguments) {
                      // 累积工具调用的参数
                      currentArguments += toolCall.function.arguments;
                    } else {
                      // 参数累积完成,将当前工具调用添加到工具调用数组中
                      if (currentToolCall) {
                        currentToolCall.function.arguments = currentArguments;
                        toolCalls.push(currentToolCall);
                      }
                      currentToolCall = toolCall;
                      currentArguments = '';
                    }
                  }
                }
              } catch (err) {
                console.error('Error parsing JSON:', err);
                console.error('Invalid JSON string:', data);
                console.log('Incomplete JSON, buffering');
              }
            }
          }
        }
      }

      // 有自定义函数调用,处理工具调用
      console.log('Custom function called, processing tool calls');
      currentToolCall.function.arguments = currentArguments;
      toolCalls.push(currentToolCall);

      // 执行自定义函数调用的逻辑
      const availableFunctions = {
        search: search,
        news: news,
        crawler: crawler,
      };

      let assistantMessage = {
        role: 'assistant',
        content: null,
        tool_calls: [],
      };

      messages.push(assistantMessage);

      for (const toolCall of toolCalls) {
        const functionName = toolCall.function.name;
        const functionToCall = availableFunctions[functionName];
        let functionArgs;
        try {
          // 检查 function.arguments 是否为空
          if (!toolCall.function.arguments) {
            console.error("Function arguments are empty.");
            continue; // 跳过当前工具调用，继续处理下一个
          }
          console.log("Function arguments:", toolCall.function.arguments);
          functionArgs = JSON.parse(toolCall.function.arguments);
        } catch (err) {
          console.error("Error parsing function arguments:", err);
          continue;
        }
        let functionResponse;
        if (functionName === "search" && typeof functionArgs.query === "string") {
          functionResponse = await functionToCall(functionArgs.query);
        } else if (functionName === "crawler" && typeof functionArgs.url === "string") {
          functionResponse = await functionToCall(functionArgs.url);
        } else if (functionName === "news" && typeof functionArgs.query === "string") {
          functionResponse = await functionToCall(functionArgs.query);
        } else {
          console.error("Invalid function arguments for", functionName);
          continue;
        }
        messages.push({
          tool_call_id: toolCall.id,
          role: "tool",
          name: functionName,
          content: functionResponse
        });
        assistantMessage.tool_calls.push({
          id: toolCall.id,
          type: "function",
          function: {
            name: functionName,
            arguments: toolCall.function.arguments
          }
        });
      }
      console.log("Messages before sending second request:", JSON.stringify(messages, null, 2));
      const secondResponse = await fetch(fetchAPI, {
        method: "POST",
        headers: request_header,
        body: JSON.stringify({
          model,
          messages,
          stream: true
        })
      });
      return new Response(secondResponse.body, {
        status: secondResponse.status,
        headers: {
          "Content-Type": "text/event-stream",
          ...corsHeaders
        }
      });
    } else {
      const openAIResponse = await fetch(fetchAPI, {
        method: "POST",
        headers: request_header,
        body
      });
      if (openAIResponse.status !== 200) {
        console.error(`OpenAI API \u8BF7\u6C42\u5931\u8D25,\u72B6\u6001\u7801: ${openAIResponse.status}`);
        return new Response(`OpenAI API \u8BF7\u6C42\u5931\u8D25,\u72B6\u6001\u7801: ${openAIResponse.status}`, {
          status: 500,
          headers: corsHeaders
        });
      }
      const data = await openAIResponse.json();
      console.log("OpenAI API \u54CD\u5E94\u72B6\u6001\u7801:", openAIResponse.status);
      if (!data.choices || data.choices.length === 0) {
        console.log("\u6570\u636E\u4E2D\u6CA1\u6709\u9009\u62E9\u9879");
        return new Response("\u6570\u636E\u4E2D\u6CA1\u6709\u9009\u62E9\u9879", { status: 500 });
      }
      console.log("OpenAI API \u54CD\u5E94\u63A5\u6536\u5B8C\u6210\uFF0C\u68C0\u67E5\u662F\u5426\u9700\u8981\u8C03\u7528\u81EA\u5B9A\u4E49\u51FD\u6570");
      let messages = requestData.messages;
      messages.push(data.choices[0].message);
      let calledCustomFunction = false;
      if (data.choices[0].message.tool_calls) {
        const toolCalls = data.choices[0].message.tool_calls;
        const availableFunctions = {
          "search": search,
          "news": news,
          "crawler": crawler
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
            content: functionResponse
          });
          if (functionName === "search" || functionName === "crawler" || functionName === "news") {
            calledCustomFunction = true;
          }
        }
      }
      if (calledCustomFunction) {
        console.log("\u51C6\u5907\u53D1\u9001\u7B2C\u4E8C\u6B21 OpenAI API \u8BF7\u6C42");
        console.log("Messages before sending second request:", JSON.stringify(messages, null, 2));
        const requestBody = {
          model,
          messages
        };
        const secondResponse = await fetch(fetchAPI, {
          method: "POST",
          headers: request_header,
          body: JSON.stringify(requestBody)
        });
        console.log("\u54CD\u5E94\u72B6\u6001\u7801: 200");
        const data2 = await secondResponse.json();
        return new Response(JSON.stringify(data2), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders
          }
        });
      } else {
        console.log("\u54CD\u5E94\u72B6\u6001\u7801: 200");
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders
          }
        });
      }
    }
  }
})();
//# sourceMappingURL=openai.js.map
