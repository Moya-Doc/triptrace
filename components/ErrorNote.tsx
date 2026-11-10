// 对话里的报错：一句能看懂的话，能重试的带一个"重试"按钮（重试时不会把用户的话再发一遍到对话里）
export default function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
      <span>{message}</span>
      {onRetry && (
        <button
          onClick={onRetry}
          className="shrink-0 rounded-md bg-white px-2.5 py-1 text-xs text-red-700 ring-1 ring-red-200 hover:bg-red-100"
        >
          重试
        </button>
      )}
    </div>
  );
}
