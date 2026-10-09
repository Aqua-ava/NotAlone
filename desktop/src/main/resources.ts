import { app, net, type Session } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function installResources(appSession: Session): void {
  const root = path.join(app.getAppPath(), 'dist/renderer');
  appSession.protocol.handle('notalone', (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app' || !['GET', 'HEAD'].includes(request.method)) {
      return new Response('资源不可用', { status: 403 });
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
