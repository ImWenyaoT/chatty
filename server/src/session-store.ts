/**
 * 会话状态：存在服务端进程内存，不写入 SQLite。
 *
 * 一轮对话内有多个 await 点，并发请求会交错执行并互相覆盖 ChattyContext，
 * 所以同一 session 的请求排成一条串行链。
 */

import { createChattyContext, type ChattyContext } from "./agent/chatty.ts";

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

  /** 在 session 的串行链上排队执行，返回值与异常都透传给调用方。 */
  runExclusive<T>(session: Session, task: () => Promise<T>): Promise<T> {
    const result = session.tail.then(task, task);
    session.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
