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
    if (req.method !== 'POST') {
        console.log(`不支持的请求方法: ${req.method}`);
        res.statusCode = 405;
        res.end('Method Not Allowed');
        return { status: 405 };
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
    console.log('请求体:', body);
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
    
    if (!openAIResponse || !openAIResponse.ok) {
        console.error('无效的 OpenAI 响应:', openAIResponse);
        res.statusCode = 500;
        res.end('OpenAI API 请求失败');
        return { status: 500 };
    }
    
    let data;
    try {
        data = await openAIResponse.json();
        console.log('解析后的数据:', data);

    } catch (error) {
        console.error('解析 OpenAI 响应时发生错误:', error);
        res.statusCode = 500;
        res.end('解析 OpenAI 响应失败');
        return { status: 500 };
    }
    
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
    
    // 检查是否有函数调用
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
            if (functionName === "search" || functionName === "crawer") {
                calledCustomFunction = true;
            }
        }
        console.log('准备发送第二次 OpenAI API 请求');
        const requestBody = {
            model: model,
            messages: messages,
            stream: stream
        };

        let secondResponse;
        try {
            secondResponse = await fetch(`${apiBase}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify(requestBody)
            });
        } catch (error) {
            console.error('在尝试获取 secondResponse 时发生错误:', error);
            res.statusCode = 500;
            res.end('第二次 OpenAI API 请求失败');
            return { status: 500 };
        }
        
        if (!secondResponse || !secondResponse.ok) {
            console.error('无效的 secondResponse:', secondResponse);
            res.statusCode = 500;
            res.end('第二次 OpenAI API 请求失败');
            return { status: 500 };
        }
        
        const secondData = await secondResponse.json().catch(error => {
            console.error('解析 secondResponse 时发生错误:', error);
            res.statusCode = 500;
            res.end('解析 secondResponse 失败');
            return null;
        });
        
        if (!secondData) {
            return { status: 500 };
        }
        

        // 现在你可以安全地访问 secondResponse.status，因为如果 fetch 失败，你的代码将不会到达这里
        console.log('响应状态码:', secondResponse.status);
        if (calledCustomFunction) {
            if (secondResponse) {
                if (typeof secondResponse !== 'undefined') {
                    if (stream) {
                        // 使用 SSE 格式
                        res.statusCode = secondResponse.status;
                        res.setHeader('Content-Type', 'text/event-stream');
                        res.end(secondResponse.body);
                    } else {
                        // 使用普通 JSON 格式
                        const data = await secondResponse.json();
                        res.statusCode = 200;
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify(data));
                    }
                } else {
                    console.error('secondResponse is undefined');
                }
            }
            return { status: res.statusCode };
        }

        if (!calledCustomFunction) {
            // 没有调用自定义函数，直接返回原始回复
            console.log('响应状态码: 200');

            // 设置响应头
            res.statusCode = 200;
            Object.entries(corsHeaders).forEach(([key, value]) => {
                res.setHeader(key, value);
            });

            if (stream) {
                // 使用 SSE 格式
                res.setHeader('Content-Type', 'text/event-stream');
                res.end(jsonToStream(data));
            } else {
                // 使用普通 JSON 格式
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(data));
            }

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
    }
    }
    module.exports = handleRequest;