// 审查进程只允许回环网络和本机 PostgreSQL socket；子宿主沿用同一限制。
import net from 'node:net';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
 const options=net._normalizeArgs(args)[0];
 if(options.path){
  if(!/^\/tmp\/\.s\.PGSQL\.\d+$/.test(options.path)&&!options.path.startsWith(process.env.TMPDIR+'/'))throw new Error('spec_review_socket_rejected');
 }else if(!['127.0.0.1','::1','localhost'].includes(options.host??'localhost'))throw new Error('spec_review_remote_network_rejected');
 return Reflect.apply(connect,this,args);
};
const spawn=cp.spawn;
cp.spawn=function(command,args,options){
 if(command===process.execPath)args=['--import',import.meta.url,...args];
 return Reflect.apply(spawn,this,[command,args,options]);
};
syncBuiltinESMExports();
