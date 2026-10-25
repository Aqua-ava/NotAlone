/** 合成进程只连 loopback、PG 和本任务实际 ModelHost socket。 */
import net from 'node:net';
const original=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){const value=Array.isArray(args[0])?args[0][0]:args[0],target=typeof value==='object'?value:{port:value,host:args[1]};
  const path=target.path??(typeof target.port==='string'&&target.port.startsWith('/')?target.port:null);
  if(!(path==='/tmp/.s.PGSQL.5432'||typeof path==='string'&&/^\/tmp\/na-model-\d+-[a-f0-9]{24}\/p\.sock$/.test(path)
    ||['127.0.0.1','::1','localhost'].includes(target.host??target.hostname)&&Number.isInteger(Number(target.port))))throw Error('external_network_forbidden');
  return Reflect.apply(original,this,args);
};
