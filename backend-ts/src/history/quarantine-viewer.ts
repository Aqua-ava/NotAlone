import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { QuarantineVault, QuarantineVaultError } from './quarantine-vault.ts';

const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const page = `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>本机隔离历史验收</title></head><body>
<main><h1>本机隔离历史验收</h1>
<p id="notice" role="status">读取隔离仓状态中…</p>
<p>所有消息状态均未核验。此处文字仅用于本机验收，不进入普通聊天、检索、记忆或回复生成。</p>
<button id="delete-all" type="button">删除全部隔离文字</button>
<button id="cancel-delete-all" type="button" hidden>取消删除</button>
<section id="records" aria-label="未核验历史消息"></section>
<button id="more" type="button" disabled>载入更多记录</button>
<p id="error" role="alert"></p></main>
<script nonce="__NONCE__">
(() => {
  const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
  history.replaceState(null, '', location.pathname);
  const notice = document.querySelector('#notice');
  const list = document.querySelector('#records');
  const error = document.querySelector('#error');
  const more = document.querySelector('#more');
  const deleteAll = document.querySelector('#delete-all');
  const cancelDeleteAll = document.querySelector('#cancel-delete-all');
  let cursor = null;
  let busy = false;
  let deleteAllPending = false;
  async function api(path, init = {}) {
    const response = await fetch(path, { ...init, headers: { ...(init.headers || {}), Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || '隔离仓请求失败。');
    return value;
  }
  function setStatus(status) {
    const run = status.snapshotComplete ? '本次固定快照遍历结束' : '快照不完整或尚未完成';
    const continuity = status.sourceContinuity === 'held' ? '本次快照期间守卫有效'
      : status.sourceContinuity === 'lost' ? '本次快照失证' : '来源连续性未核验';
    notice.textContent = status.displayName + ' · ' + run + ' · ' + continuity
      + ' · 隔离记录：' + status.recordCount + ' 条 · 不可保存文字：' + status.unavailableTextCount + ' 条 · ' + (status.failureCode || '无中断原因');
  }
  function addRecord(record) {
    const article = document.createElement('article');
    const label = document.createElement('p');
    label.textContent = '未核验文字 · 类型 ' + record.originalType + ' · 原始状态 ' + (record.status ?? '未知')
      + ' · 发送方 ' + record.sender + ' · 时间 ' + (record.sentAt ?? '未知');
    const body = document.createElement('pre');
    body.textContent = record.text;
    const remove = document.createElement('button');
    remove.type = 'button'; remove.textContent = '删除这条隔离文字';
    const cancelRemove = document.createElement('button');
    cancelRemove.type = 'button'; cancelRemove.textContent = '取消删除'; cancelRemove.hidden = true;
    let deletePending = false;
    remove.addEventListener('click', async () => {
      if (busy) return;
      if (!deletePending) {
        deletePending = true;
        remove.textContent = '确认删除这条隔离文字';
        cancelRemove.hidden = false;
        return;
      }
      busy = true; remove.disabled = true; cancelRemove.disabled = true; error.textContent = '';
      try { await api('/api/records/' + encodeURIComponent(record.id), { method: 'DELETE' }); await load(true, true); }
      catch (failure) { error.textContent = failure.message; }
      finally { busy = false; remove.disabled = false; cancelRemove.disabled = false; }
    });
    cancelRemove.addEventListener('click', () => {
      if (busy) return;
      deletePending = false; remove.textContent = '删除这条隔离文字'; cancelRemove.hidden = true;
    });
    article.append(label, body, remove, cancelRemove);
    list.append(article);
  }
  async function refreshStatus() { const value = await api('/api/status'); setStatus(value); }
  async function load(reset, afterDelete = false) {
    if (busy && !afterDelete) return;
    busy = true; more.disabled = true; error.textContent = '';
    try {
      if (reset) { cursor = null; list.replaceChildren(); }
      await refreshStatus();
      const query = new URLSearchParams({ limit: '50' }); if (cursor) query.set('after', cursor);
      const result = await api('/api/records?' + query.toString());
      for (const record of result.records) addRecord(record);
      cursor = result.nextCursor; more.disabled = !cursor;
      if (!result.records.length && reset) notice.textContent += ' · 暂无隔离文字';
    } catch (failure) { error.textContent = failure.message; }
    finally { busy = false; }
  }
  more.addEventListener('click', () => void load(false));
  deleteAll.addEventListener('click', async () => {
    if (busy) return;
    if (!deleteAllPending) {
      deleteAllPending = true; deleteAll.textContent = '确认删除全部隔离文字'; cancelDeleteAll.hidden = false;
      return;
    }
    busy = true; deleteAll.disabled = true; cancelDeleteAll.disabled = true; error.textContent = '';
    try { await api('/api/records', { method: 'DELETE' }); list.replaceChildren(); cursor = null; more.disabled = true; await refreshStatus(); }
    catch (failure) { error.textContent = failure.message; }
    finally { busy = false; deleteAll.disabled = false; cancelDeleteAll.disabled = false; deleteAllPending = false; deleteAll.textContent = '删除全部隔离文字'; cancelDeleteAll.hidden = true; }
  });
  cancelDeleteAll.addEventListener('click', () => {
    if (busy) return;
    deleteAllPending = false; deleteAll.textContent = '删除全部隔离文字'; cancelDeleteAll.hidden = true;
  });
  void load(true);
})();
</script></body></html>`;

