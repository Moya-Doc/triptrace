import type { NextRequest } from "next/server";
import {
  answerAboutItinerary,
  applyOps,
  describeProposal,
  guardTimes,
  repeatedMessage,
  repeatedProposal,
  replyToEdit,
  resolveCommand,
  type EditOp,
} from "@/lib/command";
import { getPlan, saveItinerary, savePlan, undoItinerary, undoState } from "@/lib/db";
import { ConfigError } from "@/lib/llm";
import { arrivedAt, describeSync, liveContext, refreeze, syncToNow, whereText, type LiveState } from "@/lib/live";
import { addMoments, findMoments, momentLine, type Moment } from "@/lib/moments";
import { normalizeConstraints, type ChatMessage } from "@/lib/types";

// 旅行中的对话入口（和规划对话分开存）。两种动作：
// - sync：用户告诉 TT"现在几点、刚到哪"，冻结已经去过的，从现在开始重排今天
// - say：一键情况按钮（我晚了、下雨了、太累了、这里关门了）或者自由说。先按现在的位置重排，再让 TT 调整；
//   TT 只能改今天还没去的和以后几天，改动也能撤销
// 说的话里有感受（"锦里逛得挺开心"）就记进那个地方的记录；说的地方还排在"现在"之后，先问是不是已经到了（见 lib/moments.ts）
export async function POST(request: NextRequest, ctx: RouteContext<"/api/plans/[id]/live">) {
  const { id } = await ctx.params;
  const planId = Number(id);
  const plan = getPlan(planId);
  const itinerary = plan?.state.itinerary;
  if (!plan || !itinerary) return Response.json({ ok: false, error: "还没有生成行程" }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { action?: string; state?: LiveState; text?: string };
  const s = body.state;
  if (!s || typeof s.day !== "number" || !/^\d{2}:\d{2}$/.test(s.now ?? "") || typeof s.at !== "string")
    return Response.json({ ok: false, error: "缺少现在的时间和位置" }, { status: 400 });
  const transport = normalizeConstraints(plan.state.constraints)?.slots.transport.value ?? null;
  const history = plan.state.liveMessages ?? [];
  const notes = plan.state.notes ?? {};

  try {
    if (body.action === "sync") {
      const synced = await syncToNow(itinerary, s, transport);
      // 之前因为"还没到"而先放着的感受：现在到了（或已经过了）就记上
      const order = (title: string) => synced.after.items.filter((x) => x.kind === "place" || x.kind === "free").findIndex((x) => x.title === title);
      const ready = ((plan.state.livePendingNotes ?? []) as Moment[]).filter(
        (m) => m.day < s.day || (m.day === s.day && order(m.title) >= 0 && order(m.title) <= order(s.at)),
      );
      const nextNotes = addMoments(notes, ready);
      const reply = [describeSync(s, synced.late, synced.after), momentLine(ready)].filter(Boolean).join("\n\n");
      const messages: ChatMessage[] = [
        ...history,
        { role: "user", content: `（第 ${s.day + 1} 天 ${s.now}）我${arrivedAt(s) === s.now ? "刚到" : `${arrivedAt(s)} 到了`}「${s.at}」` },
        { role: "assistant", content: reply },
      ];
      const undo = saveItinerary(planId, synced.itinerary, `旅行中：${arrivedAt(s)} 到「${s.at}」，重排第 ${s.day + 1} 天`, {
        liveMessages: messages,
        notes: nextNotes,
        livePendingNotes: [],
      });
      return Response.json({ ok: true, itinerary: synced.itinerary, messages, suggestions: QUICK, undo, notes: nextNotes });
    }

    const text = (body.text ?? "").trim();
    if (!text) return Response.json({ ok: false, error: "请先说说情况" }, { status: 400 });
    // 记下是第几天、几点说的：回来写游记时，TT 才知道路上的变化发生在哪一天
    const messages: ChatMessage[] = [...history, { role: "user", content: `（第 ${s.day + 1} 天 ${s.now}）${text}` }];
    const context = liveContext(s);
    const again = repeatedMessage(messages, plan.state.livePendingOps as EditOp[] | undefined);
    if (again) {
      const next = [...messages, { role: "assistant" as const, content: again.reply }];
      savePlan(planId, { state: { liveMessages: next } });
      return Response.json({ ok: true, itinerary, messages: next, suggestions: again.suggestions.length ? again.suggestions : QUICK, undo: undoState(planId), notes });
    }
    // 先按现在的位置把过去冻结住，TT 在这个基础上调整
    const synced = await syncToNow(itinerary, s, transport);
    // 理解这句话要做什么，和摘出话里的感受，两件事同时问模型，不多等
    const [{ kind, ops, proposal, confirmed }, moments] = await Promise.all([
      resolveCommand(messages, synced.itinerary, plan.state.livePendingOps as EditOp[] | undefined, context),
      text.length > 6 && !QUICK.includes(text) ? findMoments(text, synced.itinerary, s).catch(() => []) : Promise.resolve([]),
    ]);

    // 说的地方还排在现在之后：位置对不上，先问清楚，这句话里的其他要求也先不执行（它们是按"现在在哪"算的）
    const ahead = moments.find((m) => m.conflict);
    if (ahead) {
      const when = ahead.day === s.day ? (ahead.start ? `计划 ${ahead.start}` : "排在后面") : `排在第 ${ahead.day + 1} 天`;
      const reply = `你说到了「${ahead.title}」，但按现在的位置，你${whereText(s).replace(/^刚到/, "还在")}（「${ahead.title}」${when}）。你已经到「${ahead.title}」了吗？到了的话点下面的按钮，我把位置更新过去、重排后面的安排，再把你说的记进它的记录。`;
      const next = [...messages, { role: "assistant" as const, content: reply }];
      savePlan(planId, { state: { liveMessages: next, livePendingNotes: moments, livePendingOps: [] } });
      return Response.json({
        ok: true,
        itinerary,
        messages: next,
        suggestions: [],
        undo: undoState(planId),
        relocate: { day: ahead.day, at: ahead.title, start: ahead.start },
        notes,
      });
    }
    // 位置对得上：感受直接记上，回复末尾说一句记在哪
    const nextNotes = addMoments(notes, moments);
    const noted = momentLine(moments);
    const withNote = (reply: string) => [reply, noted].filter(Boolean).join("\n\n");

    if (kind === "undo") {
      const undone = undoItinerary(planId);
      const reply = undone ? `已撤销：${undone.label}。` : "没有可以撤销的修改了。";
      const next = [...messages, { role: "assistant" as const, content: reply }];
      savePlan(planId, { state: { liveMessages: next, livePendingOps: [], livePendingNotes: [] } });
      return Response.json({ ok: true, itinerary: undone?.itinerary ?? itinerary, messages: next, suggestions: QUICK, undo: undone?.undo ?? undoState(planId), notes });
    }
    if (kind === "replan") {
      const reply = withNote("换目的地、改日期这类整体变化，回到「规划」书签里改比较稳妥；路上的临时调整我可以直接帮你改。");
      const next = [...messages, { role: "assistant" as const, content: reply }];
      savePlan(planId, { state: { liveMessages: next, livePendingOps: [], livePendingNotes: [], notes: nextNotes } });
      return Response.json({ ok: true, itinerary, messages: next, suggestions: QUICK, undo: undoState(planId), notes: nextNotes });
    }
    // 只是在说感受（没有要改的、也不是在问）：记下就好，不用模型再回一段
    if (kind === "chat" && moments.length && !/[？?吗呢]/.test(text)) {
      const next = [...messages, { role: "assistant" as const, content: noted }];
      savePlan(planId, { state: { liveMessages: next, livePendingOps: [], livePendingNotes: [], notes: nextNotes } });
      return Response.json({ ok: true, itinerary, messages: next, suggestions: QUICK, undo: undoState(planId), notes: nextNotes });
    }
    if (kind === "chat" || kind === "propose") {
      // 有操作的提议：用试算结果描述，保证说的和确认后做的一致
      const exact = kind === "propose" ? await describeProposal(synced.itinerary, ops, transport) : null;
      // 提议附带了操作、但试算一项都执行不了（比如要改的地方已经不在行程里），就不提这个议
      const { reply, suggestions } =
        (kind === "propose" && repeatedProposal(ops, plan.state.livePendingOps as EditOp[] | undefined, exact)) ||
        (await answerAboutItinerary(messages, synced.itinerary, exact ?? (ops.length ? null : proposal), context));
      const next = [...messages, { role: "assistant" as const, content: withNote(reply) }];
      // 提议时存下对应的操作，用户确认时直接执行
      savePlan(planId, {
        state: { liveMessages: next, livePendingOps: kind === "propose" && exact ? ops : [], livePendingNotes: [], notes: nextNotes },
      });
      return Response.json({ ok: true, itinerary, messages: next, suggestions, undo: undoState(planId), notes: nextNotes });
    }

    // 只允许改今天还没去的和以后几天
    const allowed = (confirmed ? ops : guardTimes(ops, messages)).filter((o) => {
      if (o.day - 1 < s.day) return false;
      if (o.day - 1 === s.day && "title" in o && synced.frozen.has(o.title)) return false;
      return true;
    });
    const applied = await applyOps(synced.itinerary, allowed, transport);
    // 改完再按旅行中的规则整理：去过的不动，剩下的从现在开始
    const result = { ...applied, itinerary: await refreeze(applied.itinerary, s, synced.frozen, transport) };
    const blocked = ops.length - allowed.length;
    if (blocked) result.failed.push(`有 ${blocked} 处改的是已经去过的安排，没有改`);
    const { reply, suggestions } = await replyToEdit({ messages, ...result, context });
    const next = [...messages, { role: "assistant" as const, content: withNote(reply) }];
    const label = result.applied.length ? `旅行中 TT 的修改（${result.applied.join("；")}）` : null;
    const undo = saveItinerary(planId, result.itinerary, label, {
      liveMessages: next,
      livePendingOps: [],
      livePendingNotes: [],
      notes: nextNotes,
    });
    return Response.json({ ok: true, itinerary: result.itinerary, messages: next, suggestions, undo, notes: nextNotes });
  } catch (e) {
    const message = e instanceof Error ? e.message : "调整失败，请再试一次";
    return Response.json({ ok: false, error: message }, { status: e instanceof ConfigError ? 503 : 502 });
  }
}

// 旅行中常见的几种情况，一键说出来
const QUICK = ["我晚了，后面帮我顺一下", "下雨了", "太累了，想轻松点", "这里关门了"];
