/** 只读工作线程复用同一原生身份、字节和资源校验，不承载数据库写入。 */
import {parentPort,workerData} from 'node:worker_threads';
import {SecureSkillDirectory} from './secure-directory.ts';

const port=parentPort!;
const code=(error:unknown)=>{
 const value=(error as {code?:unknown})?.code;
 return typeof value==='string'&&/^[a-z][a-z0-9_]{0,79}$/.test(value)?value:'skill_reader_unavailable';
};
try{
 const directory=new SecureSkillDirectory(workerData.root,workerData.readerBinary,workerData.rootIdentity);
 port.on('message',request=>{
  const cancelled=()=>Atomics.load(new Int32Array(request.cancelled),0)!==0;
  if(cancelled()){port.postMessage({id:request.id,cancelled:true});return;}
  port.postMessage({id:request.id,started:true});
  try{
   let value:unknown;
   if(request.operation==='names')value=directory.names();
   else if(request.operation==='identity')value=directory.directoryIdentity(request.name);
   else if(request.operation==='snapshot')value=directory.snapshot(request.name,request.expectedIdentity);
   else throw Object.assign(new Error(),{code:'skill_package_invalid'});
   port.postMessage(cancelled()?{id:request.id,cancelled:true}:{id:request.id,value});
  }catch(error){port.postMessage(cancelled()?{id:request.id,cancelled:true}:{id:request.id,code:code(error)});}
 });
}catch(error){port.postMessage({fatal:true,code:code(error)});port.close();}
