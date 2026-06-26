import type { RuntimeTool, JsonValue } from '@rental/shared'
import { getProductTool, checkAvailabilityTool, getMediaTool } from './catalog-stubs.js'
import { searchProductsTool, calculatePriceTool } from './catalog-search-stubs.js'
import { getOrderHistoryTool, getOrderStatusTool } from './order-stubs.js'
import { createHandoffTool, scheduleFollowupTool, addInternalNoteTool } from './workflow-stubs.js'
import { issueRefundTool } from './refund-stub.js'
import type { Policy, PolicyContext } from '../policies/policy.js'

/**
 * Registry of runtime tools the agent loop can dispatch. Mirrors the MVP tool
 * list in PRD §11. Read-only stubs return deterministic data; high-risk tools
 * are schema-only with approvalRequired gating. A later step swaps in real
 * inventory/order/finance adapters behind the same RuntimeTool interface.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RuntimeTool>()

  register(tool: RuntimeTool): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool already registered: ${tool.name}`)
    }
    this.tools.set(tool.name, tool)
    return this
  }

  get(name: string): RuntimeTool | undefined {
    return this.tools.get(name)
  }

  list(): RuntimeTool[] {
    return [...this.tools.values()]
  }

  /** Runs a tool by name, throwing a typed error if unknown/approval-gated. */
  async invoke(name: string, args: Record<string, JsonValue>): Promise<JsonValue> {
    const tool = this.tools.get(name)
    if (!tool) throw new ToolNotFoundError(name)
    // Hard safety gate: approvalRequired tools (high risk) never auto-run.
    if (tool.approvalRequired) throw new ApprovalRequiredError(name)
    return tool.execute(args)
  }

  /**
   * Policy-gated invocation. The policy decides allow / require_approval / deny
   * BEFORE execution. require_approval/deny short-circuit with a typed error so
   * the loop can surface the decision to an operator instead of executing.
   */
  async invokeWithPolicy(
    name: string,
    args: Record<string, JsonValue>,
    policy: Policy,
    context: PolicyContext,
  ): Promise<JsonValue> {
    const tool = this.tools.get(name)
    if (!tool) throw new ToolNotFoundError(name)
    const decision = policy.check(
      { toolName: name, arguments: args, risk: tool.risk, approvalRequired: tool.approvalRequired },
      context,
    )
    if (decision.action === 'deny') throw new PolicyDenyError(name, decision.reason)
    if (decision.action === 'require_approval') throw new ApprovalRequiredError(name)
    return tool.execute(args)
  }
}

export class ToolNotFoundError extends Error {
  constructor(name: string) {
    super(`tool not found: ${name}`)
    this.name = 'ToolNotFoundError'
  }
}

export class ApprovalRequiredError extends Error {
  constructor(name: string) {
    super(`tool requires human approval: ${name}`)
    this.name = 'ApprovalRequiredError'
  }
}

export class PolicyDenyError extends Error {
  constructor(name: string, reason: string) {
    super(`policy denied tool ${name}: ${reason}`)
    this.name = 'PolicyDenyError'
  }
}

/**
 * Builds the default MVP tool registry covering all PRD §11 tools:
 * read-only catalog/order stubs + workflow stubs + schema-only high-risk tool.
 */
export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(getProductTool)
    .register(checkAvailabilityTool)
    .register(getMediaTool)
    .register(searchProductsTool)
    .register(calculatePriceTool)
    .register(getOrderHistoryTool)
    .register(getOrderStatusTool)
    .register(createHandoffTool)
    .register(scheduleFollowupTool)
    .register(addInternalNoteTool)
    .register(issueRefundTool)
}
