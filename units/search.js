const fetch = require('node-fetch');
const process = require('process');
const { config } = require('dotenv');
config({ path: __dirname + '/../.env' });

async function search(query) {
    console.log(`正在使用查询进行自定义搜索: ${JSON.stringify(query)}`);
    
    try {
      let results;
      
      switch (process.env.SEARCH_SERVICE) {
        case "search1api":
          const search1apiResponse = await fetch('https://api.search1api.com/search/', {
            method: 'POST',
            headers: {
              "Content-Type": "application/json",
              "Authorization": process.env.SEARCH1API_KEY ? `Bearer ${process.env.SEARCH1API_KEY}` : ''
            },
            body: JSON.stringify({
              query: query,
              max_results: process.env.MAX_RESULTS || "10",
              crawl_results: process.env.CRAWL_RESULTS || "0"
            })
          });
          results = await search1apiResponse.json();
          break;
          
        case "google":
          const googleApiUrl = `https://www.googleapis.com/customsearch/v1?cx=${process.env.GOOGLE_CX}&key=${process.env.GOOGLE_KEY}&q=${encodeURIComponent(query)}`;
          const googleResponse = await fetch(googleApiUrl);
          const googleData = await googleResponse.json();
          results = googleData.items.slice(0, process.env.MAX_RESULTS).map((item) => ({
            title: item.title,
            link: item.link,
            snippet: item.snippet
          }));
          break;
          
        case "bing":
          const bingApiUrl = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}`;
          const bingResponse = await fetch(bingApiUrl, {
            headers: { "Ocp-Apim-Subscription-Key": process.env.BING_KEY }
          });
          const bingData = await bingResponse.json();
          results = bingData.webPages.value.slice(0, process.env.MAX_RESULTS).map((item) => ({
            title: item.name,
            link: item.url,
            snippet: item.snippet
          }));
          break;
          
        case "serpapi":
          const serpApiUrl = `https://serpapi.com/search?api_key=${process.env.SERPAPI_KEY}&engine=google&q=${encodeURIComponent(query)}&google_domain=google.com`;
          const serpApiResponse = await fetch(serpApiUrl);
          const serpApiData = await serpApiResponse.json();
          results = serpApiData.organic_results.slice(0, process.env.MAX_RESULTS).map((item) => ({
            title: item.title,
            link: item.link,
            snippet: item.snippet
          }));
          break;
          
        case "serper":
          const gl = process.env.GL || "us";
          const hl = process.env.HL || "en";
          const serperApiUrl = "https://google.serper.dev/search";
          const serperResponse = await fetch(serperApiUrl, {
            method: "POST",
            headers: {
              "X-API-KEY": process.env.SERPER_KEY,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ q: query, gl: gl, hl: hl })
          });
          const serperData = await serperResponse.json();
          results = serperData.organic.slice(0, process.env.MAX_RESULTS).map((item) => ({
            title: item.title,
            link: item.link,
            snippet: item.snippet
          }));
          break;
          
        case "duckduckgo":
          const duckDuckGoApiUrl = "https://ddg.search2ai.online/search";
          const body = {
            q: query,
            max_results: process.env.MAX_RESULTS || "10"
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
            const searXNGUrl = `${process.env.SEARXNG_BASE_URL}/search?q=${encodeURIComponent(
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
          console.error(`不支持的搜索服务: ${process.env.SEARCH_SERVICE}`);
          return `不支持的搜索服务: ${process.env.SEARCH_SERVICE}`;
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

module.exports = search;