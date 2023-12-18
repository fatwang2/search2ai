# 版本更新
- V0.0.1，20231218，开源代码，可直接在cloudflare的worker里部署上线

# 产品介绍
- OpenAI联网版，根据你的意图判断是否需要联网，请求头和体都跟OpenAI一致，key也可以直接用OpenAI的，通过function calling实现。
- 把search2ai文件里的代码直接在cloudflare的worker里部署，用部署上线后的地址作为你接口调用时的api base地址，即可实现联网，格式如 XXX/v1/chat/completions
- 懒得部署的，可以直接用我已经部署的版本，api base地址换成 https://online.sum4all.one/v1

![效果示例](pictures/wechat.jpg)

# 后续迭代
- 支持流式输出
- 更换搜索服务
- 支持 OpenAI 三方代理地址
