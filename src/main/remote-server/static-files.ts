import { createReadStream, statSync } from 'fs'
import { join, normalize, sep } from 'path'
import type { IncomingMessage, ServerResponse } from 'http'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
}

/**
 * Serves static files from `rootDir`, guarding against path traversal by
 * resolving the request path relative to root and rejecting anything that
 * escapes it (a `../` in the URL, an absolute path, etc.) before touching
 * the filesystem.
 */
export function serveStatic(rootDir: string, req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? '/', 'http://localhost')
  let pathname = url.pathname === '/' ? '/index.html' : url.pathname
  if (pathname === '/app') pathname = '/app.html'
  if (pathname === '/login') pathname = '/login.html'

  const normalized = normalize(pathname).replace(/^(\.\.[/\\])+/, '')
  const filePath = join(rootDir, normalized)
  if (!filePath.startsWith(rootDir + sep) && filePath !== rootDir) {
    res.writeHead(403).end('Forbidden')
    return true
  }

  let stat
  try {
    stat = statSync(filePath)
  } catch {
    return false
  }
  if (!stat.isFile()) return false

  const ext = filePath.slice(filePath.lastIndexOf('.'))
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream'
  res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stat.size })
  createReadStream(filePath).pipe(res)
  return true
}
