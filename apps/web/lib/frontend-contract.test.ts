import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SELLER_WORKSPACE_ROUTES } from "../src/components/seller/sellerWorkspaceRoutes";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Reads a web app source file for lightweight UI contract assertions. */
function readAppSource(path: string) {
  return readFileSync(resolve(appRoot, path), "utf8");
}

const appSource = readAppSource("src/App.tsx");
const mainSource = readAppSource("src/main.tsx");
const dashboardSource = readAppSource("src/pages/DashboardPage.tsx");
const ordersSource = readAppSource("src/pages/OrdersPage.tsx");
const playgroundSource = readAppSource("src/pages/PlaygroundPage.tsx");
const cssSource = readAppSource("src/globals.css");
const webPackageSource = readAppSource("package.json");
const viteConfigSource = readAppSource("vite.config.ts");
test("web runtime contains only the thin Vite React application", () => {
  const webPackage = JSON.parse(webPackageSource) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };

  for (const script of ["dev", "build", "start"])
    assert.match(webPackage.scripts?.[script] ?? "", /vite/);
  assert.equal(webPackage.dependencies?.next, undefined);
  assert.equal(webPackage.devDependencies?.["eslint-config-next"], undefined);
  assert.equal(webPackage.dependencies?.["better-sqlite3"], undefined);
  assert.equal(webPackage.dependencies?.["@rental/db"], undefined);
});

test("frontend shell exposes keyboard and screen-reader navigation affordances", () => {
  assert.match(appSource, /className="skip-link"/);
  assert.match(appSource, /href="#main-content"/);
  assert.match(dashboardSource, /id="main-content"/);
  assert.match(ordersSource, /id="main-content"/);
  assert.match(playgroundSource, /id="main-content"/);
  assert.match(playgroundSource, /role="status"/);
  assert.match(playgroundSource, /role="log"/);
  assert.match(playgroundSource, /aria-busy=\{sending\}/);
});

test("playground controls expose state beyond color alone", () => {
  assert.match(playgroundSource, /aria-label="发送客户消息"/);
  assert.match(playgroundSource, /aria-label="客户消息"/);
  assert.match(playgroundSource, /<h1>客服会话<\/h1>/);
  assert.match(
    playgroundSource,
    /className="support-layout support-layout-thin"/,
  );
  assert.match(playgroundSource, /className="support-composer-box"/);
  assert.match(playgroundSource, /aria-label="发送"/);
});

