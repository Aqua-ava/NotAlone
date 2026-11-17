/** 有界 HTTP 正文读取：固定总截止时间，拒绝部分正文，不提前销毁响应套接字。 */
import type { IncomingMessage } from 'node:http';
export class HttpBodyError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {super(code);this.status=status;this.code=code;}
}
export function readHttpBody(req: IncomingMessage, limit = 1024 * 1024, timeoutMs = 10_000): Promise<Buffer> {
  const raw = req.headers['content-length'];
  if (raw !== undefined && (typeof raw !== 'string' || !/^\d+$/.test(raw))) return Promise.reject(new HttpBodyError(400,'request_length_invalid'));
  const length = raw === undefined ? undefined : Number(raw);
  if (length !== undefined && length > limit) return Promise.reject(new HttpBodyError(413,'request_body_too_large'));
  if (length === 0 || length === undefined && !req.headers['transfer-encoding']) return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolve,reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: HttpBodyError) => {
      clearTimeout(timer);req.removeListener('data',data);req.removeListener('end',end);
      req.removeListener('aborted',incomplete);req.removeListener('error',incomplete);req.removeListener('close',close);
      if (error) {req.pause();reject(error);} else resolve(Buffer.concat(chunks));
    };
    const data = (chunk: Buffer) => {size += chunk.length;if (size > limit) finish(new HttpBodyError(413,'request_body_too_large'));else chunks.push(chunk);};
    const end = () => finish(length !== undefined && size !== length ? new HttpBodyError(400,'request_body_incomplete') : undefined);
    const incomplete = () => finish(new HttpBodyError(400,'request_body_incomplete'));
    const close = () => {if (!req.complete) incomplete();};
    const timer = setTimeout(() => finish(new HttpBodyError(408,'request_body_timeout')),timeoutMs);
    req.on('data',data);req.once('end',end);req.once('aborted',incomplete);req.once('error',incomplete);req.once('close',close);
    if (req.destroyed) incomplete();
  });
}
