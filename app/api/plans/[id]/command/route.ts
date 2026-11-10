import type { NextRequest } from "next/server";
import {
  answerAboutItinerary,
  applyOps,
  describeProposal,
  repeatedMessage,
  repeatedProposal,
  guardTimes,
  replyToEdit,
  resolveCommand,
  type EditOp,
} from "@/lib/command";
import { getPlan, saveItinerary, savePlan, undoItinerary, undoState } from "@/lib/db";
import { ConfigError } from "@/lib/llm";
import { normalizeConstraints, type ChatMessage } from "@/lib/types";

// 生成行程之后的对话入口：先判断这句话是不是在调整行程。
// - edit：直接改右边的行程，并回复改了什么
// - chat：提问和闲聊，根据当前行程回答
// - propose：用户很可能想改但没明说，先不动行程，回复里提出修改并问一句，快捷回复给"好，改吧 / 先不改"
// - replan：返回类型，由前端交给原来的对话流程，更新路书后重新生成行程
export async function POST(request: NextRequest, ctx: RouteContext<"/api/plans/[id]/command">) {
  const { id } = await ctx.params;
  const planId = Number(id);
  const plan = getPlan(planId);
  const itinerary = plan?.state.itinerary;
  if (!plan || !itinerary) return Response.json({ ok: false, error: "还没有生成行程" }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { messages?: ChatMessage[] };
  const messages = body.messages ?? [];
  if (!messages.some((m) => m.role === "user")) return Response.json({ ok: false, error: "请先说说想怎么改" }, { status: 400 });

  try {
    const transport = normalizeConstraints(plan.state.constraints)?.slots.transport.value ?? null;
    // 原样又发了一遍上一句：不再问模型
    const again = repeatedMessage(messages, plan.state.pendingOps as EditOp[] | undefined);
    if (again) {
      savePlan(planId, { state: { messages: [...messages, { role: "assistant", content: again.reply }] } });
      return Response.json({ ok: true, kind: "chat", reply: again.reply, suggestions: again.suggestions, undo: undoState(planId) });
    }
    const { kind, ops, proposal, confirmed } = await resolveCommand(
      messages,
      itinerary,
      plan.state.pendingOps as EditOp[] | undefined,
    );
    // 撤销：和界面上的"撤销"按钮是同一个操作
    if (kind === "undo") {
      const undone = undoItinerary(planId);
      const reply = undone ? `已撤销：${undone.label}。` : "没有可以撤销的修改了。";
      savePlan(planId, { state: { messages: [...messages, { role: "assistant", content: reply }], pendingOps: [] } });
      return Response.json({
        ok: true,
        kind: "edit",
        itinerary: undone?.itinerary ?? itinerary,
        reply,
        suggestions: [],
        undo: undone?.undo ?? undoState(planId),
      });
    }
    if (kind === "replan") return Response.json({ ok: true, kind });
    if (kind === "chat" || kind === "propose") {
      // 有操作的提议：用试算结果描述，保证说的和确认后做的一致
      const exact = kind === "propose" ? await describeProposal(itinerary, ops, transport) : null;
      // 提议附带了操作、但试算一项都执行不了（比如要改的地方已经不在行程里），就不提这个议
      const { reply, suggestions } =
        (kind === "propose" && repeatedProposal(ops, plan.state.pendingOps as EditOp[] | undefined, exact)) ||
        (await answerAboutItinerary(messages, itinerary, exact ?? (ops.length ? null : proposal)));
      // 提议时存下对应的操作，用户确认时直接执行
      savePlan(planId, {
        state: { messages: [...messages, { role: "assistant", content: reply }], pendingOps: kind === "propose" && exact ? ops : [] },
      });
      return Response.json({ ok: true, kind, reply, suggestions });
    }

    // 只有用户说出的时刻才能被固定（见 guardTimes）；用户确认的是 TT 的提议时，照提议执行
    const result = await applyOps(itinerary, confirmed ? ops : guardTimes(ops, messages), transport);
    const { reply, suggestions } = await replyToEdit({ messages, ...result });
    const next = [...messages, { role: "assistant" as const, content: reply }];
    // TT 改的也能撤销；只问了问题、什么都没改的，不进历史
    const label = result.applied.length ? `TT 的修改（${result.applied.join("；")}）` : null;
    const undo = saveItinerary(planId, result.itinerary, label, { messages: next, pendingOps: [] });
    return Response.json({ ok: true, kind, itinerary: result.itinerary, reply, suggestions, changedDays: result.changedDays, undo });
  } catch (e) {
    const message = e instanceof Error ? e.message : "调整失败，请再试一次";
    return Response.json({ ok: false, error: message }, { status: e instanceof ConfigError ? 503 : 502 });
  }
}