function send(res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin', ...extra });
  res.end(JSON.stringify(value));
}
function sendPage(res: ServerResponse): void {
  const nonce = randomBytes(18).toString('base64');
  const html = page.replaceAll('__NONCE__', nonce);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
  res.end(html);
}
function loopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress;
  return address === '127.0.0.1' || address === '::ffff:127.0.0.1' || address === '::1';
}
function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer ([a-f0-9]{64})$/.exec(header) : null;
  if (!match) return false;
  return timingSafeEqual(Buffer.from(match[1]!, 'hex'), Buffer.from(token, 'hex'));
}
function noRequestBody(req: IncomingMessage): boolean {
  return req.headers['transfer-encoding'] === undefined
    && (req.headers['content-length'] === undefined || req.headers['content-length'] === '0');
}
function failure(res: ServerResponse, error: unknown): void {
  if (error instanceof QuarantineVaultError) {
    const notFound = error.code === 'quarantine_record_not_found' || error.code === 'quarantine_cursor_invalid';
    const invalid = /invalid|outside_target/.test(error.code);
    send(res, notFound ? 404 : invalid ? 400 : 409, { error: error.code });
    return;
  }
  send(res, 500, { error: 'quarantine_viewer_operation_failed' });
}

export class QuarantineViewer {
  readonly url: string;
  readonly #server: Server;
  #closed = false;

  private constructor(server: Server, origin: string, token: string) {
    this.#server = server;
    this.url = `${origin}/#token=${token}`;
  }

  static async start(vault: QuarantineVault): Promise<QuarantineViewer> {
    if (!vault) throw new Error('quarantine_viewer_vault_required');
    const token = randomBytes(32).toString('hex');
    let viewer: QuarantineViewer | undefined;
    let expectedOrigin = '';
    let expectedHost = '';
    const server = createServer((req, res) => {
      if (!loopback(req)) { send(res, 403, { error: 'loopback_only' }); return; }
      let url: URL;
      try { url = new URL(req.url ?? '/', expectedOrigin || 'http://127.0.0.1'); }
      catch { send(res, 400, { error: 'request_invalid' }); return; }
      if (req.headers.host !== expectedHost) { send(res, 403, { error: 'host_forbidden' }); return; }
      if (url.origin !== expectedOrigin) { send(res, 403, { error: 'origin_forbidden' }); return; }
      if (url.pathname === '/' && req.method === 'GET' && !url.search) { sendPage(res); return; }
      if (!url.pathname.startsWith('/api/')) { send(res, 404, { error: 'not_found' }); return; }
      const origin = req.headers.origin;
      const fetchSite = req.headers['sec-fetch-site'];
      if (origin !== undefined && origin !== expectedOrigin || fetchSite !== undefined && fetchSite !== 'same-origin') {
        send(res, 403, { error: 'origin_forbidden' }); return;
      }
      if (req.method === 'DELETE' && origin !== expectedOrigin) { send(res, 403, { error: 'origin_required' }); return; }
      if (!authorized(req, token)) { send(res, 401, { error: 'unauthorized' }); return; }
      try {
        if (req.method === 'GET' && url.pathname === '/api/status' && !url.search) {
          send(res, 200, vault.summary()); return;
        }
        if (req.method === 'GET' && url.pathname === '/api/records') {
          const keys = [...url.searchParams.keys()];
          if (keys.some(key => !['limit', 'after'].includes(key)) || url.searchParams.getAll('limit').length > 1 || url.searchParams.getAll('after').length > 1) {
            send(res, 400, { error: 'request_invalid' }); return;
          }
          const rawLimit = url.searchParams.get('limit') ?? '50';
          if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit)) { send(res, 400, { error: 'request_invalid' }); return; }
          const after = url.searchParams.get('after');
          const result = vault.list({ limit: Number(rawLimit), ...(after ? { after } : {}) });
          send(res, 200, result); return;
        }
        if (req.method === 'DELETE' && (url.pathname === '/api/records' || /^\/api\/records\/[a-f0-9-]{36}$/i.test(url.pathname))) {
          if (url.search || !noRequestBody(req)) { req.resume(); send(res, 400, { error: 'request_invalid' }); return; }
          if (url.pathname === '/api/records') {
            send(res, 200, { deleted: vault.deleteAll() }); return;
          }
          const id = url.pathname.slice('/api/records/'.length);
          const deleted = vault.delete(id);
          if (!deleted) { send(res, 404, { error: 'quarantine_record_not_found' }); return; }
          send(res, 200, { deleted: true }); return;
        }
        send(res, 404, { error: 'not_found' });
      } catch (error) { failure(res, error); }
    });
    server.requestTimeout = 10_000; server.headersTimeout = 5_000; server.maxHeadersCount = 32;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const address = server.address() as AddressInfo | null;
    if (!address) { server.close(); throw new Error('quarantine_viewer_start_failed'); }
    expectedHost = `127.0.0.1:${address.port}`;
    expectedOrigin = `http://${expectedHost}`;
    viewer = new QuarantineViewer(server, expectedOrigin, token);
    return viewer;
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    return new Promise((resolve, reject) => this.#server.close(error => error ? reject(error) : resolve()));
  }
}
