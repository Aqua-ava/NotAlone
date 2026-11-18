import type { ServerResponse } from 'node:http';

/** 统一的 JSON 响应：禁止缓存，状态与正文一次写出。 */
export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
