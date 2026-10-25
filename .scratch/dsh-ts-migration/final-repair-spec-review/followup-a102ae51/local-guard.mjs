/** 仅用于本次固定快照审查：限制 Node 出站到本机，并记录合成数据库归属。 */
import net from 'node:net';
import {appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';

function record(value) {
  appendFileSync(process.env.REVIEW_GUARD_LOG, JSON.stringify(value) + '\n', {mode: 0o600});
}
function localSocket(args) {
  if (Array.isArray(args[0])) return localSocket(args[0]);
  const options = args[0];
  if (options && typeof options === 'object') {
    if (typeof options.path === 'string') return options.path.startsWith('/tmp/') || options.path.startsWith(tmpdir());
    return ['127.0.0.1', '::1', 'localhost'].includes(options.host ?? 'localhost');
  }
  if (typeof options === 'number' || typeof options === 'string' && /^\d+$/.test(options)) {
    return typeof args[1] !== 'string' || ['127.0.0.1', '::1', 'localhost'].includes(args[1]);
  }
  return typeof options === 'string' && (options.startsWith('/tmp/') || options.startsWith(tmpdir()));
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  if (!localSocket(args)) {
    record({kind: 'blocked_nonlocal_socket'});
    throw new Error('review_nonlocal_socket_rejected');
  }
  return Reflect.apply(connect, this, args);
};
syncBuiltinESMExports();
const {default: pg} = await import(pathToFileURL(join(process.env.REVIEW_SNAPSHOT, 'backend-ts/node_modules/pg/lib/index.js')));
const pgConnect = pg.Client.prototype.connect;
pg.Client.prototype.connect = function (...args) {
  const {host, database} = this.connectionParameters;
  const local = ['127.0.0.1', '::1', 'localhost', '/tmp'].includes(host) || host.startsWith(tmpdir()) || host.startsWith('/tmp/');
  if (!local || database !== 'postgres' && database !== 'synthetic_test' && !/^notalone_[a-zA-Z0-9_]+_test$/.test(database)) {
    record({kind: 'blocked_database_scope'});
    throw new Error('review_database_scope_rejected');
  }
  record({kind: 'pg_connect', database});
  return Reflect.apply(pgConnect, this, args);
};
