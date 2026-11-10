import { AmapError } from "@/lib/amap";
import { listInspirationCards, saveConversation, saveInspirationCard } from "@/lib/db";
import { ConfigError } from "@/lib/llm";
import { respondHome } from "@/lib/respond";
import type { ChatMessage, Constraints } from "@/lib/types";
import { hasNewTravelInfo, readyToPlan, understand } from "@/lib/understand";

// 首页对话：发散模式。
// 读取灵感池帮助理解和回应；出现新的旅行信息时写入灵感池；整段对话存进"对话历史"。
// "开始规划"按钮只看这段对话本身（ready 由规则判断），不看以前的历史

type HomeChatRequest = {
  messages: ChatMessage[];
  constraints: Constraints | null;
  conversationId: number | null;
};

export async function POST(request: Request) {
  let body: HomeChatRequest;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "请求格式不对" }, { status: 400 });
  }
  const messages = body.messages ?? [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser?.content.trim()) {
    return Response.json({ ok: false, error: "请先说说你的想法" }, { status: 400 });
  }

  try {
    const memory = listInspirationCards(30);
    const constraints = await understand(messages, body.constraints ?? null, memory);
    // "开始规划"只看这段对话：从这段对话本身理解出的方向，而不是从记忆里补出来的
    const ready = readyToPlan(constraints);
    const reply = await respondHome({ messages, constraints, ready });

    const conversationId = saveConversation(body.conversationId ?? null, [
      ...messages,
      { role: "assistant", content: reply },
    ]);
    if (hasNewTravelInfo(body.constraints ?? null, constraints)) {
      saveInspirationCard(lastUser.content, constraints, conversationId);
    }

    return Response.json({ ok: true, reply, constraints, ready, conversationId });
  } catch (e) {
    const message =
      e instanceof ConfigError || e instanceof AmapError || e instanceof Error ? e.message : "出了点问题";
    return Response.json({ ok: false, error: message }, { status: e instanceof ConfigError ? 503 : 502 });
  }
}
