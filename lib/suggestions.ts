// 快捷回复：显示在输入框上方，点一下直接发送。由 LLM 根据这一轮的回复预估用户最可能说的下一句
export const SUGGESTION_RULE = `- 另外给出 suggestions：2–3 条用户最可能说的下一句话，用用户的口吻，每条不超过 14 个字。
  回复末尾问了"要不要改"这类是非问题时，前两条就是对它的回答（例如"好，改吧""先不改"）；其他时候给具体的下一步（例如"第三天轻松一点""换一家近点的酒店"）`;

export function cleanSuggestions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim().slice(0, 20))
    .slice(0, 3);
}
