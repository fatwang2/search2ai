## 用户交流
[telegram频道 ](https://sum4all.one/telegram)

# 版本更新
- V0.0.9，20230105，支持搜索结果回复URL、支持访问URL
- V0.0.8，20231230，支持接入Serper的Google搜索，注册领取2500次额度，6个月有效
- V0.0.7，20231230，支持接入Serpapi的Google搜索，每个月免费100次，个人够用，注册简单
- V0.0.6，20231229，修复自行部署中变量定义的bug，已测试通过
- V0.0.5，20231229，支持跨域请求，兼容BotGem移动端、ChatGPT-Next-Web等跨域请求的客户端
- V0.0.4，20231220，支持Google、Bing搜索
- V0.0.3，20231220，支持流式输出，适配OpenAI三方客户端
- V0.0.2，20231218，支持OpenAI三方代理，在worker中配置APIBASE的变量为代理地址即可
- V0.0.1，20231218，开源代码，可直接在cloudflare的worker里部署上线

# 产品介绍
- search2ai，支持搜索、联网的 OpenAI，而且是让大模型会根据你的输入判断是否联网，不是每次都联网搜索，不需要安装任何插件，也不需要更换key，直接在你常用的 OpenAI 三方客户端替换自定义域名为下面的地址即可，支持 Cloudflare 自行部署 
- demo站体验地址：[demo站](https://search2ai.online/demo)，根据提示使用你的key，更换自定义域名即可（注意demo站地址不用加v1）

```
https://api.search2ai.online/v1
```
![效果示例](pictures/url.png)

![效果示例](pictures/BotGem.png)

![效果示例](pictures/Lobehub.png)

![效果示例](pictures/Opencat.png)

# 使用方法
- 直接使用：替换客户端自定义域名为上述地址即可，下面是两个例子

![效果示例](pictures/Opencat2.png)
![效果示例](pictures/NextChat.png)

- 自行部署(有难度，需谨慎)
1. 复制[search2ai](https://search2ai.online/cloudflare)的代码，不需要任何修改！在cloudflare的worker里部署，上线后的worker的地址可作为你接口调用时的自定义域名地址，注意拼接，worker地址仅代表v1前的部分 XXX/v1/chat/completions

2. worker中配置变量
- APIBASE：如果你在用 OpenAI 三方代理，可在这里填入，注意不需要加v1，非必填
- SEARCH_SERVICE：暂时支持google、bing、serpapi、serper，必填
- BING_KEY：如选bing搜索必填，请自行搜索教程，申请地址 https://search2ai.online/bing
- GOOGLE_CX：如选Google搜索必填，Search engine ID，请自行搜索教程，申请地址 https://search2ai.online/googlecx
- GOOGLE_KEY：如选Google搜索必填，API key，申请地址 https://search2ai.online/googlekey
- SERPAPI_KEY: 如选serpapi必填，免费100次/月，注册地址 https://search2ai.online/serpapi
- SERPER_KEY: 如选serper必填，6个月免费额度2500次，注意变量名称跟上面不一样，注册地址 https://search2ai.online/serper

3. worker里配置触发器-自定义域名，国内直接访问worker的地址可能会出问题，需要替换为自定义域名

# 后续迭代
- 接口兼容非对话场景，如图片、语音等
- 支持duckduckgo搜索
- 支持Gemini
- 开放自定义prompt
- 提升网页访问的速度

# 特别鸣谢
- [webpilot](https://github.com/webpilot-ai/Webpilot)
- [LobeChat](https://github.com/lobehub/lobe-chat?tab=MIT-1-ov-file)