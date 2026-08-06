/**
 * 会话状态：存在服务端进程内存，不写入 SQLite。
 *
 * 一轮对话内有多个 await 点，并发请求会交错执行并互相覆盖 ChattyContext，
 * 所以同一 session 的请求排成一条串行链。
 */

import {
  createChattyContext,
  type ChattyContext,
} from "../agent/lib/chatty.ts";

type Session = {
  userId: string;
  context: ChattyContext;
  // tail 是这个 session 上一次处理的完成信号。
  tail: Promise<void>;
};

export class SessionStore {
  readonly #sessions = new Map<string, Session>();

  create(userId: string): string {
    const id = `session_${crypto.randomUUID().replaceAll("-", "")}`;
    this.#sessions.set(id, {
      userId,
      context: createChattyContext(),
      tail: Promise.resolve(),
    });
    return id;
  }

  get(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  /**
   * 在 session 的串行链上排队执行，返回值与异常都透传给调用方。
   *
   * 这里不能写成先 `await session.tail` 再赋值新的 tail：两次并发调用会在
   * await 处双双让出，然后同时往下走，串行就没了。所以必须同步接链。
   * `.then(task, task)` 的两个参数是同一个函数，意思是上一轮无论成功还是
   * 失败，这一轮都照常执行。
   */
  runExclusive<T>(session: Session, task: () => Promise<T>): Promise<T> {
    const result = session.tail.then(task, task);
    // 新的 tail 只关心「上一轮结束了没有」，不关心结果，所以把成败都抹平。
    session.tail = result.then(ignoreResult, ignoreResult);
    return result;
  }
}

function ignoreResult(): void {}
