// 独立 OpenAI Chat Completions 探针；不读取 Pi 或用户的凭据文件。
const endpoint = process.env.CW_GATEWAY_URL;
const apiKey = process.env.CW_GATEWAY_API_KEY;
const model = process.env.CW_GATEWAY_MODEL;

async function main(): Promise<void> {
  if (!endpoint || !apiKey || !model) {
    throw new Error("需要显式设置 CW_GATEWAY_URL、CW_GATEWAY_API_KEY、CW_GATEWAY_MODEL；URL 为完整 chat/completions 地址");
  }
  const url = new URL(endpoint);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("网关必须使用 HTTPS（本机测试可使用 HTTP）");
  }
  // 4096 个空格分隔编号，常见 tokenizer 远超 2000 token；以服务端 usage 再核对。
  const prefix = Array.from({ length: 4096 }, (_, i) => `record_${i.toString().padStart(4, "0")}`).join(" ");
  const body = JSON.stringify({
    model,
    messages: [
      { role: "system", content: `Fixed cache probe data:\n${prefix}` },
      { role: "user", content: "Reply only OK." },
    ],
    max_tokens: 16,
    stream: false,
  });
  let prefixConfirmed = false;
  let secondCacheRead = 0;
  for (let request = 1; request <= 2; request++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body,
      signal: AbortSignal.timeout(120_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`请求 ${request} HTTP ${response.status}；不输出响应正文以免泄漏凭据`);
    const result = await response.json() as {
      usage?: {
        prompt_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        prompt_cache_hit_tokens?: number;
        cache_read_input_tokens?: number;
      };
    };
    console.log(JSON.stringify({ request, usage: result.usage ?? null }));
    if (request === 1) prefixConfirmed = (result.usage?.prompt_tokens ?? 0) > 2000;
    if (request === 2) secondCacheRead = Math.max(
      result.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      result.usage?.prompt_cache_hit_tokens ?? 0,
      result.usage?.cache_read_input_tokens ?? 0,
    );
  }
  console.log(JSON.stringify({
    verdict: prefixConfirmed && secondCacheRead > 0 ? "supported" : "unconfirmed",
    prefixOver2000Tokens: prefixConfirmed,
    secondCacheRead,
    note: prefixConfirmed && secondCacheRead > 0
      ? "第二次 usage 报告缓存读取；仅证明此模型、端点与请求支持缓存"
      : "未确认：缺少足够的 token 或缓存读取证据，不代表网关不支持缓存",
  }));
}

main().catch((error: unknown) => {
  // 不打印 fetch cause、URL 或服务端响应。
  console.error(error instanceof Error ? error.message : "缓存探针失败");
  process.exitCode = 1;
});
