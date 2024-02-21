addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', // 允许的HTTP方法
    'Access-Control-Allow-Headers': 'DNT,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range,Authorization,x-goog-api-client,x-goog-api-key',
    'Access-Control-Max-Age': '86400', // 预检请求结果的缓存时间
};
async function search(query) {
    console.log('search function started with query:', query);

    try {
      const url = "https://search.search2ai.one";
      const headers = {"Content-Type": "application/json"};
      const body = {
        "query": query,
        "search_service": "duckduckgo"
      };
  
      const response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body)
      });
  
      if (response.ok) {
        console.log('search function successfully completed');
        return response.json();
      } else {
        throw new Error("Unable to make request");
      }
    } catch (error) {
      return {"status": "ERROR: " + error.message};
    }
  }
  
async function parse_function_response(message) {
    if (!message[0] || !message[0]["functionCall"]) {
        console.log('Invalid message:', message);
        return { function_name: 'ERROR', function_response: 'Invalid message' };
    }
    const function_call = message[0]["functionCall"];
    const function_name = function_call["name"];

    console.log("Gemini: Called function " + function_name );

    let function_response;
    try {
        const arguments = function_call["args"];

        if (function_name === 'search') {
            // 检查 args 参数是否包含 query 属性
            if (!arguments.hasOwnProperty('query')) {
              function_response = "ERROR: Missing query parameter";
              console.log('Missing query parameter');
              return { function_name, function_response };
            }
          
            // 获取 query 参数的值
            const query = arguments.query;
          
            // 调用 search 函数并获取结果
            function_response = await search(query); 
            return { function_name, function_response }; // 直接返回
        } else {
            function_response = "ERROR: Called unknown function";
            console.log('Called unknown function:', function_name);
        }
    } catch (error) {
        function_response = "ERROR: Invalid arguments";
        console.log('Invalid arguments:', error.message);
    }
    console.log('Function response:', function_response);

    return {function_name, function_response};
}


async function run_conversation(api_key, message) {
    const date = new Date();
    const timeZone = 'Asia/Shanghai';
    const formatter = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeZone });
    const currentDate = formatter.format(date);
    if (!message) {
        console.log('Invalid message:', message);
        return { error: 'Invalid message' };
    }
    const customMessage = [
        {
            "role":"user",
            "parts":[
                {
                    "text": `Today is ${currentDate}.You are a friendly intelligent assistant with the ability to search online, hopefully you will go online when the user asks for something that requires internet access, otherwise just answer, try to be as simple and clear as possible when answering the user's question, and you can use emoji to make your conversations more interesting!`
                }
            ]
        },
        {
            "role": "model",
            "parts":[
                {
                    "text": "okay"
                }
            ]
        },
    ];
    message = [...customMessage, ...message];
    console.log('Running conversation with message:', message);
    const originalMessage = [...message];
    let functionResponseJson;

    const definitions = [
        {
            "name": "search",
            "description": "search on the Interent when the users want something new to know",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The query to search"
                    }
                }
            }
        }
    ];

    const data = {
        "contents": message,
        "tools": [{
            "functionDeclarations": definitions
        }]
    };

    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key="+api_key, {
        method: 'POST',
        body: JSON.stringify(data)
    });

    if (!response.ok) {
        console.log('Received error response from run_conversation');
        // 修改: 返回表示出错的 Response 对象
        return new Response(JSON.stringify({ error: "Error fetching from Google Language API" }), { 
            headers: { ...corsHeaders,'content-type': 'application/json' },
            status: 500 // 代表出现 Internal Server Error 的错误码
        }); 
    }
    console.log('Received successful response from run_conversation');

    let responseJson = await response.json();

    if (!responseJson["candidates"][0]["content"]) {
        console.log("ERROR: No content in response");
        console.log(responseJson);
        return;
    }

    message = responseJson["candidates"][0]["content"]["parts"];

    if (message[0]["functionCall"]) {
        const {function_name, function_response} = await parse_function_response(message);

        const functionResponseData = {
            "contents": [
                
                    ...originalMessage
                    ,
                {
                "role": "model",
                "parts": [
                ...message,]
                },{
                "role": "function",
                "parts": [{
                    "functionResponse": {
                        "name": function_name,
                        "response": {
                            "name": function_name,
                            "content": function_response
                        }
                    }
                }]
            }],
            "tools": [{
                "functionDeclarations": definitions
            }]
        };
        console.log('functionResponseData:', functionResponseData);
        const functionResponse = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key="+api_key, {
            method: 'POST',
            body: JSON.stringify(functionResponseData)
        });

        if (!functionResponse.ok) {
            console.log('Received error response from run_conversation');
            return;
        }

        functionResponseJson = await functionResponse.json();

        if (!functionResponseJson["candidates"][0]["content"]) {
            console.log("ERROR: No content in response");
            console.log(functionResponseJson);
            return new Response(JSON.stringify({ error: "No content received from Google Language API"}), { 
                headers: { ...corsHeaders,'content-type': 'application/json' },
                status: 400 // 代表 Bad Request 的错误码
            });
        }
        } else {
            functionResponseJson = responseJson;
        }
    // 将响应封装成一个 Response 对象，然后返回
    return new Response(JSON.stringify(functionResponseJson), {
        headers: { ...corsHeaders,'content-type': 'application/json' },
        status: 200,
    });
}

// HTTP请求处理主函数
async function handleRequest(request) {
    console.log('[handleRequest] Request received', { method: request.method, url: request.url });

    // 创建一个新的响应对象，并设置 CORS 头部
    if (request.method === 'OPTIONS') {
        console.log('[handleRequest] Preparing CORS preflight response.');
        const response = new Response(null, {
            status: 204, // OPTIONS 请求通常返回 204 No Content
            headers: corsHeaders
        });

        // 输出响应头部
        console.log('[handleRequest] CORS preflight response headers:', JSON.stringify([...response.headers]));
        return response;
    }

    // 解析请求 URL 的路径部分
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.includes('/v1/models/gemini-pro')) {
        console.log('[handleRequest] Handling gemini-pro request.');

        // 提取 API 键和请求内容
        const api_key = request.headers.get('x-goog-api-key');
        let message;
        try {
            const requestBody = await request.text(); // 获取请求文本
            console.log('[handleRequest] Request body:', requestBody);
            message = JSON.parse(requestBody).contents; // 解析 JSON 内容
        } catch (error) {
            console.error('[handleRequest] Error parsing request body:', error.message);
            return new Response(JSON.stringify({ error: 'Bad JSON in request' }), {
                headers: { ...corsHeaders,'content-type': 'application/json' },
                status: 400,
            });
        }

        try {
            // 调用 run_conversation 函数并获取响应
            const response = await run_conversation(api_key, message);

            // 检查响应类型并处理
            if (response instanceof Response) {
                console.log('[handleRequest] run_conversation provided a response object.');
                return response;
            } else {
                console.error('[handleRequest] run_conversation returned an unexpected response type.');
                throw new Error('Invalid response type from run_conversation');
            }
        } catch (error) {
            // 捕获错误并返回错误响应
            console.error('[handleRequest] Error during request handling:', error.message);
            return new Response(JSON.stringify({ error: error.message }), {
                headers: { ...corsHeaders,'content-type': 'application/json' },
                status: 500,
            });
        }
    } else {
        // 处理不符合特定路径的其他请求
        console.log('[handleRequest] Request not found for path:', path);
        return new Response(JSON.stringify({ error: 'Not found' }), {
            headers: { ...corsHeaders,
                'content-type': 'application/json' },
            status: 404,
        });
    }
}
