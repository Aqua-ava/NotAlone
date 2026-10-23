// 只观察测试宿主的真实连接；不替换 DSH 或模型适配器。
import net from 'node:net';
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const target = typeof options === 'object' ? { host: options.host, port: options.port, path: options.path } : { port: options, host: args[1] };
  process.stdout.write(`VALIDATION_NETWORK ${JSON.stringify(target)}\n`);
  return Reflect.apply(connect, this, args);
};
