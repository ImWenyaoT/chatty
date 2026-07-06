import Link from 'next/link'
import { SELLER_WORKSPACE_ROUTES, type SellerWorkspaceRouteKey } from './sellerWorkspaceRoutes'

type SellerNavigationProps = {
  active: SellerWorkspaceRouteKey
}

/** Renders the seller-side route switcher from the shared Seller Workspace route catalog. */
export function SellerNavigation({ active }: SellerNavigationProps) {
  return (
    <nav className="seller-nav" aria-label="卖家后台导航">
      <div>
        <strong>Chatty</strong>
        <span>Seller Console</span>
      </div>
      <div>
        {SELLER_WORKSPACE_ROUTES.map((item) => (
          <Link
            aria-current={active === item.key ? 'page' : undefined}
            className={active === item.key ? 'active' : undefined}
            href={item.href}
            key={item.key}
          >
            {item.navLabel}
          </Link>
        ))}
      </div>
    </nav>
  )
}
