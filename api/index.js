// index.js 示例
import fetch from 'node-fetch';
import search2ai from './search2ai';
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
    const url = new URL(req.url);
    const apiBase = process.env.APIBASE || 'https://api.openai.com';
    const authHeader = req.headers['authorization']; // 从请求的 headers 中获取 Authorization

    let apiKey = '';
    if (authHeader) {
        apiKey = authHeader.split(' ')[1]; // 从 Authorization 中获取 API key
    } else {
        res.status(400).send('Authorization header is missing');
        return;
    }

    if (req.method === 'OPTIONS') {
        const optionsResponse = handleOptions();
        res.status(optionsResponse.status).set(optionsResponse.headers).send();
        return;
    }
    if (url.pathname === '/') {
        res.status(200).send('欢迎体验search2ai，让你的大模型自由联网！');
        return;
    }
    if (url.pathname === '/v1/chat/completions') {
        console.log('接收到 fetch 事件');
        const response = await search2ai.handleRequest(req, apiBase, apiKey);        
        res.status(response.status).set({...response.headers, ...corsHeaders}).send(response.body);
    } else {
        const response = await handleOtherRequest(apiBase, apiKey, req, url.pathname);
        res.status(response.status).set(response.headers).send(response.body);
    }
};

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
        data = await response.buffer();
        return {
            status: response.status,
            headers: { 'Content-Type': 'audio/mpeg', ...corsHeaders },
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
