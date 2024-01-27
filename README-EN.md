[简体中文](README.md) · **English** 

## User Communication
[Telegram Channel](https://sum4all.one/telegram)

## Buy me a coffee
<a href="https://www.buymeacoffee.com/fatwang2" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

# Version Updates
- V0.1.4, 20240120, Supports one-click deployment with Zeabur, very convenient, highly recommended!
- V0.1.3, 20240120, Supports local deployment, can be deployed on your own server
- V0.1.2, 20240115, Fixes streaming output issues in non-search scenarios for the cloudflare worker version
- V0.1.1, 20240114, Supports one-click deployment with Vercel, currently suitable for those who like tinkering

For more historical updates, please see [Version History](https://github.com/fatwang2/search2ai/releases)

# Product Introduction
- search2ai, supports search and networking for OpenAI, and the large model will decide whether to connect to the network based on your input, not every time. No plugins needed, no need to change the key, just replace the custom address in your commonly used OpenAI third-party client, also supports self-deployment, and will not affect other features of using OpenAI, like drawing, voice, etc.

<table>
    <tr>
        <td><img src="pictures/url.png" alt="Effect Example"></td>
        <td><img src="pictures/BotGem.png" alt="Effect Example"></td>
    </tr>
    <tr>
        <td><img src="pictures/Lobehub.png" alt="Effect Example"></td>
        <td><img src="pictures/Opencat.png" alt="Effect Example"></td>
    </tr>
</table>


# How to Use
**Direct use: Replace the custom domain in the client with the following address**
```
https://api.search2ai.online
```
As shown in the picture
<table>
    <tr>
        <td><img src="pictures/Opencat2.png" alt="Effect Example"></td>
        <td><img src="pictures/NextChat.png" alt="Effect Example"></td>
    </tr>
</table>

Demo site experience address: [Demo Site](https://search2ai.online/demo), follow the instructions to use your key, replace the custom domain

**One-Click Deployment with Zeabur (Highly Recommended)**

Click the button for one-click deployment, default duckduckgo search, can be switched on your own

[![Deploy on Zeabur](https://zeabur.com/button.svg)](https://zeabur.com/templates/A4HGYF?referralCode=fatwang2)

To keep the project updated, it is recommended to fork this repository first, then deploy your branch through Zeabur

[![Deployed on Zeabur](https://zeabur.com/deployed-on-zeabur-dark.svg)](https://zeabur.com?referralCode=fatwang2&utm_source=fatwang2&utm_campaign=oss)

**Local Deployment**
1. Clone the repository locally
```
git clone https://github.com/fatwang2/search2ai
```
2. Copy .env.template as .env, configure environment variables
- SEARCH_SERVICE: Currently supports google, bing, serpapi, serper, duckduckgo (recommended), required
- APIBASE: If you are using an OpenAI third-party proxy, you can fill it in here, note that v1 is not needed, not required
- BING_KEY: Required if choosing bing search, please search for tutorials, application address https://search2ai.online/bing
- GOOGLE_CX: Required if choosing Google search, Search engine ID, please search for tutorials, application address https://search2ai.online/googlecx
- GOOGLE_KEY: Required if choosing Google search, API key, application address https://search2ai.online/googlekey
- SERPAPI_KEY: Required if choosing serpapi, free 100 times/month, registration address https://search2ai.online/serpapi
- SERPER_KEY: Required if choosing serper, free 2500 times for 6 months, note variable name is different from above, registration address https://search2ai.online/serper

3. Enter the api directory, run the program, and display the log in real-time
```
cd api && nohup node index.js > output.log 2>&1 & tail -f output.log
```

4. Port 3014, the complete address after concatenation is as follows, can be configured according to the client's requirements for the apibase address (if https is required, need to use nginx for reverse proxy, many tutorials online)
```
http://localhost:3014/v1/chat/completions
```

**Deployment with cloudflare worker**
1. Copy the code of [search2ai](https://search2ai.online/cloudflare), no modifications needed! Deploy in cloudflare's worker, after going online, the worker's address can be used as your interface call's custom domain address, note the concatenation, worker address only represents the part before v1 XXX/v1/chat/completions

2. Configure variables in the worker
![Effect Example](pictures/worker.png)
- SEARCH_SERVICE: Currently supports google, bing, serpapi, serper, duckduckgo, required
- APIBASE: If you are using an OpenAI third-party proxy, you can fill it in here, note that v1 is not needed, not required
- BING_KEY: Required if choosing bing search, please search for tutorials, application address https://search2ai.online/bing
- GOOGLE_CX: Required if choosing Google search, Search engine ID, please search for tutorials, application address https://search2ai.online/googlecx
- GOOGLE_KEY: Required if choosing Google search, API key, application address https://search2ai.online/googlekey
- SERPAPI_KEY: Required if choosing serpapi, free 100 times/month, registration address https://search2ai.online/serpapi
- SERPER_KEY: Required if choosing serper, free 2500 times for 6 months, note variable name is different from above, registration address https://search2ai.online/serper

3. Configure triggers - custom domain in the worker, direct access to the worker's address in China might have issues, need to replace with custom domain
![Alt text](pictures/域名.png)

**Deployment with Vercel**

Special note: Vercel project does not support streaming output and has a 10s response limit, actual user experience is poor, released mainly for experts to pull request

One-click deployment

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Ffatwang2%2Fsearch2ai&env=SEARCH_SERVICE&envDescription=%E6%9A%82%E6%97%B6%E6%94%AF%E6%8C%81google%E3%80%81bing%E3%80%81serpapi%E3%80%81serper%E3%80%81duckduckgo%EF%BC%8C%E5%BF%85%E5%A1%AB)

To ensure updates, you can also first fork this project and then deploy it on Vercel yourself

# Future Iterations
- Support for Gemini
- Support for Azure OpenAI
- Fix streaming output issues in Vercel project
- Improve the speed of streaming output
- Support more vertical searches

# Special Thanks
- [webpilot](https://github.com/webpilot-ai/Webpilot)
- [LobeChat](https://github.com/lobehub/lobe-chat)




