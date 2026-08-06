/**
 * 进程内共享的运行时对象。
 *
 * Hono 时代 `createApp()` 在进程里建一次 Catalog / ModelProvider / SessionStore，
 * 所有请求共用。Next 的每个 route 文件是独立模块，共享只能靠模块级常量：
 * 一个 ES 模块在一个进程里只求值一次，这里就是那唯一一次。
 *
 * 但 dev 模式的 HMR 会重新求值模块，会话内存会跟着丢，所以把实例挂在 globalThis 上，
 * 让重新求值的模块拿回同一份对象。
 *
 * 实例是惰性建的：导出的 `catalog` / `provider` / `chatty` / `sessions` 只是转发用的
 * 引用，真正的对象要等第一次读属性时才创建。两个好处：
 * 1. import 一个 route（测试、类型生成、build 时的模块分析）不再立刻打开 SQLite、
 *    也不再读 `.env`；
 * 2. 测试可以在 route 被 import 之后再用 `__setRuntimeForTest()` 换掉其中几个字段，
 *    route 侧的 import 形态完全不用改。
 */

import { Chatty, type ChattyAgent } from "../agent/lib/chatty.ts";
import {
  ResponsesModelProvider,
  type ModelProvider,
} from "../agent/lib/model-provider.ts";
import { Catalog } from "../data/catalog.ts";
import { SessionStore } from "./session-store.ts";
import { loadSettings } from "./settings.ts";

export type ChattyRuntime = {
  catalog: Catalog;
  provider: ModelProvider;
  chatty: ChattyAgent;
  sessions: SessionStore;
};

function createRuntime(): ChattyRuntime {
  // Catalog 默认建在 :memory:，种子从默认 DATA_DIR 读。
  const catalog = new Catalog();
  const provider = new ResponsesModelProvider(loadSettings());
  return {
    catalog,
    provider,
    chatty: new Chatty(catalog, provider),
    sessions: new SessionStore(),
  };
}

const cache = globalThis as typeof globalThis & {
  __chattyRuntime?: ChattyRuntime | undefined;
  __chattyRuntimeOverrides?: Partial<ChattyRuntime> | undefined;
};

/** 单个字段的当前实现：测试覆盖优先，否则用进程内单例。 */
function resolve<K extends keyof ChattyRuntime>(key: K): ChattyRuntime[K] {
  const override = cache.__chattyRuntimeOverrides?.[key];
  if (override !== undefined) return override;
  return (cache.__chattyRuntime ??= createRuntime())[key];
}

/**
 * 把字段转成一个转发引用，读属性时才去 `resolve()` 拿真实对象。
 *
 * 方法必须绑回真实实例：Catalog / SessionStore 用了 `#private` 字段，
 * 以 Proxy 作为 receiver 调用会直接抛 TypeError。
 */
function lazyRef<K extends keyof ChattyRuntime>(key: K): ChattyRuntime[K] {
  const handler: ProxyHandler<object> = {
    get(_target, property) {
      const instance = resolve(key) as Record<string | symbol, unknown>;
      const value = instance[property];
      return typeof value === "function" ? value.bind(instance) : value;
    },
  };
  return new Proxy({}, handler) as unknown as ChattyRuntime[K];
}

export const catalog = lazyRef("catalog");
export const provider = lazyRef("provider");
export const chatty = lazyRef("chatty");
export const sessions = lazyRef("sessions");

/**
 * 仅供测试：替换部分运行时字段，返回还原函数。
 *
 * `node --test` 把多个测试文件跑在同一个进程里，所以每个用例都必须在 finally 里
 * 调还原函数，否则会污染后面的文件。
 */
export function __setRuntimeForTest(
  overrides: Partial<ChattyRuntime>,
): () => void {
  const previous = cache.__chattyRuntimeOverrides;
  cache.__chattyRuntimeOverrides = { ...previous, ...overrides };
  return () => {
    cache.__chattyRuntimeOverrides = previous;
  };
}
