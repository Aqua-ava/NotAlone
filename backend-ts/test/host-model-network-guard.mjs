/** 合成profile只有本机PG/许可/SSE连接，未知出站在发起前拒绝。 */
import net from 'node:net';
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
 const options=Array.isArray(args[0])?args[0][0]:args[0];
 const target=typeof options==='object'?options:{port:options,host:args[1]};
 const socketPath=target.path??(typeof target.port==='string'&&target.port.startsWith('/')?target.port:undefined);
 if(socketPath!==undefined){
  if(socketPath!=='/tmp/.s.PGSQL.5432'&&!/^(?:\/private)?\/tmp\/na-model-[^/]+\/p\.sock$/.test(socketPath))throw Error('合成profile拒绝非自有Unix socket');
 }else if(target.host!=='127.0.0.1')throw Error('合成profile拒绝非loopback连接');
 return Reflect.apply(connect,this,args);
};
