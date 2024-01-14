const fetch = require('node-fetch');
const search = require('../units/search.js');
const crawer = require('../units/crawer.js');
const { config } = require('dotenv');
config();

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', // 允许的HTTP方法
    'Access-Control-Allow-Headers': 'DNT,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range,Authorization',
    'Access-Control-Max-Age': '86400', // 预检请求结果的缓存时间
};
async function handleRequest(req, res, apiBase, apiKey) {
    let responseSent = false;
    try {
        if (req.method !== 'POST') {
            console.log(`不支持的请求方法: ${req.method}`);
            res.statusCode = 405;
            res.end('Method Not Allowed');
            responseSent = true;
            return;
        }
    const requestData = req.body;
    console.log('请求数据:', requestData);
    console.log('API base:', apiBase);
    const stream = requestData.stream || false;
    const userMessages = requestData.messages.filter(message => message.role === 'user');
    const latestUserMessage = userMessages[userMessages.length - 1];
    const model = requestData.model
    const isContentArray = Array.isArray(latestUserMessage.content);
    const defaultMaxTokens = 3000;
    const maxTokens = requestData.max_tokens || defaultMaxTokens; // 使用默认 max_tokens 如果未提供

    const body = JSON.stringify({
        model: model,
        messages: requestData.messages, 
        max_tokens: maxTokens, 
        ...(isContentArray ? {} : {
            tools: [
                {
                    type: "function",
                    function: {
                        name: "search",
                        description: "search for news and factors",
                        parameters: {
                            type: "object",
                            properties: {
                                query: { type: "string","description": "The query to search."}
                            },
                            required: ["query"]
                        }
                    }
                },
                {
                    type: "function",
                    function: {
                        name: "crawer",
                        description: "Get the content of a specified webpage",
                        parameters: {
                            type: "object",
                            properties: {
                                url: {
                                    type: "string",
                                    description: "The URL of the webpage"},
                            },
                            required: ["url"],
                        }
                    }
                }
            ],
            tool_choice: "auto"
        })
    });
    let openAIResponse;
    try {
        openAIResponse = await fetch(`${apiBase}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: body
        });
    } catch (error) {
        console.error('请求 OpenAI API 时发生错误:', error);
        res.statusCode = 500;
        res.end('OpenAI API 请求失败');
        return { status: 500 };
    }
    if (!openAIResponse.ok) {
        throw new Error('OpenAI API 请求失败');
    }

    let data = await openAIResponse.json();
    console.log('确认解析后的 data 对象:', data);
    if (!data) {
        console.error('OpenAI 响应没有数据');
        res.statusCode = 500;
        res.end('OpenAI 响应没有数据');
        return { status: 500 };
    }
    console.log('OpenAI API 响应接收完成，检查是否需要调用自定义函数');
    let messages = requestData.messages;
    if (!data.choices || data.choices.length === 0 || !data.choices[0].message) {
        console.error('OpenAI 响应数据格式不正确');
        res.statusCode = 500;
        res.end('OpenAI 响应数据格式不正确');
        return { status: 500 };
    }
    
    messages.push(data.choices[0].message);
    console.log('更新后的 messages 数组:', messages);

    // 检查是否有函数调用
    console.log('开始检查是否有函数调用');

    let calledCustomFunction = false;
    if (data.choices[0].message.tool_calls) {

        const toolCalls = data.choices[0].message.tool_calls;
        const availableFunctions = {
            "search": search,
            "crawer": crawer        
        };
        for (const toolCall of toolCalls) {
            const functionName = toolCall.function.name;
            const functionToCall = availableFunctions[functionName];
            const functionArgs = JSON.parse(toolCall.function.arguments);
            let functionResponse;
            try {
                if (functionName === 'search') {
                    functionResponse = await functionToCall(functionArgs.query);
                } else if (functionName === 'crawer') {
                    functionResponse = await functionToCall(functionArgs.url);
                }
                console.log('工具调用的响应: ', functionResponse);
                messages.push({
                    tool_call_id: toolCall.id,
                    role: "tool",
                    name: functionName,
                    content: functionResponse, 
                });
            } catch (error) {
            console.error(`调用工具函数 ${functionName} 时发生错误:`, error);
        }
            if (functionName === "search" || functionName === "crawer") {
                calledCustomFunction = true;
            }
        }
        console.log('处理完自定义函数调用后的 messages 数组:', messages);
        }else {
            console.log('没有发现函数调用');
        }
        console.log('结束检查是否有函数调用');
        const requestBody = {
            model: model,
            messages: messages,
            stream: stream
        };
        try {
            console.log("第二次请求体:", JSON.stringify(requestBody, null, 2));
            let secondResponse = await fetch(`${apiBase}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify(requestBody)
            });
        
            if (!secondResponse.ok) {
                const errorBody = await secondResponse.text(); // 或者 secondResponse.json()，取决于期望的格式
                console.error("Failed OpenAI API request with status:", secondResponse.status, "Response Body:", errorBody);
                throw new Error('OpenAI API 请求失败');
            }
            
        
            if (stream) {
                // 使用 SSE 格式
                if (!responseSent) {
                    res.statusCode = secondResponse.status;
                    res.setHeader('Content-Type', 'text/event-stream');
                    res.end(secondResponse.body);
                    responseSent = true;
                }
            } else {
                // 使用普通 JSON 格式
                const data = await secondResponse.json();
                if (!responseSent) {
                    res.statusCode = secondResponse.status;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify(data));
                    responseSent = true;
                }
            }
        } catch (error) {
            console.error('请求处理时发生错误:', error);
            if (!responseSent) {
                res.statusCode = 500;
                res.end('Internal Server Error');
                responseSent = true;
            }
        }

        if (!calledCustomFunction) {
            // 没有调用自定义函数，直接返回原始回复
            console.log('没有调用自定义函数，返回原始回复');

            if (stream) {
                // 使用 SSE 格式
                console.log('Using SSE format');
                const sseStream = jsonToStream(data);
                res.writeHead(200, { 'Content-Type': 'text/event-stream', ...corsHeaders });
                res.end(sseStream);
            } else {
                // 使用普通 JSON 格式
                console.log('Using JSON format');
                res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
                res.end(JSON.stringify(data));
            }

            console.log('Response sent');
            return { status: 200 };
        }

        // 创建一个将 JSON 数据转换为 SSE 格式的流的函数
        function jsonToStream(jsonData) {
            const encoder = new TextEncoder();

            return new ReadableStream({
                start(controller) {
                    // 将消息内容分割为单个字符
                    const characters = Array.from(jsonData.choices[0].message.content);

                    // 为每个字符创建一个新的 JSON 对象
                    for (let i = 0; i < characters.length; i++) {
                        const character = characters[i];
                        const newJsonData = {
                            id: jsonData.id,
                            object: 'chat.completion.chunk',
                            created: jsonData.created,
                            model: jsonData.model,
                            choices: [
                                {
                                    index: 0,
                                    delta: {
                                        content: character
                                    },
                                    logprobs: null,
                                    finish_reason: i === characters.length - 1 ? 'stop' : null
                                }
                            ],
                            system_fingerprint: jsonData.system_fingerprint
                        };

                        // 将新的 JSON 对象编码为一个新的 SSE 事件，然后加入 StreamReader
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(newJsonData)}\n\n`));
                    }

                    // 添加一个表示结束的 SSE 事件
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                    controller.close();
                }
            });
        }
        if (!responseSent) {
            res.statusCode = 200; // 或其他适当的状态码
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(data)); // 发送处理后的 data
            responseSent = true;
        }

    } catch (error) {
        console.error('请求处理时发生错误:', error);
        if (!responseSent) {
            const statusCode = secondResponse ? secondResponse.status : 500;
            res.statusCode = statusCode;
            res.end('Internal Server Error');
            responseSent = true;
        }
    }    
} 

module.exports = handleRequest;