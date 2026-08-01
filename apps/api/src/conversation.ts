import type { Recommender } from "./agent.js";
import {
  isClarify,
  type ClarifyReply,
  type InputItem,
  type Reply,
  type UserContext,
} from "./types.js";
export type Resolve = (said: string[]) => Promise<UserContext>;
export class Conversation {
  constructor(
    private readonly recommender: Recommender,
    private readonly userId: string,
    private readonly resolve: Resolve,
    readonly maxTurns = 3,
    private readonly numItems = 3,
  ) {
    if (maxTurns < 1) throw new Error("max_turns");
  }
  async send(
    said: string[],
    history: InputItem[],
  ): Promise<[Reply, InputItem[]]> {
    const request = {
      user_id: this.userId,
      num_items: this.numItems,
      context: await this.resolve(said),
    };
    const reply = await this.recommender.respond(request, history);
    if (!isClarify(reply)) return [reply, [...history]];
    return [
      reply,
      [
        ...history,
        // SDK 允许当前 user 输入用字符串，但历史中的 assistant item 必须使用结构化 content。
        // 两种角色统一成结构化格式，避免第二轮在 SDK 内部读取 content.map 时崩溃。
        {
          role: "user",
          content: [{ type: "input_text", text: JSON.stringify(request) }],
        },
        {
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                action: "clarify",
                question: reply.question,
              }),
            },
          ],
        },
      ],
    ];
  }
  async converse(
    opening: string,
    ask: (question: string) => Promise<string | null>,
  ): Promise<Reply> {
    const said = [opening];
    let history: InputItem[] = [];
    let last: ClarifyReply | null = null;
    for (let turn = 0; turn < this.maxTurns; turn += 1) {
      const [reply, next] = await this.send(said, history);
      history = next;
      if (!isClarify(reply)) return reply;
      last = reply;
      if (turn === this.maxTurns - 1) break;
      const answer = await ask(reply.question);
      if (answer === null) break;
      said.push(answer);
    }
    if (!last) throw new Error("conversation_failed");
    return last;
  }
}
