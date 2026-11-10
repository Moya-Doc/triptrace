import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TripTrace 旅行顾问",
  description: "把模糊的旅行想法画在地图上，把取舍讲清楚",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="h-full">{children}</body>
    </html>
  );
}
