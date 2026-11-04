import net from 'node:net';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chmod, rm } from 'node:fs/promises';

// 构建目录是项目共享的：不同 userData 也不能并发创建第二套 watcher。
export async function acquireDevelopmentLease(project) {
  const key = createHash('sha256').update(path.resolve(project)).digest('hex').slice(0, 24);
  const socket = path.join(tmpdir(), `notalone-dev-${key}.sock`);
  // 残留 socket（上次异常退出）会被探测为无人监听并清除后重试；有人响应则复用，未知响应不动锁。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const server = net.createServer(client => client.end('notalone-development-supervisor-v1\n'));
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socket, resolve);
      });
      await chmod(socket, 0o600);
      return { close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
    } catch (error) {
      if (server.listening) server.close();
      if (error.code !== 'EADDRINUSE') throw error;
      const outcome = await probeSupervisor(socket);
      if (outcome === 'live') return undefined;
      if (outcome === 'stale') await rm(socket, { force: true });
    }
  }
  throw new Error('开发监督器锁反复竞争；请核对现有进程，不会删除未知锁。');
}

// 返回 live（监督器在线）、stale（无人监听的残留文件）或 gone（探测时已被移除）；其余情况抛错。
function probeSupervisor(socket) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socket);
    let received = '';
    client.setTimeout(1000, () => client.destroy(new Error('开发监督器未响应；请核对现有进程，不会删除未知锁。')));
    client.on('data', data => { received += data; if (received.length > 100) client.destroy(new Error('开发监督器响应无效。')); });
    client.once('error', error => {
      if (error.code === 'ECONNREFUSED') resolve('stale');
      else if (error.code === 'ENOENT') resolve('gone');
      else reject(error);
    });
    client.once('end', () => received === 'notalone-development-supervisor-v1\n'
      ? resolve('live') : reject(new Error('开发监督器响应无效；不会启动第二份。')));
  });
}
