/** 本轮合成进程只允许 loopback、PG 与实际 ModelHost 私有 socket。 */
import net from 'node:net';
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
  const value=Array.isArray(args[0])?args[0][0]:args[0],target=typeof value==='object'?value:{port:value,host:args[1]};
  const path=target.path??(typeof target.port==='string'&&target.port.startsWith('/')?target.port:null);
  const localSocket=path==='/tmp/.s.PGSQL.5432'||typeof path==='string'&&/^\/tmp\/na-model-\d+-[a-f0-9]{24}\/p\.sock$/.test(path);
  if(!localSocket&&!(['127.0.0.1','::1','localhost'].includes(target.host??target.hostname)&&Number.isInteger(Number(target.port))))
    throw Error('external_network_forbidden');
  process.stdout.write('SEAM_NETWORK '+JSON.stringify({host:target.host,port:target.port,path})+'\n');
  return Reflect.apply(connect,this,args);
};
