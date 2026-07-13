import type { ReactNode } from "react";
import "./globals.css";

// 系统字体栈（见 globals.css 的 --font-sans / --font-mono）：CJK 用系统中文字体
// 原生渲染，latin/数字/harness 遥测用系统 sans/mono。零 web font 下载与 preload——
// 本应用以中文为主，任何 latin-only web font 对正文无益，而 CJK web font 体积过大。

export const metadata = {
  title: "Chatty · 租衣客服",
  description: "Agentic customer-service concierge for rental commerce.",
};

export const viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

/** 根布局：正文字体由 globals.css 的系统字体栈提供，无需注入 web font 变量。 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh">
      <body>
        <a className="skip-link" href="#main-content">
          跳到主要内容
        </a>
        {children}
      </body>
    </html>
  );
}
