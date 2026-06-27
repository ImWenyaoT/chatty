import { playbookSchema, type Playbook } from './playbook.js'

/**
 * Loads and validates a Playbook from an already-parsed object (POJO). We accept
 * an object rather than a YAML string so agent-core stays dependency-free; the
 * caller is responsible for yaml->object conversion (e.g. via rag-service yaml).
 * Throws a ZodError on shape mismatch.
 */
export function loadPlaybook(obj: unknown): Playbook {
  return playbookSchema.parse(obj)
}

/**
 * Validates a list of raw playbook objects; returns only the valid ones so a
 * single malformed playbook does not break the whole registry load.
 */
export function loadPlaybooks(list: unknown[]): Playbook[] {
  const valid: Playbook[] = []
  for (const item of list) {
    const parsed = playbookSchema.safeParse(item)
    if (parsed.success) valid.push(parsed.data)
  }
  return valid
}
