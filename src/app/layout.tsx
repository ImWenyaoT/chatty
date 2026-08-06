import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Chatty",
  description: "面向电商推荐与政策问答的中文 Single Agent",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
