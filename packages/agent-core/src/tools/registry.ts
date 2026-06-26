import type { RuntimeTool, JsonValue } from '@rental/shared'
import { getProductTool, checkAvailabilityTool, getMediaTool } from './catalog-stubs.js'

/**
 * Registry of runtime tools the agent loop can dispatch. Mirrors the MVP tool
 * list in PRD §11. Step 4 ships read-only stubs that return deterministic
 * catalog data; a later step can swap in real inventory/order adapters behind
 * the same RuntimeTool interface.
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

  /** Runs a tool by name, throwing a typed error if it is unknown/disallowed. */
  async invoke(name: string, args: Record<string, JsonValue>): Promise<JsonValue> {
    const tool = this.tools.get(name)
    if (!tool) throw new ToolNotFoundError(name)
    // MVP safety: only read-only (low/medium risk, no approval) tools may run
    // inside a single bounded request step (PRD §11 Tool Safety).
    if (tool.approvalRequired) throw new ApprovalRequiredError(name)
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

/**
 * Builds the default MVP tool registry with read-only stubs sourced from
 * rag-service/config/catalog.yaml. Callers can extend this with real adapters.
 */
export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(getProductTool)
    .register(checkAvailabilityTool)
    .register(getMediaTool)
}
