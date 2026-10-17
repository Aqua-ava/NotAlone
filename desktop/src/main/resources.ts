import { app, net, type Session } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateDevelopmentServer, type DevelopmentServer } from './development';

export function installResources(appSession: Session, development?: DevelopmentServer): void {
  const server = !app.isPackaged && development ? validateDevelopmentServer(development) : undefined;
  const root = path.join(app.getAppPath(), 'dist/renderer');
  appSession.protocol.handle('notalone', (request) => {
    const url = new URL(request.url);
    if (url.protocol !== 'notalone:' || url.host !== 'app' || url.username || url.password || !['GET', 'HEAD'].includes(request.method)) {
      return new Response('资源不可用', { status: 403 });
    }
    if (server) {
      const target = new URL(server.origin);
      target.pathname = url.pathname;
      target.search = url.search;
      return net.fetch(target.toString(), { method: request.method, redirect: 'error',
        headers: { 'x-notalone-dev-token': server.token } });
    }
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); }
    catch { return new Response('资源不可用', { status: 400 }); }
    const filename = path.resolve(root, `.${pathname}`);
    const relative = path.relative(root, filename);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return new Response('资源不可用', { status: 403 });
    }
    return net.fetch(pathToFileURL(filename).toString());
  });
  appSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  appSession.setPermissionCheckHandler(() => false);
}
