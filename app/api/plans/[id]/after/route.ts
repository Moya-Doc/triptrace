import type { NextRequest } from "next/server";
import { getPlan, savePlan, saveReflection } from "@/lib/db";
import { askQuestions, REFLECTION_QUESTION, writeJournal } from "@/lib/journal";
import { ConfigError } from "@/lib/llm";
import type { ChatMessage } from "@/lib/types";

// 旅行后的对话：TT 按天各问一个问题，最后问"哪里喜欢、哪里后悔"；问完就写游记。
// - start：开始回顾（重新开始会清掉之前的问答）
// - answer：回答当前的问题；skip：跳过当前的问题
// 最后一个问题的回答写回灵感池（下次规划时 TT 会记着）
export async function POST(request: NextRequest, ctx: RouteContext<"/api/plans/[id]/after">) {
  const { id } = await ctx.params;
  const planId = Number(id);
  const plan = getPlan(planId);
  const itinerary = plan?.state.itinerary;
  if (!plan || !itinerary) return Response.json({ ok: false, error: "还没有生成行程" }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { action?: string; text?: string };

  try {
    if (body.action === "start") {
      const notes = plan.state.notes ?? {};
      const asked = await askQuestions(itinerary, plan.state.liveMessages ?? [], notes, plan.state.departure ?? null);
      const questions = [...asked, REFLECTION_QUESTION];
      // 路上写过记录的地方不再问
      const noted = Object.values(notes).some((n) => n.text.trim() || n.photos.length);
      const intro = asked.length
        ? `我问 ${asked.length} 个小问题${noted ? "（路上写过记录的地方就不问了，会直接用你的原话）" : ""}，最后再问一个`
        : "你路上每个地方都写了记录，我直接用你的原话，只再问最后一个问题";
      const messages: ChatMessage[] = [
        {
          role: "assistant",
          content: `欢迎回来！我们一起把这趟旅行写成游记吧。${intro}，想跳过的直接点"跳过"。\n\n**${questions[0]}**`,
        },
      ];
      savePlan(planId, { state: { afterQuestions: questions, afterMessages: messages } });
      return Response.json({ ok: true, messages, total: questions.length, done: false });
    }

    const questions = plan.state.afterQuestions ?? [];
    const history = plan.state.afterMessages ?? [];
    const answered = history.filter((m) => m.role === "user").length;
    if (!questions.length || answered >= questions.length)
      return Response.json({ ok: false, error: "先点“开始回顾”" }, { status: 400 });
    const skip = body.action === "skip" || !body.text?.trim();
    const messages: ChatMessage[] = [...history, { role: "user", content: skip ? "（跳过）" : body.text!.trim() }];

    // 还有问题：问下一个
    if (answered + 1 < questions.length) {
      messages.push({ role: "assistant", content: `**${questions[answered + 1]}**` });
      savePlan(planId, { state: { afterMessages: messages } });
      return Response.json({ ok: true, messages, total: questions.length, done: false });
    }

    // 问完了：写游记；最后一个问题的回答写回灵感池
    const answers = messages.filter((m) => m.role === "user").map((m) => (m.content === "（跳过）" ? null : m.content));
    const qa = questions.map((q, i) => ({ question: q, answer: answers[i] ?? null }));
    const journal = await writeJournal({
      itinerary,
      title: itinerary.title,
      live: plan.state.liveMessages ?? [],
      qa,
      notes: plan.state.notes ?? {},
      departure: plan.state.departure ?? null,
    });
    const reflection = answers.at(-1);
    if (reflection) {
      const cities = [...new Set(itinerary.days.map((d) => d.city))];
      saveReflection(planId, `（${cities.join("、")}之行的回顾）${reflection}`, `${cities.join("、")}之行：${reflection}`.slice(0, 80), cities);
    }
    messages.push({
      role: "assistant",
      content: `游记写好了，在右边。文字都是根据行程、你路上的记录和刚才的回答写的，没说过的感受我没有编；哪里不对直接改。照片先用你路上拍的，不够的用高德的，都可以换。${
        reflection ? "\n\n你说的「哪里喜欢、哪里后悔」我记进了灵感池，下次规划会用上。" : ""
      }`,
    });
    savePlan(planId, { state: { afterMessages: messages, journal } });
    return Response.json({ ok: true, messages, journal, total: questions.length, done: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "出了点问题，请再试一次";
    return Response.json({ ok: false, error: message }, { status: e instanceof ConfigError ? 503 : 502 });
  }
}
