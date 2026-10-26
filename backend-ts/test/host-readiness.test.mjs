import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {waitForHostReady} from './host-readiness-support.mjs';

async function fixture(t,{pid,state='running'}={}){
 const directory=await mkdtemp(join(tmpdir(),'notalone-readiness-')),infoPath=join(directory,'backend.info');
 const script=`import {createServer} from 'node:http';import {writeFile,rename} from 'node:fs/promises';
 process.on('message',async command=>{if(command==='exit')process.exit(0);if(command!=='publish')return;
 const server=createServer((request,response)=>{if(request.url!=='/api/runtime/status'||request.headers.authorization!=='Bearer synthetic-ready-token'){response.writeHead(401);response.end();return;}response.setHeader('content-type','application/json');response.end(JSON.stringify({state:${JSON.stringify(state)}}));});
 server.listen(0,'127.0.0.1',async()=>{await writeFile(${JSON.stringify(infoPath+'.tmp')},'address=127.0.0.1:'+server.address().port+'\\ntoken=synthetic-ready-token\\npid='+(${pid??'process.pid'})+'\\n',{mode:0o600});await rename(${JSON.stringify(infoPath+'.tmp')},${JSON.stringify(infoPath)});});});process.send('waiting');`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','ignore','pipe','ipc']}),exited=once(child,'exit');
 const host={pid:child.pid,isRunning:()=>child.exitCode===null&&child.signalCode===null,async waitForExit(timeout){let timer;try{return await Promise.race([exited.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),timeout);})]);}finally{clearTimeout(timer);}}};
 t.after(async()=>{if(host.isRunning())child.kill('SIGTERM');await exited;await rm(directory,{recursive:true,force:true});});
 await once(child,'message');return {host,child,infoPath};
}

test('官方握手可晚于spawn与旧轮询窗口，完整字段及运行状态就绪才返回',{timeout:15000},async t=>{
 const f=await fixture(t),ready=waitForHostReady(f.host,f.infoPath,{timeoutMs:10000});
 // 仅控制合成启动输入晚于旧2.5秒窗口，真正就绪仍以握手和HTTP状态为准。
 const release=setTimeout(()=>f.child.send('publish'),3200);
 try{const connection=await ready;assert.ok(connection,'仍存活的慢启动不应被旧轮询窗口误判失败');assert.equal(connection.pid,f.host.pid);}finally{clearTimeout(release);}
});

test('宿主早退与仍存活但未发布握手分别报告，失败不冒充就绪',async t=>{
 const exited=await fixture(t),failure=assert.rejects(waitForHostReady(exited.host,exited.infoPath,{timeoutMs:1000}),{code:'host_startup_exited',running:false});
 exited.child.send('exit');await failure;
 const alive=await fixture(t);await assert.rejects(waitForHostReady(alive.host,alive.infoPath,{timeoutMs:60}),{code:'host_startup_timeout',running:true});
});

test('握手必须属于自有PID且认证状态running，存在文件不等于就绪',async t=>{
 const wrong=await fixture(t,{pid:process.pid}),rejected=assert.rejects(waitForHostReady(wrong.host,wrong.infoPath,{timeoutMs:1000}),{code:'host_handshake_pid_mismatch'});wrong.child.send('publish');await rejected;
 const stopping=await fixture(t,{state:'stopping'}),notReady=assert.rejects(waitForHostReady(stopping.host,stopping.infoPath,{timeoutMs:1000}),{code:'host_runtime_not_running'});stopping.child.send('publish');await notReady;
});
