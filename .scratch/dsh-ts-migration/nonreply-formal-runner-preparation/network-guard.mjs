/** 本轮进程的连接前硬拒绝；不读取用户配置或密钥。 */
import net from 'node:net';
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
  const value=Array.isArray(args[0])?args[0][0]:args[0];
  const target=typeof value==='object'?value:{port:value,host:args[1]};
  const path=target.path??(typeof target.port==='string'&&target.port.startsWith('/')?target.port:null);
  const localSocket=path==='/tmp/.s.PGSQL.5432'||typeof path==='string'
    &&/\/notalone-dsh-validation-[^/]+\/l2-permit\.sock$/.test(path);
  const localTCP=['127.0.0.1','::1','localhost'].includes(target.host??target.hostname)&&Number.isInteger(Number(target.port));
  if(!localSocket&&!localTCP)throw Error('external_network_forbidden');
  process.stdout.write(`VALIDATION_NETWORK ${JSON.stringify({host:target.host,port:target.port,path:target.path})}\n`);
  return Reflect.apply(connect,this,args);
};
