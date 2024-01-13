import fetch from 'node-fetch';
import search from '../units/search.js';
import crawer from '../units/crawer.js';
import { config } from 'dotenv';
config();

async function handleRequest(req, apiBase, apiKey) {
    if (req.method !== 'POST') {
        console.log(`不支持的请求方法: ${req.method}`);
        res.status(405).send('Method Not Allowed');
        return;
    }
    const requestData = await req.json();
    console.log('请求数据:', requestData);
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
    const openAIResponse = await fetch(`${apiBase}/v1/chat/completions`, {
        method: 'POST',
        headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}` // 使用从请求的 headers 中获取的 API key
        },
        body: body
    });
    const data = await openAIResponse.json();
    console.log('OpenAI API 响应状态码:', openAIResponse.status);
    if (!data.choices || data.choices.length === 0) {
        console.log('数据中没有选择项');
        res.status(500).send('数据中没有选择项');
        return;
    }

    console.log('OpenAI API 响应接收完成，检查是否需要调用自定义函数');
    let messages = requestData.messages;
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

        const secondResponse = await fetch(`${apiBase}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${apiKey}` // 使用从请求的 headers 中获取的 API key
            },
            body: JSON.stringify(requestBody)
        });
        console.log('响应状态码: 200');
        if (stream) {
            // 使用 SSE 格式
            res.status(secondResponse.status).setHeader('Content-Type', 'text/event-stream').send(secondResponse.body);
        } else {
            // 使用普通 JSON 格式
            const data = await secondResponse.json();
            res.status(200).json(data);
        }
    }
    if (!calledCustomFunction) {
        // 没有调用自定义函数，直接返回原始回复
        console.log('响应状态码: 200');
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

        
        if (stream) {
            // 使用 SSE 格式
            const sseStream = jsonToStream(data);
            return new Response(sseStream,{
                status: 200,
                headers: { 
                    'Content-Type': 'text/event-stream',
                    ...corsHeaders, 
                }
            });
        } else {
            // 使用普通 JSON 格式
            return new Response(JSON.stringify(data), {
                status: 200,
                headers: { 
                    'Content-Type': 'application/json',
                    ...corsHeaders, 
                }
            }); 
        }
    }
    }
export default handleRequest;