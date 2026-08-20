/**
 * Structured classification for AI-provider errors — ai-manager.ts's three
 * catch blocks and two HTTP-error throw sites previously just wrapped
 * everything in a flat `Error(message)`; the HTTP status was available at
 * the throw site but discarded into a string, never inspected by any
 * caller. Against a local vLLM/Qwen endpoint in particular, a context-
 * overflow error is currently indistinguishable from a network blip or an
 * auth failure — this makes that distinction available so callers (and,
 * eventually, an automatic compaction-and-retry path) can react to a kind
 * of failure instead of an opaque string.
 *
 * `isRetryable` is derived from `kind`, not stored as an independent flag —
 * ramp's own error/classifier.py notes a prior bug where a separate
 * per-instance retryable flag drifted out of sync with the kind and got
 * silently ignored. Single source of truth here for the same reason.
 */

export type ErrorKind =
  | 'rate_limit'
  | 'auth'
  | 'context_overflow'
  | 'network'
  | 'timeout'
  | 'provider_error'
  | 'unknown'

const RETRYABLE_KINDS: ReadonlySet<ErrorKind> = new Set<ErrorKind>(['rate_limit', 'network', 'timeout', 'provider_error'])

export function isRetryableKind(kind: ErrorKind): boolean {
  return RETRYABLE_KINDS.has(kind)
}

export interface ClassifiedError {
  kind: ErrorKind
  message: string
  httpStatus?: number
}

export class ClassifiedAIError extends Error {
  kind: ErrorKind
  httpStatus?: number
  constructor(classified: ClassifiedError) {
    super(classified.message)
    this.name = 'ClassifiedAIError'
    this.kind = classified.kind
    this.httpStatus = classified.httpStatus
  }
}

// Providers phrase "your context is too long" completely differently
// (vLLM/llama.cpp/OpenAI-compatible servers all vary) and rarely with a
// distinct HTTP status, so this has to be substring matching, not a status
// code check.
const CONTEXT_OVERFLOW_PATTERN = /context.length|maximum context|context_length_exceeded|too many tokens|token limit|reduce the length/i

/**
 * Classify an HTTP-level failure (non-2xx response). `responseText` is the
 * raw body — checked for context-overflow phrasing before falling back to
 * status-code-based classification, since a provider can return a 400 for
 * context overflow just as easily as for a malformed request.
 */
export function classifyHttpError(httpStatus: number, responseText: string): ClassifiedError {
  const message = `HTTP ${httpStatus}: ${responseText}`
  if (CONTEXT_OVERFLOW_PATTERN.test(responseText)) {
    return { kind: 'context_overflow', message, httpStatus }
  }
  if (httpStatus === 429) return { kind: 'rate_limit', message, httpStatus }
  if (httpStatus === 401 || httpStatus === 403) return { kind: 'auth', message, httpStatus }
  if (httpStatus >= 500) return { kind: 'provider_error', message, httpStatus }
  return { kind: 'unknown', message, httpStatus }
}

/**
 * Classify a thrown JS error (network failure, abort/timeout, or anything
 * already wrapped by classifyHttpError and re-thrown as a plain Error one
 * layer up — re-classified from its message in that case, since the
 * ClassifiedError itself doesn't survive a throw/catch round-trip unless
 * it's a ClassifiedAIError already).
 */
export function classifyError(error: unknown): ClassifiedError {
  if (error instanceof ClassifiedAIError) {
    return { kind: error.kind, message: error.message, httpStatus: error.httpStatus }
  }
  const message = error instanceof Error ? error.message : String(error)
  if (CONTEXT_OVERFLOW_PATTERN.test(message)) return { kind: 'context_overflow', message }
  if (error instanceof Error && error.name === 'AbortError') return { kind: 'timeout', message }
  if (/timed? ?out/i.test(message)) return { kind: 'timeout', message }
  // fetch's own network-failure error is a TypeError with no HTTP status at all.
  if (error instanceof TypeError || /fetch failed|network|ECONNREFUSED|ENOTFOUND/i.test(message)) {
    return { kind: 'network', message }
  }
  const httpMatch = message.match(/^HTTP (\d+):/)
  if (httpMatch) return classifyHttpError(Number(httpMatch[1]), message)
  return { kind: 'unknown', message }
}
