// 审查仅允许回环及本机 PG；子 Node 宿主继承限制。
import net from 'node:net';
import cp from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = net._normalizeArgs(args)[0];
  if (options.path) {
    if (!/^\/tmp\/\.s\.PGSQL\.\d+$/.test(options.path)
      && !options.path.startsWith(process.env.TMPDIR + '/')) throw new Error('review_socket_rejected');
  } else if (!['127.0.0.1', '::1', 'localhost'].includes(options.host ?? 'localhost')) {
    throw new Error('review_remote_network_rejected');
  }
  return Reflect.apply(connect, this, args);
};
const spawn = cp.spawn;
cp.spawn = function (command, args, options) {
  if (command === process.execPath) {
    args = ['--import', import.meta.url, ...args];
    options = { ...options, env: { ...(options?.env ?? process.env),
      NOTALONE_REVIEW_ROOT: process.env.NOTALONE_REVIEW_ROOT,
      TMPDIR: process.env.TMPDIR, USER: process.env.USER } };
  }
  return Reflect.apply(spawn, this, [command, args, options]);
};
const require = createRequire(process.env.NOTALONE_REVIEW_ROOT + '/backend-ts/package.json');
const pg = require('pg');
const owned = /^notalone_(pure_ts|spec_7a1)_[a-f0-9]{32}_test$/;
const nativeConnect = pg.Client.prototype.connect;
pg.Client.prototype.connect = function (...args) {
  const { host, database } = this.connectionParameters;
  if (host !== '/tmp' || database !== 'postgres' && !owned.test(database)) throw new Error('review_database_rejected');
  return Reflect.apply(nativeConnect, this, args);
};
const nativeQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function (...args) {
  if (this.connectionParameters.database === 'postgres') {
    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
    const ddl = /^(?:CREATE|DROP) DATABASE "(notalone_(?:pure_ts|spec_7a1)_[a-f0-9]{32}_test)"(?: TEMPLATE template0)?$/.exec(text ?? '');
    const check = text === 'SELECT count(*)::int AS n FROM pg_database WHERE datname=$1'
      && Array.isArray(args[1]) && owned.test(args[1][0]);
    if (!ddl && !check) throw new Error('review_admin_query_rejected');
  }
  return Reflect.apply(nativeQuery, this, args);
};
syncBuiltinESMExports();
