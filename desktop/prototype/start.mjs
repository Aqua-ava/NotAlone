import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// 独立 UI 原型，只提供预览文件与已有品牌图片，不访问产品后端或私人配置。
if (process.env.NODE_ENV === 'production') {
  console.error('这是独立交互原型，请在开发环境预览。');
  process.exit(1);
}
const files = {
  '/prototype/replies/': ['replies.html', 'text/html; charset=utf-8'],
  '/prototype/notalone-windows/': ['index.html', 'text/html; charset=utf-8'],
  '/prototype/notalone-windows/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/prototype/notalone-windows/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/prototype/notalone-windows/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/prototype/notalone-windows/logo.png': ['../../website/assets/logo.png', 'image/png'],
};
const port = Number(process.env.NOTALONE_PROTOTYPE_PORT || 4176);
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (pathname === '/') {
    response.writeHead(302, { Location: '/prototype/notalone-windows/?surface=manager' }).end();
    return;
  }
  const entry = files[pathname];
  if (request.method !== 'GET' || !entry) {
    response.writeHead(404).end('Not found');
    return;
  }
  const body = await readFile(fileURLToPath(new URL(entry[0], import.meta.url)));
  response.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-store' }).end(body);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`候选回复：http://127.0.0.1:${port}/prototype/replies/?variant=A`);
  console.log(`管理后台：http://127.0.0.1:${port}/prototype/notalone-windows/?surface=manager`);
  console.log(`输入小窗：http://127.0.0.1:${port}/prototype/notalone-windows/?surface=ime&variant=A`);
});
