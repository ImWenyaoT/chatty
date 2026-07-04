'use client'

import { useMemo, useState } from 'react'
import { SellerNavigation } from '../components/seller/SellerNavigation'
import { SELLER_ORDERS, type SellerOrder } from '../components/seller/orderData'

const FULFILLMENT_STEPS = ['录单', '复核', '备货', '发货', '签收', '归还', '完成']

/** Picks the active fulfillment step for the order management progress board. */
function stepState(order: SellerOrder, index: number): 'done' | 'active' | 'todo' {
  const activeIndex =
    order.status === '待复核'
      ? 1
      : order.status === '待发货'
        ? 2
        : order.status === '租赁中'
          ? 5
          : 6
  if (index < activeIndex) return 'done'
  if (index === activeIndex) return 'active'
  return 'todo'
}

/** Restores the seller order-management page as a separate route from the chat console. */
export default function OrdersPage() {
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState(SELLER_ORDERS[0].id)
  const selected = SELLER_ORDERS.find((order) => order.id === selectedId) ?? SELLER_ORDERS[0]
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return SELLER_ORDERS
    return SELLER_ORDERS.filter((order) =>
      [order.id, order.customer, order.product, order.status].some((value) =>
        value.toLowerCase().includes(q),
      ),
    )
  }, [query])

  return (
    <main className="orders-page">
      <SellerNavigation active="orders" />
      <header className="orders-header">
        <div>
          <p>ORDER OPS · 演示数据</p>
          <h1>订单管理</h1>
        </div>
      </header>

      <div className="orders-layout">
        <aside className="orders-list">
          <div className="orders-filter">
            <input
              aria-label="搜索订单"
              placeholder="搜索订单号 / 客户 / 商品"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button type="button" onClick={() => setQuery('')}>
              重置
            </button>
          </div>
          <div className="order-row-list">
            {filtered.map((order) => (
              <button
                className={`order-row ${order.id === selected.id ? 'active' : ''}`}
                key={order.id}
                type="button"
                onClick={() => setSelectedId(order.id)}
              >
                <div>
                  <strong>{order.id}</strong>
                  <span>{order.status}</span>
                </div>
                <p>{order.product}</p>
                <div className="order-row-meta">
                  <span>{order.customer}</span>
                  <span>{order.updatedAt}</span>
                </div>
              </button>
            ))}
          </div>
        </aside>

        <section className="order-detail">
          <div className="order-detail-head">
            <div>
              <p>
                {selected.channel} · {selected.customer}
              </p>
              <h2>{selected.id}</h2>
            </div>
            <span>{selected.status}</span>
          </div>

          <div className="order-kpis">
            <div>
              <span>商品</span>
              <strong>{selected.product}</strong>
            </div>
            <div>
              <span>档期</span>
              <strong>{selected.period}</strong>
            </div>
            <div>
              <span>尺码</span>
              <strong>{selected.size}</strong>
            </div>
            <div>
              <span>金额</span>
              <strong>{selected.amount}</strong>
            </div>
          </div>

          <div className="order-sections">
            <section>
              <h3>客户与订单信息</h3>
              <div className="info-list">
                <div>
                  <span>客户</span>
                  <strong>{selected.customer}</strong>
                </div>
                <div>
                  <span>地址</span>
                  <strong>{selected.address}</strong>
                </div>
                <div>
                  <span>风险</span>
                  <strong>{selected.risk}</strong>
                </div>
              </div>
            </section>
          </div>

          <section className="fulfillment-board">
            <h3>履约进度</h3>
            <div className="fulfillment-steps">
              {FULFILLMENT_STEPS.map((step, index) => (
                <div data-state={stepState(selected, index)} key={step}>
                  <span />
                  {step}
                </div>
              ))}
            </div>
          </section>

          <section className="order-timeline">
            <h3>订单时间线</h3>
            <ol>
              {selected.timeline.map((item) => (
                <li key={`${selected.id}-${item.time}-${item.event}`}>
                  <strong>{item.time}</strong>
                  {item.event}
                </li>
              ))}
            </ol>
          </section>
        </section>
      </div>
    </main>
  )
}
