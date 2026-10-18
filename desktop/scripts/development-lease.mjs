import net from 'node:net';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chmod } from 'node:fs/promises';

// 构建目录是项目共享的：不同 userData 也不能并发创建第二套 watcher。
export async function acquireDevelopmentLease(project) {
  const key = createHash('sha256').update(path.resolve(project)).digest('hex').slice(0, 24);
  const socket = path.join(tmpdir(), `notalone-dev-${key}.sock`);
  const server = net.createServer(client => client.end('notalone-development-supervisor-v1\n'));
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, resolve);
    });
    await chmod(socket, 0o600);
    return { close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
  } catch (error) {
    if (error.code !== 'EADDRINUSE') { if (server.listening) server.close(); throw error; }
    const response = await new Promise((resolve, reject) => {
      const client = net.createConnection(socket);
      let received = '';
      client.setTimeout(1000, () => client.destroy(new Error('开发监督器未响应；请核对现有进程，不会删除未知锁。')));
      client.on('data', data => { received += data; if (received.length > 100) client.destroy(new Error('开发监督器响应无效。')); });
      client.once('error', reject);
      client.once('end', () => resolve(received));
    });
    if (response !== 'notalone-development-supervisor-v1\n') throw new Error('开发监督器响应无效；不会启动第二份。');
    return undefined;
  }
}
