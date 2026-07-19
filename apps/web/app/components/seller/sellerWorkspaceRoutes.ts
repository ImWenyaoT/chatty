export type SellerWorkspaceRouteKey = "playground" | "orders" | "dashboard";

type SellerWorkspaceRouteBase = {
  readonly key: SellerWorkspaceRouteKey;
  readonly href: string;
  readonly navLabel: string;
};

export const SELLER_WORKSPACE_ROUTES: readonly SellerWorkspaceRouteBase[] = [
  {
    key: "playground",
    href: "/playground",
    navLabel: "客服会话",
  },
  {
    key: "orders",
    href: "/orders",
    navLabel: "订单跟进",
  },
  {
    key: "dashboard",
    href: "/dashboard",
    navLabel: "复盘视图",
  },
] as const;
