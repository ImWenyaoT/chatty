export type SellerWorkspaceRouteKey =
  "home" | "playground" | "orders" | "dashboard";

type SellerWorkspaceRouteBase = {
  readonly key: SellerWorkspaceRouteKey;
  readonly href: string;
  readonly navLabel: string;
};

export type SellerWorkspaceHomeRoute = SellerWorkspaceRouteBase & {
  readonly homeEyebrow: string;
  readonly homeTitle: string;
  readonly homeDescription: string;
};

export type SellerWorkspaceRoute =
  SellerWorkspaceRouteBase | SellerWorkspaceHomeRoute;

export const MINIMUM_SELLER_WORKSPACE_ROUTE_KEYS = [
  "home",
  "playground",
  "orders",
] as const;

export const SELLER_WORKSPACE_ROUTES: readonly SellerWorkspaceRoute[] = [
  {
    key: "home",
    href: "/",
    navLabel: "卖家首页",
  },
  {
    key: "playground",
    href: "/playground",
    navLabel: "客服会话",
    homeEyebrow: "实时会话",
    homeTitle: "客服会话",
    homeDescription: "只处理当前客户消息、客户上下文、知识命中和下一步建议。",
  },
  {
    key: "orders",
    href: "/orders",
    navLabel: "订单跟进",
    homeEyebrow: "订单跟进",
    homeTitle: "订单跟进",
    homeDescription: "承接录单、履约进度、风险点、AI 处理证据和订单时间线。",
  },
  {
    key: "dashboard",
    href: "/dashboard",
    navLabel: "复盘视图",
    homeEyebrow: "复盘视图",
    homeTitle: "复盘视图",
    homeDescription: "查看 AI 落地指标、知识覆盖和人工 trace review 汇总。",
  },
] as const;

export const sellerWorkspaceHomeRoutes: readonly SellerWorkspaceHomeRoute[] = [
  getSellerWorkspaceHomeRoute("playground"),
  getSellerWorkspaceHomeRoute("orders"),
  getSellerWorkspaceHomeRoute("dashboard"),
];

/** Finds one seller workspace route by its stable key. */
export function getSellerWorkspaceRoute(
  key: SellerWorkspaceRouteKey,
): SellerWorkspaceRoute {
  const route = SELLER_WORKSPACE_ROUTES.find((item) => item.key === key);
  if (!route) throw new Error(`Unknown seller workspace route: ${key}`);
  return route;
}

/** Finds one seller workspace route that is safe to render as a home card. */
function getSellerWorkspaceHomeRoute(
  key: "playground" | "orders" | "dashboard",
): SellerWorkspaceHomeRoute {
  const route = getSellerWorkspaceRoute(key);
  if (
    !("homeEyebrow" in route) ||
    !("homeTitle" in route) ||
    !("homeDescription" in route)
  ) {
    throw new Error(`Seller workspace route is missing home card copy: ${key}`);
  }
  return route;
}
