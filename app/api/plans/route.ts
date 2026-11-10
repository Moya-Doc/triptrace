import { connection } from "next/server";
import { createPlan, linkConversationToPlan, listPlans } from "@/lib/db";
import type { ChatMessage, Constraints } from "@/lib/types";

// 首页的规划列表
export async function GET() {
  await connection();
  return Response.json({ plans: listPlans() });
}

// 新建规划：从首页对话"开始规划"（带着理解好的条件），或者用"+ 规划"新建一个空的
export async function POST(request: Request) {
  const body = (await request.json()) as {
    constraints: Constraints | null;
    conversationId: number | null;
    messages: ChatMessage[];
  };
  const firstWords = body.messages?.find((m) => m.role === "user")?.content;
  const title = planTitle(firstWords);
  const planId = createPlan(title, {
    messages: [],
    constraints: body.constraints,
    anchor: null,
    candidates: [],
    route: null,
    shortlist: [],
  });
  if (body.conversationId !== null && body.conversationId !== undefined) {
    linkConversationToPlan(body.conversationId, planId);
  }
  return Response.json({ planId, title });
}

// 规划标题用用户在首页说的第一句话：比模型的复述更短，也是用户自己的话
function planTitle(text: string | undefined) {
  if (!text) return "新的规划";
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > 24 ? `${t.slice(0, 24)}…` : t;
}
