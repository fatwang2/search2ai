const fetch = require('node-fetch');
const process = require('process');
const { config } = require('dotenv');
config({ path: __dirname + '/../.env' });

async function news(query) {
    console.log(`正在使用查询进行新闻搜索: ${JSON.stringify(query)}`);
    try {
        const response = await fetch('https://crawler.search2ai.one/searchNews', {
            method: 'POST',
            headers: {
                "Content-Type": "application/json",
                "newskey": process.env.NEWS_KEY || ''
            },
            body: JSON.stringify({
                q: query,
                max_results: 10
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
        console.error(`在 news 函数中捕获到错误: ${error}`);
        return `在 news 函数中捕获到错误: ${error}`;
    }
}

module.exports = news;