"use client";

import { useEffect, useRef, useState } from "react";
import RichText from "@/components/RichText";
import ErrorNote from "@/components/ErrorNote";
import type { ChatMessage, Constraints } from "@/lib/types";

// 首页左栏：发散模式的对话。
// 每次打开首页都是一段新对话；说过的念头写进灵感池，整段对话存进"对话历史"。
// 当这段对话足以形成一次规划时，输入框左上方弹出"开始规划"；也可以随时点"+ 规划"手动开始

const EXAMPLES = [
  "想找个可以登山露营的地方，最好附近可以吃到烤全羊，在成都附近就更好了",
  "十一想去个人少、能看海的地方",
  "我想 4 天玩完重庆、成都、西安",
];

export type StartPlanPayload = {
  constraints: Constraints | null;
  conversationId: number | null;
  messages: ChatMessage[];
};

type Conversation = {
  id: number;
  preview: string;
  messageCount: number;
  planId: number | null;
  updatedAt: string;
  messages: ChatMessage[];
};

export default function HomeChat({ onStartPlan }: { onStartPlan: (p: StartPlanPayload) => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [constraints, setConstraints] = useState<Constraints | null>(null);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || loading) return;
    const next: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages(next);
    setInput("");
    await request(next);
  }

  // 上一次请求失败时，"重试"按钮用同样的对话再请求一次
  const [failed, setFailed] = useState<ChatMessage[] | null>(null);

  async function request(next: ChatMessage[]) {
    setFailed(null);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/home-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next, constraints, conversationId }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error);
        setFailed(next);
        return;
      }
      setMessages([...next, { role: "assistant", content: data.reply }]);
      setConstraints(data.constraints);
      setConversationId(data.conversationId);
      setReady(data.ready);
    } catch {
      setError("连不上服务器，请确认开发服务器还在运行");
      setFailed(next);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="relative flex h-full w-full flex-col border-gray-200 bg-[#fbfbfa] md:border-r">
      <header className="flex items-center gap-3 border-b border-gray-200 px-4 py-3">
        <button
          onClick={() => setHistoryOpen(true)}
          title="对话历史"
          className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-gray-200 px-2 text-xs text-gray-600 hover:bg-gray-100"
        >
          ☰ 历史
        </button>
        <div>
          <h1 className="text-base font-semibold">TripTrace</h1>
          <p className="text-xs text-gray-500">敢说“不”的旅行顾问</p>
        </div>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-6">
        {messages.length === 0 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold">最近有什么旅行念头？</h2>
              <p className="mt-1 text-sm leading-6 text-gray-600">
                随便聊，模糊也没关系。你说过的念头我都会记住；聊得差不多了，再开始规划。
              </p>
            </div>
            <div className="space-y-2">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  onClick={() => send(ex)}
                  className="block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-left text-sm text-gray-700 hover:border-teal-600"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-teal-700 px-3 py-2 text-sm leading-6 text-white">
                {m.content}
              </div>
            </div>
          ) : (
            <div key={i} className="text-sm leading-7 text-gray-800">
              <RichText text={m.content} />
            </div>
          ),
        )}
        {loading && <div className="text-sm text-gray-400">TT 正在想…</div>}
        {error && <ErrorNote message={error} onRetry={failed && !loading ? () => request(failed) : undefined} />}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-gray-200 p-3">
        {ready && !loading && (
          <button
            onClick={() => onStartPlan({ constraints, conversationId, messages })}
            className="tt-pop mb-2 rounded-full bg-teal-700 px-4 py-1.5 text-sm text-white shadow hover:bg-teal-800"
          >
            开始规划 →
          </button>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="flex gap-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="比如：周末想出去走走"
            className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-teal-600"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="rounded-lg bg-teal-700 px-4 py-2 text-sm text-white disabled:opacity-40"
          >
            发送
          </button>
          <button
            type="button"
            onClick={() => onStartPlan({ constraints: null, conversationId: null, messages: [] })}
            title="不聊了，直接开始一个空白规划"
            className="shrink-0 rounded-lg px-2 text-xs text-gray-400 hover:bg-gray-100 hover:text-gray-700"
          >
            + 规划
          </button>
        </form>
      </div>

      {historyOpen && <HistoryDrawer onClose={() => setHistoryOpen(false)} />}
      <style>{`
        .tt-pop { animation: tt-pop 0.35s cubic-bezier(0.2, 0.9, 0.3, 1.3); }
        @keyframes tt-pop { from { opacity: 0; transform: translateY(8px) scale(0.9); } to { opacity: 1; transform: none; } }
      `}</style>
    </section>
  );
}

// 对话历史：首页每段对话都在这里，可以按关键词检索、展开回看
function HistoryDrawer({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<Conversation[] | null>(null);
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/conversations")
      .then((r) => r.json())
      .then((d) => setList(d.conversations))
      .catch(() => setList([]));
  }, []);

  const q = query.trim();
  const shown = (list ?? []).filter((c) => !q || c.messages.some((m) => m.content.includes(q)));

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-white">
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
        <h2 className="text-sm font-semibold">对话历史</h2>
        <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-900">
          关闭
        </button>
      </div>
      <div className="p-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索说过的话，比如：烤全羊"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-teal-600"
        />
      </div>
      <ul className="flex-1 space-y-2 overflow-y-auto px-3 pb-4">
        {list === null && <li className="text-sm text-gray-400">加载中…</li>}
        {list?.length === 0 && <li className="text-sm text-gray-400">还没有对话</li>}
        {shown.map((c) => (
          <li key={c.id} className="rounded-xl border border-gray-200">
            <button
              onClick={() => setOpenId(openId === c.id ? null : c.id)}
              className="w-full px-3 py-2.5 text-left"
            >
              <div className="truncate text-sm text-gray-900">{c.preview || "（空）"}</div>
              <div className="mt-0.5 text-xs text-gray-400">
                {new Date(c.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                {" · "}
                {c.messageCount} 条消息
                {c.planId !== null && " · 已开始规划"}
              </div>
            </button>
            {openId === c.id && (
              <div className="space-y-2 border-t border-gray-100 px-3 py-2 text-xs leading-5">
                {c.messages.map((m, i) => (
                  <p key={i} className={m.role === "user" ? "text-teal-800" : "text-gray-600"}>
                    {m.role === "user" ? "你：" : "TT："}
                    {m.content}
                  </p>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
