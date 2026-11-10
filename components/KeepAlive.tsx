"use client";

import { useLayoutEffect, useRef } from "react";

// 书签切走时内容不卸载（正在等的回复不会丢），只是真正隐藏（display: none）。
// 之前用 visibility: hidden，Safari 切回来时可滚动的区域经常不重画，白屏很久；
// display: none 会让浏览器忘掉滚动位置，所以这里自己记：每个滚动区域滚到哪、是不是停在最底下。
// 切回来时恢复；原来停在最底下的（对话），切走期间来了新消息，就直接滚到新的底部
export default function KeepAlive({ show, className, children }: { show: boolean; className: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const saved = useRef(new Map<Element, { top: number; atBottom: boolean }>());

  useLayoutEffect(() => {
    if (!show) return;
    for (const [el, s] of saved.current) {
      if (!el.isConnected) saved.current.delete(el);
      else el.scrollTop = s.atBottom ? el.scrollHeight : s.top;
    }
  }, [show]);

  return (
    <div
      ref={ref}
      className={`${className} ${show ? "" : "hidden"}`}
      onScrollCapture={(e) => {
        const el = e.target as Element;
        // 隐藏时浏览器会把滚动位置归零并触发滚动事件，这时不能覆盖记下的位置
        if (!show || el.clientHeight === 0) return;
        saved.current.set(el, { top: el.scrollTop, atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 8 });
      }}
    >
      {children}
    </div>
  );
}
