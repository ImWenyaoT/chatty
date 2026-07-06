import Link from 'next/link'

type SellerNavigationProps = {
  active: 'home' | 'playground' | 'orders' | 'dashboard'
}

const ITEMS = [
  { key: 'home', href: '/', label: '卖家首页' },
  { key: 'playground', href: '/playground', label: '客服会话' },
  { key: 'orders', href: '/orders', label: '订单管理' },
  { key: 'dashboard', href: '/dashboard', label: '复盘视图' },
] as const

/** Renders the seller-side route switcher restored from the old dashboard behavior. */
export function SellerNavigation({ active }: SellerNavigationProps) {
  return (
    <nav className="seller-nav" aria-label="卖家后台导航">
      <div>
        <strong>Chatty</strong>
        <span>Seller Console</span>
      </div>
      <div>
        {ITEMS.map((item) => (
          <Link
            aria-current={active === item.key ? 'page' : undefined}
            className={active === item.key ? 'active' : undefined}
            href={item.href}
            key={item.key}
          >
            {item.label}
          </Link>
        ))}
      </div>
    </nav>
  )
}