test("playground is a thin FastAPI client with session continuity", () => {
  assert.match(playgroundSource, /API_BASE_URL = "\/api\/chatty"/);
  assert.match(playgroundSource, /`\$\{API_BASE_URL\}\/runs`/);
  assert.match(playgroundSource, /session_id: sessionId/);
  assert.match(playgroundSource, /setSessionId\(payload\.session_id\)/);
  assert.match(playgroundSource, /setTraceId\(payload\.trace_id\)/);
  assert.match(playgroundSource, /role="alert"/);
  assert.doesNotMatch(playgroundSource, /@rental\//);
  assert.doesNotMatch(playgroundSource, /\/api\/playground/);
  assert.doesNotMatch(playgroundSource, /controlPlane/);
});

test("browser calls FastAPI through the same-origin Vite proxy", () => {
  assert.match(viteConfigSource, /"\/api\/chatty"/);
  assert.match(viteConfigSource, /process\.env\.CHATTY_API_TARGET/);
  assert.match(viteConfigSource, /"http:\/\/127\.0\.0\.1:8000"/);
  assert.match(viteConfigSource, /target: chattyApiTarget/);
  assert.match(viteConfigSource, /replace\(\/\^\\\/api\\\/chatty\//);
  assert.match(viteConfigSource, /strictPort: true/);
  assert.equal(viteConfigSource.match(/proxy: chattyApiProxy/g)?.length, 2);
});

test("frontend CSS keeps focus visible and mobile touch targets large enough", () => {
  assert.match(cssSource, /\.skip-link/);
  assert.match(cssSource, /:focus-visible/);
  assert.match(cssSource, /box-shadow: var\(--focus-ring\)/);
  assert.match(cssSource, /min-height: 44px/);
  assert.match(cssSource, /\.support-composer-box:focus-within/);
  assert.match(
    cssSource,
    /@media \(max-width: 620px\)[\s\S]*\.support-send-button/,
  );
  assert.doesNotMatch(
    cssSource,
    /support-(detail-panel|search|conversation-list)/,
  );
});

test("customer service workspace follows the system color scheme", () => {
  assert.match(cssSource, /@media \(prefers-color-scheme: dark\)[\s\S]*:root/);
  assert.match(cssSource, /:root \{[\s\S]*color-scheme: dark;/);
  assert.match(cssSource, /--accent: #78a68e/);
  assert.match(cssSource, /\.support-message\.user \.support-message-content/);
  assert.match(cssSource, /\.support-context-section/);
  assert.doesNotMatch(cssSource, /\.support-risk/);
});

test("seller workspace exposes exactly the three retained pages", () => {
  assert.deepEqual(
    SELLER_WORKSPACE_ROUTES.map((route) => [
      route.key,
      route.href,
      route.navLabel,
    ]),
    [
      ["playground", "/playground", "客服会话"],
      ["orders", "/orders", "订单跟进"],
      ["dashboard", "/dashboard", "复盘视图"],
    ],
  );
  assert.match(mainSource, /window\.location\.replace\("\/playground"\)/);
});

test("customer service workspace keeps product language with technical observability", () => {
  assert.equal(
    SELLER_WORKSPACE_ROUTES.find((route) => route.key === "playground")
      ?.navLabel,
    "客服会话",
  );
  assert.match(playgroundSource, /<h1>客服会话<\/h1>/);
  assert.match(playgroundSource, /className="support-composer-box"/);
  assert.match(playgroundSource, /className="support-send-button"/);
  assert.match(playgroundSource, /运行详情/);
  assert.doesNotMatch(playgroundSource, /className="legacy-inspector"/);
  assert.doesNotMatch(playgroundSource, /className="service-context-panel"/);
  assert.doesNotMatch(playgroundSource, /<h2>客户上下文<\/h2>/);
  assert.doesNotMatch(playgroundSource, /<h2>知识命中<\/h2>/);
  assert.doesNotMatch(playgroundSource, /<h2>订单待办<\/h2>/);
  assert.doesNotMatch(playgroundSource, /会话配置/);
  assert.doesNotMatch(playgroundSource, /高级设置/);
  assert.doesNotMatch(playgroundSource, /前端调试/);
  assert.doesNotMatch(playgroundSource, /开发调试/);
  assert.doesNotMatch(playgroundSource, /本轮复核/);
  assert.doesNotMatch(playgroundSource, /固定测试/);
});

test("dashboard is a thin FastAPI client for real local traces", () => {
  assert.match(dashboardSource, /API_BASE_URL = "\/api\/chatty"/);
  assert.match(dashboardSource, /fetch\(`\$\{API_BASE_URL\}\/traces`/);
  assert.match(
    dashboardSource,
    /fetch\(`\$\{API_BASE_URL\}\/traces\/\$\{selectedId\}`/,
  );
  assert.match(dashboardSource, /正在读取 Trace/);
  assert.match(dashboardSource, /暂无 Agent Run/);
  assert.match(dashboardSource, /role="alert"/);
  assert.match(dashboardSource, /Model \/ Tool spans/);
  assert.match(dashboardSource, /业务完成证据/);
  assert.match(dashboardSource, /Handoff receipt/);
  assert.doesNotMatch(dashboardSource, /@rental\//);
  assert.doesNotMatch(dashboardSource, /getRepos/);
  assert.doesNotMatch(dashboardSource, /control-plane/);
  assert.doesNotMatch(dashboardSource, /Background Jobs/);
  assert.doesNotMatch(dashboardSource, /heartbeat|checkpoint|lease|outbox/i);
  assert.doesNotMatch(dashboardSource, /SELLER_ORDERS|productMetrics/);
});

test("orders page is a thin FastAPI client for SQLite orders and events", () => {
  const visibleOrderCopy = [
    dashboardSource,
    ordersSource,
    JSON.stringify(SELLER_WORKSPACE_ROUTES),
  ]
    .join("\n")
    .replaceAll(/\/\*[\s\S]*?\*\//g, "");

  assert.doesNotMatch(visibleOrderCopy, /订单管理/);
  assert.match(visibleOrderCopy, /订单跟进/);
  assert.match(ordersSource, /aria-label="搜索订单"/);
  assert.match(ordersSource, /<h3>订单时间线<\/h3>/);
  assert.match(ordersSource, /API_BASE_URL = "\/api\/chatty"/);
  assert.match(ordersSource, /fetch\(`\$\{API_BASE_URL\}\/orders`/);
  assert.match(ordersSource, /role="status"/);
  assert.match(ordersSource, /role="alert"/);
  assert.match(ordersSource, /暂无订单/);
  assert.match(ordersSource, /selected\.events\.map/);
  assert.doesNotMatch(ordersSource, /SELLER_ORDERS/);
  assert.doesNotMatch(ordersSource, /orderData/);
  assert.doesNotMatch(ordersSource, /@rental\/db/);
  assert.doesNotMatch(playgroundSource, /fetch\(["']\/api\/orders\/place["']/);
  assert.doesNotMatch(playgroundSource, /提交订单号，标记已下单/);
});

test("review dashboard copy avoids generic backend-dashboard language", () => {
  const visibleShellCopy = [
    mainSource,
    dashboardSource,
    JSON.stringify(SELLER_WORKSPACE_ROUTES),
  ].join("\n");
  assert.doesNotMatch(visibleShellCopy, /后台视图/);
  assert.doesNotMatch(visibleShellCopy, /后台观察/);
  assert.doesNotMatch(visibleShellCopy, /智能客服后台/);
  assert.match(dashboardSource, /SQLite Trace/);
  assert.doesNotMatch(visibleShellCopy, /AI 落地指标|演示订单样本/);
  assert.match(visibleShellCopy, /复盘视图/);
});
