// index.js 示例
const fetch = require('node-fetch');
const handleRequest = require('./search2ai.js');
const process = require('process');
const Stream = require('stream');
const http = require('http');

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', // 允许的HTTP方法
    'Access-Control-Allow-Headers': 'DNT,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range,Authorization',
    'Access-Control-Max-Age': '86400', // 预检请求结果的缓存时间
};

function handleOptions() {
    return {
        status: 204,
        headers: corsHeaders
    };
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
    if (req.method === 'OPTIONS') {
        const optionsResponse = handleOptions();
        res.statusCode = optionsResponse.status;
        Object.entries(optionsResponse.headers).forEach(([key, value]) => {
            res.setHeader(key, value);
        });
        res.end();
        return;
    }
    let apiKey = '';
    if (authHeader) {
        apiKey = authHeader.split(' ')[1]; // 从 Authorization 中获取 API key
    } else {
        res.statusCode = 400;
        res.end('Authorization header is missing');
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
        if (response.body instanceof Stream) {
            console.log('Sending response as a stream'); // 添加的日志
            response.body.pipe(res);
        } else {
            console.log('Sending response as a string or Buffer'); // 添加的日志
            res.end(response.body);
        }
    }
}

// 创建服务器
const server = http.createServer((req, res) => {
    if (req.method === "POST") {
      let body = []; // 使用数组来收集数据块
      req.on("data", chunk => {
        body.push(chunk); // 收集数据块
      });
      req.on("end", () => {
        // 将数据块组合成完整的数据
        const combinedData = Buffer.concat(body);
        // 如果请求是音频，直接使用二进制数据
        if (!req.url.startsWith("/v1/audio/")) {
          try {
            // 尝试解析JSON
            req.body = JSON.parse(combinedData.toString());
          } catch (error) {
            res.statusCode = 400;
            console.error("Invalid JSON:", error);
            res.end("Invalid JSON");
            return;
          }
        } else {
          // 对于音频请求，直接使用二进制数据
          req.body = combinedData;
        }
        processRequest(req, res);
      });
    } else {
      // GET 和其他类型的请求直接处理
      processRequest(req, res);
    }
  });
function processRequest(req, res) {
    (async () => {
        try {
            await module.exports(req, res);
        } catch (err) {
            console.error('处理请求时发生错误:', err);
            res.statusCode = 500;
            res.end('Internal Server Error');
        }
    })();
}

// 在指定的端口上监听请求
const PORT = process.env.PORT || 3014;
server.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});
