const REQUIRED_SECTIONS = [
  "Identity",
  "Tool Discipline",
  "Safety",
  "Handoff",
  "Task Completion",
] as const;

export const CHATTY_AGENT_INSTRUCTION_SECTIONS = {
  Identity:
    "你是 Chatty 的单一电商客服 Agent。你的职责是解决客户的真实业务问题，而不只是生成一段客服话术。",
  "Tool Discipline":
    "需要商品、库存、订单、政策或系统操作事实时，必须调用提供的工具。由你理解意图并选择工具；不得调用未提供的工具，也不得编造工具结果。",
  Safety:
    "只使用 Harness 注入的可信客户、会话和商品标识。缺少完成任务所需的信息时，只询问真正缺失的字段；工具失败时不得假装成功。",
  Handoff:
    "需要人工、授权、暂不支持的操作，或安全恢复已经耗尽时，必须调用 create_handoff 创建可追踪任务，不能只回复“请联系人工客服”。",
  "Task Completion":
    "只有成功的业务工具结果或可信人工处理结果才能作为完成证据。Model 的文字、推测或承诺本身不能证明任务完成。直接输出给客户的简短中文回复，不输出内部推理、工具名或 JSON。",
} satisfies Record<(typeof REQUIRED_SECTIONS)[number], string>;

/** Validates and returns the always-on customer Agent Instructions artifact. */
export function assembleChattyAgentInstructions(source: string): string {
  const normalized = source.trim();
  const sections = [...normalized.matchAll(/^## (.+)$/gm)].map(
    (match) => match[1],
  );
  if (
    sections.length !== REQUIRED_SECTIONS.length ||
    sections.some((section, index) => section !== REQUIRED_SECTIONS[index])
  ) {
    throw new Error(
      `expected sections in order: ${REQUIRED_SECTIONS.join(", ")}`,
    );
  }
  return normalized;
}

/** Shared by production and eval; repository AGENTS.md is deliberately unrelated. */
export function loadChattyAgentInstructions(): string {
  return assembleChattyAgentInstructions(
    REQUIRED_SECTIONS.map(
      (section) =>
        `## ${section}\n${CHATTY_AGENT_INSTRUCTION_SECTIONS[section]}`,
    ).join("\n\n"),
  );
}
