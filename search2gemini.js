addEventListener("fetch", (event) => {
	event.respondWith(handleRequest(event.request));
});

const corsHeaders = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS", // 允许的HTTP方法
	"Access-Control-Allow-Headers":
		"DNT,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range,Authorization,x-goog-api-client,x-goog-api-key",
	"Access-Control-Max-Age": "86400", // 预检请求结果的缓存时间
};
async function search(query) {
	console.log(
		`正在使用 ${SEARCH_SERVICE} 进行自定义搜索: ${JSON.stringify(query)}`
	);
	try {
		let results;

		switch (SEARCH_SERVICE) {
			case "search1api":
				const search1apiResponse = await fetch(
					"https://api.search1api.com/search/",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization:
								typeof SEARCH1API_KEY !== "undefined"
									? `Bearer ${SEARCH1API_KEY}`
									: "",
						},
						body: JSON.stringify({
							query,
							search_service: "google",
							max_results:
								typeof MAX_RESULTS !== "undefined" ? MAX_RESULTS : "5",
							crawl_results:
								typeof CRAWL_RESULTS !== "undefined" ? CRAWL_RESULTS : "0",
						}),
					}
				);
				results = await search1apiResponse.json();
				break;

			case "google":
				const googleApiUrl = `https://www.googleapis.com/customsearch/v1?cx=${GOOGLE_CX}&key=${GOOGLE_KEY}&q=${encodeURIComponent(
					query
				)}`;
				const googleResponse = await fetch(googleApiUrl);
				const googleData = await googleResponse.json();
				results = googleData.items.slice(0, MAX_RESULTS).map((item) => ({
					title: item.title,
					link: item.link,
					snippet: item.snippet,
				}));
				break;

			case "bing":
				const bingApiUrl = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(
					query
				)}`;
				const bingResponse = await fetch(bingApiUrl, {
					headers: { "Ocp-Apim-Subscription-Key": BING_KEY },
				});
				const bingData = await bingResponse.json();
				results = bingData.webPages.value.slice(0, MAX_RESULTS).map((item) => ({
					title: item.name,
					link: item.url,
					snippet: item.snippet,
				}));
				break;

			case "serpapi":
				const serpApiUrl = `https://serpapi.com/search?api_key=${SERPAPI_KEY}&engine=google&q=${encodeURIComponent(
					query
				)}&google_domain=google.com`;
				const serpApiResponse = await fetch(serpApiUrl);
				const serpApiData = await serpApiResponse.json();
				results = serpApiData.organic_results
					.slice(0, MAX_RESULTS)
					.map((item) => ({
						title: item.title,
						link: item.link,
						snippet: item.snippet,
					}));
				break;

			case "serper":
				const gl = typeof GL !== "undefined" ? GL : "us";
				const hl = typeof HL !== "undefined" ? HL : "en";
				const serperApiUrl = "https://google.serper.dev/search";
				const serperResponse = await fetch(serperApiUrl, {
					method: "POST",
					headers: {
						"X-API-KEY": SERPER_KEY,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ q: query, gl: gl, hl: hl }),
				});
				const serperData = await serperResponse.json();
				results = serperData.organic.slice(0, MAX_RESULTS).map((item) => ({
					title: item.title,
					link: item.link,
					snippet: item.snippet,
				}));
				break;

			case "duckduckgo":
				const duckDuckGoApiUrl = "https://ddg.search2ai.online/search";
				const body = {
					q: query,
					max_results: typeof MAX_RESULTS !== "undefined" ? MAX_RESULTS : "5",
				};
				const duckDuckGoResponse = await fetch(duckDuckGoApiUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
				});
				const duckDuckGoData = await duckDuckGoResponse.json();
				results = duckDuckGoData.results.map((item) => ({
					title: item.title,
					link: item.href,
					snippet: item.body,
				}));
				break;
				
			case "searxng":
				const searXNGUrl = `${SEARXNG_BASE_URL}/search?q=${encodeURIComponent(
                    query
                )}&category=general&format=json`;
				const searXNGResponse = await fetch(searXNGUrl);
				const searXNGData = await searXNGResponse.json();
				results = searXNGData.results.slice(0, MAX_RESULTS).map((item) => ({
					title: item.title,
					link: item.url,
					snippet: item.content,
				}));
				break;

			default:
				console.error(`不支持的搜索服务: ${SEARCH_SERVICE}`);
				return `不支持的搜索服务: ${SEARCH_SERVICE}`;
		}

		const data = {
			results: results,
		};

		console.log("自定义搜索服务调用完成");
		return JSON.stringify(data);
	} catch (error) {
		console.error(`在 search 函数中捕获到错误: ${error}`);
		return `在 search 函数中捕获到错误: ${error}`;
	}
}

async function parse_function_response(message) {
	const function_call = message[0]["functionCall"];
	const function_name = function_call["name"];

	console.log("Gemini: Called function " + function_name);

	let function_response;
	try {
		const arguments = function_call["args"];

		if (function_name === "search") {
			// 检查 args 参数是否包含 query 属性
			if (!arguments.hasOwnProperty("query")) {
				function_response = "ERROR: Missing query parameter";
				console.log("Missing query parameter");
				return { function_name, function_response };
			}

			// 获取 query 参数的值
			const query = arguments.query;

			// 调用 search 函数并获取结果
			function_response = await search(query);
			return { function_name, function_response }; // 直接返回
		} else {
			function_response = "ERROR: Called unknown function";
			console.log("Called unknown function:", function_name);
		}
	} catch (error) {
		function_response = "ERROR: Invalid arguments";
		console.log("Invalid arguments:", error.message);
	}
	console.log("Function response:", function_response);

	return { function_name, function_response };
}

async function fetchWithRetry(url, options, maxRetries = 3) {
	for (let i = 0; i < maxRetries; i++) {
		try {
			const response = await fetch(url, options);
			if (response.ok) {
				return response;
			}
		} catch (error) {
			console.error(`Attempt ${i + 1} failed. Retrying...`);
		}
	}
	throw new Error(`Failed to fetch after ${maxRetries} attempts`);
}

async function run_conversation(api_key, message, isStream, isSSE) {
	const date = new Date();
	const timeZone = "Asia/Shanghai";
	const formatter = new Intl.DateTimeFormat("en-US", {
		dateStyle: "full",
		timeZone,
	});
	const currentDate = formatter.format(date);
	if (!message) {
		console.log("Invalid message:", message);
		return errorResponse("Invalid message", 400);
	}
	const customMessage = [
		{
			role: "user",
			parts: [
				{
					text: `Today is ${currentDate}.You are a friendly intelligent assistant with the ability to search online, and you can use emoji to make your conversations more interesting!`,
				},
			],
		},
		{
			role: "model",
			parts: [
				{
					text: "okay",
				},
			],
		},
	];
	message = [...customMessage, ...message];
	console.log("Running conversation with message:", message);
	const originalMessage = [...message];

	const definitions = [
		{
			name: "search",
			description:
				"search on the Interent when the users want something new to know",
			parameters: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description: "The query to search",
					},
				},
			},
		},
	];

	const data = {
		contents: message,
		tools: [
			{
				functionDeclarations: definitions,
			},
		],
	};
	const api_url = isStream
		? "https://gemini.sum4all.site/v1beta/models/gemini-pro:streamGenerateContent?key=" +
		  api_key
		: "https://gemini.sum4all.site/v1beta/models/gemini-pro:generateContent?key=" +
		  api_key;

	const response = await fetchWithRetry(api_url, {
		method: "POST",
		body: JSON.stringify(data),
	});
	// 打印响应的状态
	console.log("Response status:", response.status);
	console.log("Response ok:", response.ok);
	console.log("Response status text:", response.statusText);
	if (!response.ok) {
		console.log("Received error response from run_conversation");
		// 修改: 返回表示出错的 Response 对象
		return new Response(
			JSON.stringify({ error: "Error fetching from Google Language API" }),
			{
				headers: { ...corsHeaders, "content-type": "application/json" },
				status: 500, // 代表出现 Internal Server Error 的错误码
			}
		);
	}
	console.log("Received successful response from run_conversation");
	let responseJson = await response.json();
	console.log("Response body:", responseJson);

	let responseContent;
	if (isStream) {
		// 流式情况下，candidates 是数组
		if (
			!responseJson?.[0]?.["candidates"] ||
			responseJson[0]["candidates"].length === 0
		) {
			console.log("ERROR: No candidates in response");
			return new Response(
				JSON.stringify({ error: "No candidates in response" }),
				{
					headers: { ...corsHeaders, "content-type": "application/json" },
					status: 500, // 代表出现 Internal Server Error 的错误码
				}
			);
		}
		responseContent = responseJson[0]["candidates"][0]["content"];
		message = responseContent["parts"];
		if (!message[0] || !message[0]["functionCall"]) {
			console.log("No functionCall in message, returning initial content");
			const encoder = new TextEncoder();
			const stream = new ReadableStream({
				async start(controller) {
					for (let i = 0; i < responseJson.length; i++) {
						if (isSSE) {
							// SSE 格式
							controller.enqueue(
								encoder.encode(`data: ${JSON.stringify(responseJson[i])}\n\n`)
							);
						} else {
							// JSON 格式
							controller.enqueue(encoder.encode(i === 0 ? "[" : ","));
							controller.enqueue(
								encoder.encode(JSON.stringify(responseJson[i]))
							);
						}
						await new Promise((resolve) => setTimeout(resolve, 500));
					}
					if (!isSSE) {
						controller.enqueue(encoder.encode("]"));
					}
					controller.close();
				},
			});
			return new Response(stream, {
				headers: {
					...corsHeaders,
					"content-type": isSSE ? "text/event-stream" : "application/json",
				},
				status: response.status,
			});
		}
	} else {
		// 非流式情况下，candidates 是对象
		if (!responseJson["candidates"]) {
			console.log("ERROR: No candidates in response");
			return new Response(
				JSON.stringify({ error: "No candidates in response" }),
				{
					headers: { ...corsHeaders, "content-type": "application/json" },
					status: 500, // 代表出现 Internal Server Error 的错误码
				}
			);
		}
		responseContent = responseJson["candidates"][0]["content"];
		message = responseContent["parts"];
		if (!message[0] || !message[0]["functionCall"]) {
			console.log("No functionCall in message, returning initial content");
			return new Response(JSON.stringify(responseJson), {
				headers: { ...corsHeaders, "content-type": "application/json" },
				status: response.status,
			});
		}
	}

	if (message[0]["functionCall"]) {
		const { function_name, function_response } = await parse_function_response(
			message
		);

		const functionResponseData = {
			contents: [
				...originalMessage,
				{
					role: "model",
					parts: [...message],
				},
				{
					role: "function",
					parts: [
						{
							functionResponse: {
								name: function_name,
								response: {
									name: function_name,
									content: function_response,
								},
							},
						},
					],
				},
			],
			tools: [
				{
					functionDeclarations: definitions,
				},
			],
		};
		console.log("functionResponseData:", functionResponseData);
		const functionResponse = await fetchWithRetry(
			`${api_url}${api_url.includes("?") ? "&" : "?"}${isSSE ? "alt=sse" : ""}`,
			{
				method: "POST",
				body: JSON.stringify(functionResponseData),
			}
		);

		if (!functionResponse.ok) {
			console.log("Received error response from run_conversation");
			return new Response(
				JSON.stringify({ error: "Error fetching from Gemini API" }),
				{
					headers: { ...corsHeaders, "content-type": "application/json" },
					status: functionResponse.status,
				}
			);
		}

		// 直接转发Gemini的流式响应
		return new Response(functionResponse.body, {
			status: functionResponse.status,
			headers: {
				...corsHeaders,
				"Content-Type": isSSE ? "text/event-stream" : "application/json",
			},
		});
	}
}

// HTTP请求处理主函数
async function handleRequest(request) {
	// 预检请求的处理
	if (request.method === "OPTIONS") {
		return handleCorsPreflight();
	}

	// 解析请求路径
	const url = new URL(request.url);
	const path = url.pathname;
	// 如果请求路径包含 '/models/gemini-pro-vision'，则直接转发请求
	if (path.includes("/models/gemini-pro-vision")) {
		// 创建一个新的请求对象，复制原始请求的所有信息
		const index = path.indexOf("/models");
		const newRequest = new Request(
			"https://gemini.sum4all.site/v1beta" + path.substring(index) + url.search,
			{
				method: request.method,
				headers: request.headers,
				body: request.body,
				redirect: request.redirect,
			}
		);

		// 使用 fetch API 发送新的请求
		const response = await fetch(newRequest);
		// 检查是否是一个 SSE 响应
		if (response.headers.get("Content-Type") === "text/event-stream") {
			// 如果是 SSE 响应，返回一个新的响应对象，使用原始响应的 body，但设置 headers 为 'text/event-stream'
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
			});
		}
		// 直接返回响应
		return response;
	}
	if (!path.includes("/models/gemini-pro")) {
		return jsonResponse({ error: "Not found" }, 404);
	}
	// 检查路径是否符合预期
	let api_key = request.headers.get("x-goog-api-key");

	// Check if 'Authorization' header exists and starts with 'Bearer '
	let authHeader = request.headers.get("Authorization");
	if (authHeader && authHeader.startsWith("Bearer ")) {
		// Extract the api key from the 'Authorization' header
		api_key = authHeader.slice(7);
	}

	try {
		// 解析请求体
		const requestBody = await request.json(); // 使用 request.json() 解析 JSON 请求体
		const isStream = path.includes("streamGenerateContent");
		const isSSE = url.searchParams.get("alt") === "sse";

		// 调用 run_conversation 并直接返回其响应
		return await run_conversation(
			api_key,
			requestBody.contents,
			isStream,
			isSSE
		);
	} catch (error) {
		// 解析请求体失败或 run_conversation 抛出错误
		console.error("[handleRequest] Error:", error.message);
		return errorResponse(error.message, 500);
	}
}
function handleCorsPreflight() {
	// 处理 CORS 预检请求
	return new Response(null, {
		status: 204,
		headers: corsHeaders,
	});
}

function jsonResponse(body, status = 200) {
	// 辅助函数创建 JSON 响应
	return new Response(JSON.stringify(body), {
		headers: { ...corsHeaders, "Content-Type": "application/json" },
		status,
	});
}
function errorResponse(message, statusCode = 400) {
	return new Response(JSON.stringify({ error: message }), {
		status: statusCode,
		headers: { "Content-Type": "application/json" },
	});
}
