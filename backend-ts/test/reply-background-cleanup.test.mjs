import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
let cleanupB5BackgroundFixture;
try{({cleanupB5BackgroundFixture}=await import('./reply-background-cleanup.mjs'));}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const sourcePath=process.env.NOTALONE_B501_CLEANUP_SOURCE??new URL('./reply-background-public.test.mjs',import.meta.url);
const source=await readFile(sourcePath,'utf8'),start=source.indexOf(' t.after(async()=>{'),end=source.indexOf('\n });',start)+5;assert.ok(start>=0&&end>start);
const hook=source.slice(start,end);
function fixture({providerError,clientError,shutdownError,spawned=true,legacyKnown=true,childState='normal',hung=false,control=false,evidenceError,queryError}={}){
 const calls=[];let after,proof;const providerOriginal=providerError;
 const child=spawned?{pid:100,exitCode:childState==='normal'?0:null,signalCode:childState==='forced'?'SIGKILL':null,kill:signal=>calls.push('signal:'+signal)}:undefined;
 let hostExit;const exited=hung?new Promise(()=>{}):Promise.resolve([childState==='forced'?null:0,childState==='forced'?'SIGKILL':null]);
 const f={directory:'synthetic-fixture',client:{database:'synthetic_test',query:async()=>{if(queryError)throw queryError;return{rows:[{n:0}]};},end:async()=>{calls.push('client');if(clientError)throw clientError;}},close:async()=>calls.push('dispose')};
 const sandbox={t:{after:fn=>after=fn},cleanupB5BackgroundFixture,cleanupStageTimeoutMs:15,control:control?{listening:false,closeAllConnections:()=>calls.push('control')}:undefined,child,exited,legacyPid:legacyKnown&&spawned?200:undefined,releaseLate:()=>calls.push('release'),provider:{listening:false,closeAllConnections(){calls.push('provider');if(providerOriginal)throw providerOriginal;}},f,request:async()=>{calls.push('shutdown');if(shutdownError)throw shutdownError;return{data:{state:'stopped'}};},writeArtifact:async(name,value)=>{if(name==='cleanup.json')proof=value;calls.push(name==='cleanup.json'?'proof':'evidence');if(name==='execution-private.json'&&evidenceError)throw evidenceError;},process:{kill(){const e=Error('gone');e.code='ESRCH';throw e;}},seen:[],requests:[],checkpoints:[],output:'',setTimeout:()=>({}),clearTimeout:()=>{}};
 vm.runInNewContext(hook,sandbox);return{calls,after:()=>after(),proof:()=>proof,child};
}
test('B5-01实际afterhook：provider失败仍释放本机client、保留DB/temp与原异常',async()=>{
 const original=Error('synthetic-provider-failure'),f=fixture({providerError:original});
 await assert.rejects(f.after(),e=>e===original||e.errors?.includes(original));
 assert.ok(f.calls.includes('client'),'provider失败后仍须释放自己的PG client');
 assert.ok(!f.calls.includes('dispose'),'provider失败不能DROP库或删除临时目录');
 assert.equal(f.proof().fixtureRetained,true);
});

