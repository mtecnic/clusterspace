/**
 * Safe evaluator for the `json_predicate` success criterion. No eval,
 * Function, or VM sandbox anywhere — the grammar is small and whitelisted
 * on purpose. Safe specifically because `expr` is human-authored at goal
 * creation time (GoalCreateDialog), the same trust tier as the `shell`
 * criterion's command, which already runs arbitrary shell — never
 * model-supplied at runtime.
 *
 * Grammar: `<dot.path.into.json> <op> <json-literal>`
 * op ∈ { ==, !=, >, <, >=, <=, exists, notexists }
 * Examples: `data.status == "complete"`, `build.errorCount == 0`,
 *           `output.manifest exists`
 */

const OPERATORS = ['>=', '<=', '==', '!=', '>', '<', 'notexists', 'exists'] as const
type Operator = typeof OPERATORS[number]

export interface JsonPredicateResult {
  verified: boolean
  detail: string
}

function getPath(data: unknown, path: string): { found: boolean; value: unknown } {
  let current = data
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || !(segment in (current as Record<string, unknown>))) {
      return { found: false, value: undefined }
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return { found: true, value: current }
}

function compare(op: Operator, actual: unknown, expected: unknown): boolean {
  switch (op) {
    case '==': return actual === expected
    case '!=': return actual !== expected
    case '>': return typeof actual === 'number' && typeof expected === 'number' && actual > expected
    case '<': return typeof actual === 'number' && typeof expected === 'number' && actual < expected
    case '>=': return typeof actual === 'number' && typeof expected === 'number' && actual >= expected
    case '<=': return typeof actual === 'number' && typeof expected === 'number' && actual <= expected
    default: return false
  }
}

export function evaluateJsonPredicate(data: unknown, expr: string): JsonPredicateResult {
  const trimmed = expr.trim()

  // exists / notexists: "<path> exists" — no literal operand.
  const existsMatch = trimmed.match(/^(\S+)\s+(exists|notexists)$/)
  if (existsMatch) {
    const [, path, op] = existsMatch
    const { found } = getPath(data, path)
    const verified = op === 'exists' ? found : !found
    return { verified, detail: `${path} ${op}: ${found ? 'present' : 'absent'} in ${JSON.stringify(data).slice(0, 200)}` }
  }

  // Comparison ops — longest-first so ">=" isn't mis-split as ">" + "=".
  const compareOps: Operator[] = ['>=', '<=', '==', '!=', '>', '<']
  for (const op of compareOps) {
    const idx = trimmed.indexOf(op)
    if (idx === -1) continue
    const path = trimmed.slice(0, idx).trim()
    const literalText = trimmed.slice(idx + op.length).trim()
    if (!path || !literalText) continue

    let literal: unknown
    try {
      literal = JSON.parse(literalText)
    } catch {
      return { verified: false, detail: `right-hand side "${literalText}" is not a valid JSON literal (use quotes for strings, e.g. == "complete")` }
    }

    const { found, value } = getPath(data, path)
    if (!found) {
      return { verified: false, detail: `path "${path}" not found in the JSON` }
    }
    const verified = compare(op, value, literal)
    return { verified, detail: `${path} = ${JSON.stringify(value)}, expected ${op} ${literalText} -> ${verified}` }
  }

  return {
    verified: false,
    detail: `could not parse expression "${expr}" — expected "<dot.path> <op> <literal>" with op one of ${OPERATORS.join(', ')}`
  }
}
