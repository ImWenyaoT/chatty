import type { FailureCaseCandidate } from './failure-case-policy.js'

/**
 * Output shape of a golden export: the raw YAML text plus the filename a caller
 * should write it to. The serializer never touches the filesystem (apps/web or
 * a CLI writes the file); this keeps agent-core dependency-free.
 */
export interface GoldenExport {
  filename: string
  yaml: string
}

/**
 * Escapes a string for safe YAML scalar use: wraps in double quotes when the
 * value contains characters that would otherwise break YAML parsing (:, #, leading
 * dash, etc.). Plain Chinese text without those chars stays unquoted for readability.
 */
function yamlScalar(value: string): string {
  if (!value) return '""'
  if (/[:#\-?\[\]{},&*!|>'"%@`\n]/.test(value) || /^\s|\s$/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return value
}

/**
 * Serializes a failure-case candidate into a single-step golden test in the
 * legacy golden YAML schema (rag-service/tests/golden/*.yaml). The exported
 * case re-runs the original failing input and asserts the reply no longer
 * contains the issues that caused the low score, with a minScore guard.
 *
 * The caller is responsible for writing the returned yaml to
 * rag-service/tests/golden/regression/<filename>. This function is pure.
 */
export function exportFailureCaseToGoldenYaml(fc: FailureCaseCandidate): GoldenExport {
  const inputObj = fc.input as { question?: string } | null
  const outputObj = fc.output as { reply?: string } | null
  const user = inputObj?.question ?? ''
  const reply = outputObj?.reply ?? ''
  const safeName = fc.traceId.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()
  const filename = `regression-${safeName}.yaml`

  // Build the notContains section so it stays valid YAML in both shapes:
  //   issues present -> a block sequence under the key
  //   issues empty   -> an inline empty list on the key line
  // minScore is always emitted as the next sibling key at the same indent.
  const notContainsSection =
    fc.issues.length > 0
      ? ['      notContains:', ...fc.issues.map((issue) => `      - ${yamlScalar(issue)}`)].join('\n')
      : '      notContains: []'

  const yaml = `name: regression-${safeName}
description: 自动从低分 trace ${fc.traceId} 导出的回归用例（score=${fc.score}）
customerId: golden-regression-${safeName}
steps:
  - user: ${yamlScalar(user)}
    expect:
${notContainsSection}
      minScore: 6
# original reply was: ${yamlScalar(reply)}
# original score: ${fc.score}
`

  return { filename, yaml }
}
