// 本轮无 PG／HTTP／模型／桌面运行，只允许 esbuild 的一次性编译子进程。
import fs from 'node:fs';
import net from 'node:net';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const blocked = () => { throw new Error('review_external_operation_rejected'); };
net.Socket.prototype.connect = blocked;
globalThis.fetch = blocked;
const originalRead = fs.readFileSync;
fs.readFileSync = function(path, ...args) {
  if (/(?:^|\/)\.env(?:$|\.)/.test(String(path))) throw new Error('review_env_read_rejected');
  return Reflect.apply(originalRead, this, [path, ...args]);
};
const originalSpawn = childProcess.spawn;
childProcess.spawn = function(command, ...args) {
  if (!String(command).endsWith('/bin/esbuild')) throw new Error('review_child_process_rejected');
  return Reflect.apply(originalSpawn, this, [command, ...args]);
};
syncBuiltinESMExports();
