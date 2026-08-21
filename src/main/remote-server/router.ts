import type { IncomingMessage, ServerResponse } from 'http'

export type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => void | Promise<void>

interface Route {
  method: string
  // Path segments; a segment starting with ':' is a param.
  segments: string[]
  handler: Handler
}

/**
 * Minimal method+path dispatcher — this server has ~6 routes total, not
 * enough to justify pulling in express for routing alone.
 */
export class Router {
  private routes: Route[] = []

  add(method: string, path: string, handler: Handler): void {
    this.routes.push({ method: method.toUpperCase(), segments: path.split('/').filter(Boolean), handler })
  }

  get(path: string, handler: Handler): void {
    this.add('GET', path, handler)
  }

  post(path: string, handler: Handler): void {
    this.add('POST', path, handler)
  }

  /** Returns true if a matching route was found and dispatched. */
  async dispatch(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathSegments = url.pathname.split('/').filter(Boolean)
    for (const route of this.routes) {
      if (route.method !== req.method) continue
      if (route.segments.length !== pathSegments.length) continue
      const params: Record<string, string> = {}
      let matched = true
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i]
        if (seg.startsWith(':')) {
          params[seg.slice(1)] = decodeURIComponent(pathSegments[i])
        } else if (seg !== pathSegments[i]) {
          matched = false
          break
        }
      }
      if (!matched) continue
      for (const [key, value] of url.searchParams) params[key] = value
      await route.handler(req, res, params)
      return true
    }
    return false
  }
}

export function readJsonBody<T>(req: IncomingMessage, maxBytes = 1_000_000): Promise<T> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('Body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : ({} as T))
      } catch {
        reject(new Error('Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

export function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json), ...extraHeaders })
  res.end(json)
}
