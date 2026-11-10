// 大模型调用：任意 OpenAI 兼容接口（默认 DeepSeek），换模型只需改 .env.local。

export class ConfigError extends Error {}

// 给用户看的一句话。接口的原始报错（英文、带请求编号）只记在服务器日志里
class LlmError extends Error {}

function statusError(status: number) {
  if (status === 401 || status === 403) return new ConfigError("大模型的 Key 不对或没有权限，请检查 LLM_API_KEY");
  if (status === 402) return new ConfigError("大模型账户的余额不足，充值后再试");
  if (status === 429) return new LlmError("AI 服务收到的请求太多了，请等一会儿再重试");
  return new LlmError("AI 服务暂时繁忙，请稍后重试");
}

type LlmMessage = { role: "system" | "user" | "assistant"; content: string };

// JSON 模式下，模型偶尔仍会返回空内容、被截断的内容，或者在外面包一层 ```json 代码块。
// 先尽量把 JSON 从回复里抠出来；还不行就整次重试，最多试 2 次
const ATTEMPTS = 2;
let lastFinish = "";

// 随机性（temperature）：理解指令、抽取结构这类要稳定的，用默认的 0.2；
// 写给用户看的回复用 REPLY（0.7），说法更自然，同样的情况也不会一字不差地重复
export const REPLY = { temperature: 0.7 };

export async function chatJson(messages: LlmMessage[], opts: { temperature?: number } = {}): Promise<unknown> {
  let lastProblem = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const content = await complete(messages, opts.temperature ?? 0.2);
    const parsed = extractJson(content);
    if (parsed !== undefined) return parsed;
    lastProblem = content ? `开头是：${content.slice(0, 80)}` : "内容为空";
    // 记在服务器日志里，方便排查是哪种情况
    console.warn(`[llm] 第 ${attempt} 次返回的不是合法 JSON（${content.length} 字，结束原因 ${lastFinish}），${lastProblem}`);
  }
  throw new Error("TT 的回复格式出了问题，请点“重试”");
}

async function complete(messages: LlmMessage[], temperature: number): Promise<string> {
  const baseUrl = process.env.LLM_BASE_URL || "https://api.deepseek.com";
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL || "deepseek-chat";
  if (!apiKey) throw new ConfigError("还没有配置大模型 Key（LLM_API_KEY）");

  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: 2000,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[llm] 接口返回 ${res.status}：${detail.slice(0, 500)}`);
      throw statusError(res.status);
    }

    const data = await res.json();
    lastFinish = data?.choices?.[0]?.finish_reason ?? "未知";
    return data?.choices?.[0]?.message?.content ?? "";
  } catch (e) {
    if (e instanceof ConfigError || e instanceof LlmError) throw e;
    const name = e instanceof Error ? e.name : "";
    console.error(`[llm] 请求失败：${e instanceof Error ? `${e.name} ${e.message}` : String(e)}`);
    if (name === "TimeoutError") throw new LlmError("AI 服务响应太慢，请稍后重试");
    if (name === "TypeError") throw new LlmError("连不上 AI 服务，请检查网络后重试");
    throw new LlmError("AI 服务暂时繁忙，请稍后重试");
  }
}

function extractJson(content: string): unknown {
  const text = content.trim();
  if (!text) return undefined;
  const body = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const candidates = [
    text,
    text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""),
    body,
    escapeControlCharsInStrings(body),
  ];
  for (const t of candidates) {
    try {
      return JSON.parse(t);
    } catch {
      // 换下一种方式
    }
  }
  return undefined;
}

// 模型有时会在 JSON 字符串里直接换行（真实的换行符），按规范必须写成 \n，否则解析失败。
// 逐个字符扫描，只把字符串内部的换行、回车、制表符转义，字符串外面的空白保持原样
function escapeControlCharsInStrings(json: string) {
  const escapes: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (inString && !escaped && escapes[ch]) {
      out += escapes[ch];
      continue;
    }
    if (escaped) escaped = false;
    else if (ch === "\\" && inString) escaped = true;
    else if (ch === '"') inString = !inString;
    out += ch;
  }
  return out;
}
