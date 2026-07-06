export type SellerWorkspaceRouteKey = 'home' | 'playground' | 'orders' | 'dashboard'

export type SellerWorkspaceRoute = {
  readonly key: SellerWorkspaceRouteKey
  readonly href: string
  readonly navLabel: string
  readonly homeEyebrow?: string
  readonly homeTitle?: string
  readonly homeDescription?: string
}

export const MINIMUM_SELLER_WORKSPACE_ROUTE_KEYS = ['home', 'playground', 'orders'] as const

export const SELLER_WORKSPACE_ROUTES: readonly SellerWorkspaceRoute[] = [
  {
    key: 'home',
    href: '/',
    navLabel: '卖家首页',
  },
  {
    key: 'playground',
    href: '/playground',
    navLabel: '客服会话',
    homeEyebrow: '实时会话',
    homeTitle: '客服会话',
    homeDescription: '客户信息、会话记录、订单状态和手动录单放在同一工作流里。',
  },
  {
    key: 'orders',
    href: '/orders',
    navLabel: '订单管理',
    homeEyebrow: '订单运营',
    homeTitle: '订单管理',
    homeDescription: '订单列表、订单详情、履约进度、手动录单表单。',
  },
  {
    key: 'dashboard',
    href: '/dashboard',
    navLabel: '复盘视图',
    homeEyebrow: '复盘视图',
    homeTitle: 'Trace Review',
    homeDescription: '查看知识覆盖、样例会话和人工 trace review 汇总，用来复盘 agent 行为。',
  },
] as const

export const sellerWorkspaceHomeRoutes = SELLER_WORKSPACE_ROUTES.filter(
  (route) => route.key !== 'home',
)

/** Finds one seller workspace route by its stable key. */
export function getSellerWorkspaceRoute(key: SellerWorkspaceRouteKey): SellerWorkspaceRoute {
  const route = SELLER_WORKSPACE_ROUTES.find((item) => item.key === key)
  if (!route) throw new Error(`Unknown seller workspace route: ${key}`)
  return route
}
