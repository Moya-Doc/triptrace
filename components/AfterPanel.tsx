"use client";

import { useEffect, useRef, useState } from "react";
import RichText from "@/components/RichText";
import ErrorNote from "@/components/ErrorNote";
import type { ChatMessage, Journal } from "@/lib/types";

// "旅行后"书签的左边：TT 按天各问一个问题，最后问"哪里喜欢、哪里后悔"；问完就在右边写好游记。
// 每个问题都可以跳过；最后一个问题的回答会写回灵感池

export default function AfterPanel(props: {
  planId: number;
  hasItinerary: boolean;
  initialMessages: ChatMessage[];
  initialQuestions: number;
  onJournal: (j: Journal) => void;
}) {
  const { planId, hasItinerary, onJournal } = props;
  const [messages, setMessages] = useState<ChatMessage[]>(props.initialMessages);
  const [total, setTotal] = useState(props.initialQuestions);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const retryRef = useRef<(() => void) | null>(null);
  const answered = messages.filter((m) => m.role === "user").length;
  const finished = total > 0 && answered >= total;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function call(action: "start" | "answer" | "skip", text?: string, retrying = false) {
    if (busy) return;
    if (text && !retrying) setMessages((m) => [...m, { role: "user", content: text }]);
    retryRef.current = () => call(action, text, true);
    setInput("");
    setError(null);
    const last = action !== "start" && answered + 1 >= total;
    setBusy(action === "start" ? "TT 在看这趟行程，准备问题…" : last ? "TT 正在写游记，大约 10 秒…" : null);
    try {
      const res = await fetch(`/api/plans/${planId}/after`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, text }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error);
        return;
      }
      setMessages(data.messages);
      setTotal(data.total ?? 0);
      if (data.journal) onJournal(data.journal);
    } catch {
      setError("连不上服务器，请确认开发服务器还在运行");
    } finally {
      setBusy(null);
    }
  }

  if (!hasItinerary)
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
        <p className="text-base font-semibold text-gray-900">旅行后</p>
        <p className="mt-2 text-sm leading-6 text-gray-500">先在「规划」里生成逐日行程，旅行回来后在这里写游记。</p>
      </div>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="space-y-3 text-sm leading-6 text-gray-600">
            <p>旅行回来了？TT 会按天问你几个小问题，再根据行程和你的回答写一篇游记：</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>只写你去过的地方和你说过的感受，不替你编</li>
              <li>照片先用高德的，可以换成你自己拍的</li>
              <li>可以导出一张长图，发朋友圈或小红书</li>
              <li>最后问一句「哪里喜欢、哪里后悔」，记进灵感池，下次规划用得上</li>
            </ul>
            <button onClick={() => call("start")} disabled={Boolean(busy)} className="w-full rounded-lg bg-teal-700 py-2 text-white">
              开始回顾
            </button>
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
        {busy && <div className="text-sm text-gray-400">{busy}</div>}
        {error && <ErrorNote message={error} onRetry={busy ? undefined : () => retryRef.current?.()} />}
        {finished && !busy && (
          <button
            onClick={() => call("start")}
            className="rounded-full border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:border-teal-600"
          >
            重新回顾（会重新提问、重写游记）
          </button>
        )}
        <div ref={bottomRef} />
      </div>

      {messages.length > 0 && !finished && (
        <div className="border-t border-gray-200 p-3">
          <div className="mb-2 flex items-center justify-between text-xs text-gray-400">
            <span>
              第 {Math.min(answered + 1, total)} / {total} 个问题
            </span>
            <button onClick={() => call("skip")} disabled={Boolean(busy)} className="rounded-full border border-gray-300 px-3 py-0.5 text-gray-600">
              跳过
            </button>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (input.trim()) call("answer", input.trim());
            }}
            className="flex items-end gap-2"
          >
            <textarea
              value={input}
              rows={3}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (input.trim()) call("answer", input.trim());
                }
              }}
              placeholder="随便说说，想到什么说什么"
              className="flex-1 resize-none rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm leading-6 outline-none focus:border-teal-600"
            />
            <button type="submit" disabled={Boolean(busy) || !input.trim()} className="rounded-lg bg-teal-700 px-4 py-2 text-sm text-white disabled:opacity-40">
              回答
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
