import { CandidateCopyController, candidateCopyRequest, type CandidateCopySurface } from '../../src/main/candidate-copy/controller';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { BackendHost } from '../../src/main/backend/host';
import { StartupDiagnostics } from '../../src/main/startup/diagnostics';
import { installContactSessionBridge } from '../../src/main/contacts/bridge';
import { ImportController, type ImportFileSelector } from '../../src/main/imports/controller';
import { installImportBridge } from '../../src/main/imports/bridge';
import { installMemoryBridge } from '../../src/main/memory/bridge';
import { installSourceDeletionBridge } from '../../src/main/sources/bridge';
import { installReplyBridge } from '../../src/main/reply/bridge';
import { installBindingConsentBridge } from '../../src/main/bindings/bridge';
import { noArguments, type PageCommands, type PageRole } from '../../src/main/page-commands';
import { ownResource } from './cleanup';

// 只托管本轮构建资源；具名控制通道由 Playwright 的本轮 page 对象提供，不监听业务 HTTP。
export async function servePageAssets() {
  const root = path.resolve('dist/renderer');
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const selected = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!selected.startsWith(`${root}${path.sep}`)) throw new Error();
      const content = await readFile(selected);
      response.writeHead(200, { 'Content-Type': selected.endsWith('.html') ? 'text/html; charset=utf-8'
        : selected.endsWith('.js') ? 'text/javascript' : selected.endsWith('.css') ? 'text/css' : 'image/png',
      'Cache-Control': 'no-store' });
      response.end(content);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无头资源 host 未启动。');
  return { origin: `http://127.0.0.1:${address.port}`, async close() {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

export class PageHost implements PageCommands {
  private readonly handlers = new Map<string, { handler: (...args: unknown[]) => unknown; role?: PageRole }>();
  private readonly pages = new Map<Page, PageRole>();
  private readonly pendingEvents = new Set<Promise<unknown>>();
  private closing = false;
  private readonly released = ownResource();
  readonly backend: BackendHost;
  readonly diagnostics: StartupDiagnostics;
  constructor(private readonly context: BrowserContext, private readonly origin: string, userData: string, options: { copySurface?: CandidateCopySurface; chooseImportFile?: ImportFileSelector } = {}) {
    this.diagnostics = new StartupDiagnostics(userData);
    this.backend = new BackendHost(userData, (config, canStart) => this.diagnostics.ensureReady(config, canStart));
    const contacts = installContactSessionBridge(this, this.backend);
    installBindingConsentBridge(this, this.backend, contacts);
    const imports = new ImportController(this.backend, contacts);
    installImportBridge(this, imports);
    this.handle('imports:choose-file', (...args: unknown[]) => {
      noArguments(args);
      if (!options.chooseImportFile) throw new Error('本轮页面未提供文件选择输入。');
      return imports.chooseFile(options.chooseImportFile);
    }, 'manager');
    const memory = installMemoryBridge(this, this.backend, contacts);
    const replies = installReplyBridge(this, this.backend, contacts);
    installSourceDeletionBridge(this, this.backend, contacts, async (contactId) => {
      const checking = replies.revalidateDeletedSource(contactId);
      try { await memory.revalidateDeletedSource(contactId); }
      finally { await checking; }
    });
    const copies = new CandidateCopyController(this.backend, contacts, replies);
    this.handle('candidate-copy:copy', (...args: unknown[]) => {
      const request = candidateCopyRequest(args);
      if (!options.copySurface) throw new Error('本轮页面未提供系统复制输入。');
      return copies.copy(request, options.copySurface);
    }, 'helper');
    this.handle('backend:get-state', (...args) => { noArguments(args); return this.backend.getState(); });
    this.handle('backend:retry-connection', (...args) => { noArguments(args); return this.backend.connect(); });
    this.handle('startup:get-state', (...args) => { noArguments(args); return this.diagnostics.getState(); });
    this.backend.onStateChanged((state) => this.publish('backend:state-changed', state));
    this.diagnostics.onStateChanged((state) => this.publish('startup:state-changed', state));
  }
  handle(channel: string, handler: (...args: unknown[]) => unknown, role?: PageRole) {
    if (this.handlers.has(channel)) throw new Error('重复页面操作。');
    this.handlers.set(channel, { handler, role });
  }
  publish(channel: string, state: unknown) {
    if (this.closing) return;
    for (const page of this.pages.keys()) {
      const event = page.evaluate(({ channel, state }) => {
        (window as Window & { pageEvent?: (channel: string, state: unknown) => void }).pageEvent?.(channel, state);
      }, { channel, state }).catch(() => {});
      this.pendingEvents.add(event); void event.finally(() => this.pendingEvents.delete(event));
    }
  }
  async open(role: PageRole): Promise<Page> {
    if (this.closing) throw new Error('本轮页面已收尾。');
    const page = await this.context.newPage();
    this.pages.set(page, role);
    await page.setViewportSize(role === 'manager' ? { width: 1080, height: 740 } : { width: 680, height: 520 });
    await page.exposeBinding('pageCommand', (source, channel: unknown, args: unknown) => {
      if (this.closing || source.page !== page || source.frame !== page.mainFrame()
        || page.url() !== `${this.origin}/#${role}` || typeof channel !== 'string' || !Array.isArray(args)) throw new Error('页面操作不可用。');
      if (channel === 'page:open-manager' || channel === 'page:open-helper') {
        noArguments(args); return this.open(channel === 'page:open-helper' ? 'helper' : 'manager').then(() => undefined);
      }
      const command = this.handlers.get(channel);
      if (!command || (command.role && command.role !== this.pages.get(page))) throw new Error('页面操作不可用。');
      return command.handler(...args);
    });
    await page.addInitScript({ path: path.resolve('artifacts/headless-runtime/renderer.js') });
    await page.goto(`${this.origin}/#${role}`);
    return page;
  }
  async close(): Promise<void> {
    this.closing = true;
    this.diagnostics.cancel();
    const stopped = await this.backend.stop();
    await Promise.allSettled(this.pendingEvents);
    await this.context.close();
    this.pages.clear(); this.handlers.clear();
    if (!stopped) throw new Error('本轮页面控制器停读未确认。');
    this.released();
  }
}
