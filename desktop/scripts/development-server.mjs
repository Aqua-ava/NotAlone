import { randomBytes } from 'node:crypto';
import { createServer as createSocket } from 'node:net';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

export async function createDevelopmentServer(projectDirectory) {
  const port = await new Promise((resolve, reject) => {
    const socket = createSocket();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const selected = socket.address().port;
      socket.close(error => error ? reject(error) : resolve(selected));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  const token = randomBytes(32).toString('hex');
  const nonce = randomBytes(24).toString('hex');
  const renderer = path.join(projectDirectory, 'src/renderer');
  const cache = path.join(projectDirectory, '.dev/vite');
  const allowed = [renderer, path.join(projectDirectory, 'src/shared'), path.join(projectDirectory, 'node_modules'), cache];
  const allowedPaths = [...allowed.map(directory => path.resolve(directory)),
    ...await Promise.all(allowed.map(directory => realpath(directory).catch(() => path.resolve(directory))))];
  const allowedFile = filename => allowedPaths.some(directory => {
    const relative = path.relative(directory, filename);
    return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
  const server = await createServer({
    configFile: false, envDir: false, root: renderer, base: '/', cacheDir: cache,
    html: { cspNonce: nonce },
    plugins: [{ name: 'notalone-local-development',
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (request.headers['x-notalone-dev-token'] !== token || !['GET', 'HEAD'].includes(request.method)) {
            response.writeHead(403); response.end('开发资源不可用'); return;
          }
          // 缺失文件也必须拒绝，不能落入 Vite 的首页回退。
          let pathname;
          try {
            const target = new URL(request.url ?? '/', origin);
            if (target.origin !== origin) throw new Error('开发资源不可用');
            pathname = decodeURIComponent(target.pathname).replaceAll('\\', '/');
          }
          catch { response.writeHead(403); response.end('开发资源不可用'); return; }
          if (pathname.includes('\0') || pathname.split('/').some(part => /^\.env(?:$|\.)/i.test(part))
            || pathname.startsWith('/@fs/') && !allowedFile(path.resolve(pathname.slice('/@fs'.length)))) {
            response.writeHead(403); response.end('开发资源不可用'); return;
          }
          next();
        });
      },
      transformIndexHtml: { order: 'pre', handler: html => html
        .replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`)
        .replace("style-src 'self'", `style-src 'self' 'nonce-${nonce}'`)
        .replace("connect-src 'none'", `connect-src ${origin.replace('http:', 'ws:')}`) },
    }, react()],
    server: { host: '127.0.0.1', port, strictPort: true, open: false, cors: false,
      forwardConsole: false,
      ws: { host: '127.0.0.1', protocol: 'ws', clientPort: port },
      fs: { strict: true, allow: allowed },
    },
  });
  try { await server.listen(); return { server, origin, token }; }
  catch (error) { await server.close(); throw error; }
}
