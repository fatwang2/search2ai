// index.js 示例
const fetch = require('node-fetch');
const handleRequest = require('./search2ai.js');
const process = require('process');
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', // 允许的HTTP方法
    'Access-Control-Allow-Headers': 'DNT,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range,Authorization',
    'Access-Control-Max-Age': '86400', // 预检请求结果的缓存时间
};

// 处理 OPTIONS 请求
function handleOptions() {
    return {
        status: 204,
        headers: corsHeaders
    };
}

// 主处理函数
module.exports = async (req, res) => {
    console.log(`收到请求: ${req.method} ${req.url}`);
    if (req.url === '/') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html');
        res.end('<html><head><meta charset="UTF-8"></head><body><h1>欢迎体验search2ai，让你的大模型自由联网！</h1></body></html>');
        return;
    }
    const apiBase = process.env.APIBASE || 'https://api.openai.com';
    const authHeader = req.headers['authorization']; // 从请求的 headers 中获取 Authorization

    let apiKey = '';
    if (authHeader) {
        apiKey = authHeader.split(' ')[1]; // 从 Authorization 中获取 API key
    } else {
        res.statusCode = 400;
        res.end('Authorization header is missing');
        return;
    }

    if (req.method === 'OPTIONS') {
        const optionsResponse = handleOptions();
        res.statusCode = optionsResponse.status;
        Object.entries(optionsResponse.headers).forEach(([key, value]) => {
            res.setHeader(key, value);
        });
        res.end();
        return;
    }

    let response;
    try {
        if (req.url === '/v1/chat/completions') {
            console.log('接收到 fetch 事件');
            response = await handleRequest(req, res, apiBase, apiKey);
        } else {
            response = await handleOtherRequest(apiBase, apiKey, req, req.url);
        }
    } catch (error) {
        console.error('请求处理时发生错误:', error);
        response = { status: 500, body: 'Internal Server Error' };
    }
    
    if (!res.headersSent) {
        res.statusCode = response.status;
        Object.entries({...response.headers, ...corsHeaders}).forEach(([key, value]) => {
            res.setHeader(key, value);
        });
        res.end(response.body);
    }
    

async function handleOtherRequest(apiBase, apiKey, req, pathname) {
    // 创建一个新的 Headers 对象，复制原始请求的所有头部，但不包括 Host 头部
    const headers = {...req.headers};
    delete headers['host'];
    headers['authorization'] = `Bearer ${apiKey}`;

    // 对所有请求，直接转发
    const response = await fetch(`${apiBase}${pathname}`, {
        method: req.method,
        headers: headers,
        body: req.body
    });

    let data;
    if (pathname.startsWith('/v1/audio/')) {
        // 如果路径以 '/v1/audio/' 开头，处理音频文件
        const arrayBuffer = await response.arrayBuffer();
        data = Buffer.from(arrayBuffer);        
        return {
            status: response.status,
            headers: { ...response.headers, 'Content-Type': 'audio/mpeg', ...corsHeaders },
            body: data
        };
    } else {
        // 对于其他路径，处理 JSON 数据
        data = await response.json();
        return {
            status: response.status,
            headers: corsHeaders,
            body: JSON.stringify(data)
        };
    }
}
}