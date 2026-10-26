/** 仅本轮合成宿主：公开 HTTP／PG 驱动观察点与出站拒绝。 */
import net from 'node:net';
import http from 'node:http';
import {syncBuiltinESMExports, createRequire} from 'node:module';
import {appendFileSync} from 'node:fs';
import {AsyncLocalStorage} from 'node:async_hooks';
import path from 'node:path';
import cp from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
const trace=process.env.NOTALONE_PERF_TRACE;
const context=new AsyncLocalStorage();
const now=()=>Number(process.hrtime.bigint())/1e6;
// 新增阶段仅存内存；原ALS和原HTTP行完整保留，不加async hooks或PG补丁。
const boundarySamples=[],boundaryEvents=[];
const boundaryLimits={sample_overflow:false,event_overflow:false,point_overflow:false};
const marker={mark(label,meta){
 const state=context.getStore(),sample=state?.boundary;
 if(sample){
  if(label==='storage.enter')sample.tx=++sample.next_tx;
  if(sample.points.length>=256){boundaryLimits.point_overflow=true;return;}
  sample.points.push([now()-state.start,label,sample.tx]);
 }else if(label.startsWith('host.')||label.startsWith('task.')){
  if(boundaryEvents.length>=4096){boundaryLimits.event_overflow=true;return;}
  boundaryEvents.push({time_ms:now(),label,...(meta===undefined?{}:{value:meta})});
 }
}};
globalThis[Symbol.for('notalone.boundary.v1')]=marker;
process.once('exit',()=>{
 const output=process.env.NOTALONE_BOUNDARY_STAGE_FILE;
 if(output)writeFileSync(output,JSON.stringify({schema:1,request_samples:boundarySamples,events:boundaryEvents,limits:boundaryLimits,gc:'unknown_no_extra_hooks',pg_decode_and_resume:'unknown_no_pg_patch'})+'\n',{mode:0o600});
});

const record=value=>appendFileSync(trace,JSON.stringify({...value,pid:process.pid})+'\n',{mode:0o600});
const spawn=cp.spawn;
cp.spawn=function(command,args,options){
 if(args?.[0]==='-m'&&args[1]==='notalone.server.command'){
  options={...options,env:{...options.env,PYTHONPATH:import.meta.dirname+':'+options.env.PYTHONPATH}};
 }
 return spawn(command,args,options);
};
if(process.env.NOTALONE_PERF_DIAGNOSTIC==='1'){
 const {Session}=await import('node:inspector');const debuggerSession=new Session();debuggerSession.connect();
 debuggerSession.on('Debugger.paused',({params})=>{
  const description=params.data?.description??'';
  record({type:'diagnostic_exception',description});
  debuggerSession.post('Debugger.resume');
 });
 await new Promise((resolve,reject)=>debuggerSession.post('Debugger.enable',error=>error?reject(error):resolve()));
 await new Promise((resolve,reject)=>debuggerSession.post('Debugger.setPauseOnExceptions',{state:'all'},error=>error?reject(error):resolve()));
}
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
 const input=Array.isArray(args[0])?args[0][0]:args[0];
 const options=typeof input==='object'?input:{port:input,host:args[1]};
 const socketPath=options.path??(typeof options.port==='string'&&options.port.startsWith('/')?options.port:undefined);
 if(socketPath!==undefined?socketPath!=='/tmp/.s.PGSQL.5432'&&!/^(?:\/private)?\/tmp\/na-model-[^/]+\/p\.sock$/.test(socketPath):options.host!=='127.0.0.1'){
  record({type:'network_denied'});throw Error('host_performance_network_denied');
 }
 return Reflect.apply(connect,this,args);
};
const fetch=globalThis.fetch;
globalThis.fetch=(input,init)=>{
 const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'){record({type:'network_denied'});throw Error('host_performance_fetch_denied');}
 return fetch(input,init);
};
const emit=http.Server.prototype.emit;
http.Server.prototype.emit=function(event,...args){
 if(event!=='request')return Reflect.apply(emit,this,[event,...args]);
 const [req,res]=args,id=req.headers['x-notalone-perf-id'];
 if(!id)return Reflect.apply(emit,this,[event,...args]);
 const state={start:now(),commits:[],transactions:[],transactionStart:null};
 const sample={request_id:id,ingress_ms:state.start,points:[[0,'ingress',0]],tx:0,next_tx:0,cpu_start:process.cpuUsage(),elu_start:performance.eventLoopUtilization()};
 state.boundary=sample;if(boundarySamples.length<256)boundarySamples.push(sample);else boundaryLimits.sample_overflow=true;
 res.once('finish',()=>{const ended=now();
  sample.points.push([ended-state.start,'finish',sample.tx]);sample.cpu_us=process.cpuUsage(sample.cpu_start);sample.elu=performance.eventLoopUtilization(sample.elu_start);sample.finished=true;
  record({type:'http',request_id:id,server_response_ms:ended-state.start,
  ingress_ns:state.start*1e6,persistence_complete_ns:state.commits.length?state.commits.at(-1)*1e6:null,
  persistence_complete_ms:state.commits.length?state.commits.at(-1)-state.start:null,
  transaction_ms:state.commits.length?state.transactions.reduce((a,b)=>a+b,0):null,queue_ms:null});});
 return context.run(state,()=>Reflect.apply(emit,this,[event,...args]));
};
syncBuiltinESMExports();