for(const interactive of [false,true])test(`B5-01${interactive?'交互':'非交互'}：原spawn退出等待有界，超时仍释放独立资源并保留现场`,async()=>{
 const f=fixture({childState:'running',hung:true,control:interactive}),started=Date.now();
 let timer;try{const outcome=await Promise.race([f.after().then(()=>({completed:true}),error=>({error})),new Promise(resolve=>timer=setTimeout(()=>resolve({externalTimeout:true}),150))]);assert.ok(outcome.error?.errors?.some(e=>e.code==='CLEANUP_TIMEOUT'),'实际hook须自行有界失败，不能依赖外部测试计时器');}finally{clearTimeout(timer);}
 assert.ok(Date.now()-started<1000);assert.ok(f.calls.includes('provider')&&f.calls.includes('client'));if(interactive)assert.ok(f.calls.includes('control'));
 assert.ok(!f.calls.includes('dispose'));assert.equal(f.proof().fixtureRetained,true);
});
for(const childState of ['forced','running'])test(`B5-01${childState}：不确定或强退不DROP库/临时目录`,async()=>{
 const original=childState==='running'?Error('synthetic-shutdown-failure'):undefined;
 const f=fixture({childState,shutdownError:original});await assert.rejects(f.after(),error=>!original||error.errors.includes(original));
 assert.ok(f.calls.includes('provider')&&f.calls.includes('client'));assert.ok(!f.calls.includes('dispose'));assert.equal(f.proof().fixtureRetained,true);
});
test('B5-01 Legacy身份未确认时保留现场',async()=>{
 const f=fixture({legacyKnown:false});await assert.rejects(f.after());assert.ok(!f.calls.includes('dispose'));assert.equal(f.proof().fixtureRetained,true);
});
for(const interactive of [false,true])test(`B5-01${interactive?'交互':'非交互'}：正常host与Legacy退出确认后才删除自有现场`,async()=>{
 const f=fixture({control:interactive});await f.after();assert.ok(f.calls.indexOf('client')<f.calls.indexOf('dispose'));assert.ok(f.calls.includes('provider'));if(interactive)assert.ok(f.calls.includes('control'));
 assert.equal(f.proof().state,'cleaned');assert.equal(f.proof().fixtureRetained,false);
});
test('B5-01 host从未spawn可释放自有fixture',async()=>{
 const f=fixture({spawned:false});await f.after();assert.ok(f.calls.includes('client')&&f.calls.includes('dispose'));assert.equal(f.proof().state,'cleaned');
});
test('B5-01 provider/client各自失败保留两份原异常',async()=>{
 const a=Error('synthetic-provider'),b=Error('synthetic-client'),f=fixture({providerError:a,clientError:b});
 await assert.rejects(f.after(),error=>error.errors.includes(a)&&error.errors.includes(b)&&error.cause===a);
 assert.ok(!f.calls.includes('dispose'));assert.equal(f.proof().fixtureRetained,true);
});
test('B5-01保存原证据失败仍释放本机client并保留现场',async()=>{
 const original=Error('synthetic-evidence-write'),f=fixture({evidenceError:original});await assert.rejects(f.after(),error=>error.errors.includes(original));
 assert.ok(f.calls.includes('client'));assert.ok(!f.calls.includes('dispose'));assert.equal(f.proof().fixtureRetained,true);
});

test('正式放置未给artifact环境时创建自有0700目录',async()=>{
 const {prepareB5ArtifactDirectory}=await import('./reply-background-cleanup.mjs');assert.equal(typeof prepareB5ArtifactDirectory,'function');
 const {stat,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');const directory=await prepareB5ArtifactDirectory(undefined);
 try{assert.ok(directory.startsWith(join(tmpdir(),'notalone-b5-raw-')));assert.equal((await stat(directory)).mode&0o777,0o700);}finally{await rm(directory,{recursive:true,force:true});}
});
test('显式artifact目录逐字保留，纯准备不创建或改写它',async()=>{
 const {prepareB5ArtifactDirectory}=await import('./reply-background-cleanup.mjs');assert.equal(typeof prepareB5ArtifactDirectory,'function');
 const {stat}=await import('node:fs/promises');const directory='/tmp/notalone-b5-explicit-never-created';assert.equal(await prepareB5ArtifactDirectory(directory),directory);await assert.rejects(stat(directory),{code:'ENOENT'});
});

test('核查数据库连接与关闭client同时失败仍保留两份原异常',async()=>{
 const a=Error('synthetic-query-failure'),b=Error('synthetic-end-failure'),f=fixture({queryError:a,clientError:b});
 const contains=(error,target)=>error===target||error.cause&&contains(error.cause,target)||error.errors?.some(e=>contains(e,target));
 await assert.rejects(f.after(),error=>contains(error,a)&&contains(error,b));assert.ok(!f.calls.includes('dispose'));assert.equal(f.proof().fixtureRetained,true);
});
