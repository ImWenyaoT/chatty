/**
 * 把 catalog 里声明的组件名绑到真实 React 组件。
 *
 * catalog 声明「允许渲染什么」，registry 声明「用哪个组件渲染」。两者分开之后，
 * 换实现不用动约束，加约束也不用动实现。
 *
 * json-render 传给渲染器的是 `{ element, emit, on, ... }`，真实 props 在
 * `element.props` 里。这里做一层展开，让业务组件保持普通 React 组件——
 * 它们不感知 json-render，可以单独测试、也可以脱离 spec 直接用。
 */

import { createRenderer } from "@json-render/react";

import { chattyCatalog } from "./catalog.ts";
import ProductCard from "./ProductCard.tsx";
import ProductTable from "./ProductTable.tsx";

export const ChattyRenderer = createRenderer(chattyCatalog, {
  product_card: ({ element }) => <ProductCard {...element.props} />,
  product_table: ({ element }) => <ProductTable {...element.props} />,
  stack: ({ children }) => <>{children}</>,
});
