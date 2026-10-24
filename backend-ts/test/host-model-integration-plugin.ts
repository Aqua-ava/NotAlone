/** 合成官方profile专用插件；测试控制入口不进入产品宿主。 */
import type {} from '@deepseek-ai/dsh-cmdline';
import type {Context} from '@deepseek-ai/cordis';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {PUBLIC_BASE_URL} from '@deepseek-ai/dsh-llm-deepseek';
import {HostStorage} from '../src/host-storage.ts';
import {startHostModelRuntime,HostModelRuntimeError} from '../src/host-model-runtime.ts';
export const name='notalone-model-integration-test';
export const inject=['llm','agents','sessions','tools','systemPrompt','skills','appReady'];
export async function apply(ctx:Context){
 const businessHome=process.env.NOTALONE_SYNTHETIC_BUSINESS!,envFilePath=process.env.NOTALONE_SYNTHETIC_ENV!;
 const storage=await HostStorage.open({envFilePath,environment:{HOME:businessHome},
   migrationsDirectory:new URL('../../backend/database/migrations',import.meta.url).pathname});
 if((await storage.compatibility()).code!=='ready')throw Error('合成schema不兼容');
 const environment=storage.runtimeEnvironment();
 if(!/^host=\/tmp dbname=notalone_ts_host_[a-f0-9]+_test$/.test(environment.NOTALONE_DATABASE_URL??''))throw Error('仅允许随机合成库');
 const options={ctx,storage,environment,businessHome,projectDirectory:new URL('../../',import.meta.url).pathname,
   infoPath:join(businessHome,'backend.info'),envFilePath};
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{
   if(typeof input!=='string'||input!==PUBLIC_BASE_URL+'/v1/messages')throw Error('合成适配器不允许其他fetch');
   return originalFetch(process.env.NOTALONE_SYNTHETIC_PROVIDER_URL!+'/anthropic/v1/messages',init);
 };
 let runtime:Awaited<ReturnType<typeof startHostModelRuntime>>;
 try{runtime=await startHostModelRuntime(options);}catch(error){globalThis.fetch=originalFetch;await storage.close();throw error;}
 const server=createServer(async(req,res)=>{
  if((req.url??'').startsWith('/internal/reply')){await runtime!.handle(req,res);return;}
  res.setHeader('content-type','application/json');
  if(req.headers.authorization!=='Bearer '+process.env.NOTALONE_SYNTHETIC_CONTROL_TOKEN){res.writeHead(401);res.end('{}');return;}
  try{
   const address=server.address();if(!address||typeof address==='string')throw Error('未监听');
   const base=`http://127.0.0.1:${address.port}`;
   if(req.url==='/bridge'){
    const anonymous=await readFile(join(dirname(runtime!.statePath),'identity/.anonymous-user-id'),'utf8');
    const recovered=(await storage.businessReadTransaction(client=>client.query("SELECT count(*)::int n FROM model_call_receipt WHERE outcome='unknown'"))).rows[0].n;
    res.end(JSON.stringify({environment:runtime!.pythonEnvironment(base),statePath:runtime!.statePath,
      anonymousId:anonymous.trim(),recoveredUnknown:runtime!.recoveredUnknown,unknownRows:recovered}));return;
   }
   if(req.url==='/restart'){
    await runtime!.close(async()=>{});runtime=await startHostModelRuntime(options);
    res.end('{"restarted":true}');return;
   }
   if(req.url==='/startup-failure'){
    await runtime!.close(async()=>{});
    const broken=Object.create(ctx);Object.defineProperty(broken,'llm',{value:{registerAdapter(){throw Error('synthetic-provider-init');}}});
    let rejected=false;
    try{await startHostModelRuntime({...options,ctx:broken});}catch(error){rejected=error instanceof Error&&error.message==='synthetic-provider-init';}
    if(!rejected)throw Error('合成提供者故障未拒绝');
    runtime=await startHostModelRuntime(options); // 同journal原位重启成功证明失败资源已释放。
    res.end('{"recovered":true}');return;
   }
   if(req.url==='/python-control'||req.url==='/unconfirmed'){
    const pythonEnvironment=runtime!.pythonEnvironment(base);
    const code="from notalone.server.model_control import build_model_priority_control\nc=build_model_priority_control(background_limit=2)\n"+
      (req.url==='/python-control'?"with c.foreground(): pass\nc.stop()\nprint(type(c).__name__)":
       "import json,os\nfrom uuid import UUID\nr=c.unconfirmed_requests(UUID(os.environ['SYNTHETIC_OWNER']),UUID(os.environ['SYNTHETIC_CONTACT']))\nc.stop()\nprint(json.dumps(sorted(str(v) for v in r)))");
    const {stdout}=await promisify(execFile)(process.env.NOTALONE_SYNTHETIC_PYTHON!,['-c',code],{
      cwd:options.projectDirectory,timeout:10000,env:{PATH:process.env.PATH,USER:process.env.USER,HOME:businessHome,
        PYTHONPATH:join(options.projectDirectory,'backend/src'),PYTHONDONTWRITEBYTECODE:'1',NOTALONE_DISABLE_DOTENV:'1',NOTALONE_TS_HOST:'1',
        SYNTHETIC_OWNER:storage.runtimeOwnerId!,SYNTHETIC_CONTACT:process.env.NOTALONE_SYNTHETIC_CONTACT,...pythonEnvironment}});
    res.end(JSON.stringify(req.url==='/python-control'?{control:stdout.trim()}:{requests:JSON.parse(stdout)}));return;
   }
   if(req.url==='/close'){
    await runtime!.close(async()=>{});res.end('{"closed":true}');return;
   }
   res.writeHead(404);res.end('{}');
  }catch(error){res.writeHead(503);res.end(JSON.stringify({error:error instanceof HostModelRuntimeError?error.code:'synthetic-control-failed'}));}
 });
 const ready=ctx.appReady!.onReady(()=>server.listen(0,'127.0.0.1',()=>{
  const address=server.address();if(address&&typeof address!=='string')process.stdout.write(`VALIDATION_READY http://127.0.0.1:${address.port}\n`);
 }));
 ctx.effect(()=>async()=>{
  ready();runtime?.stopAccepting();server.closeAllConnections();
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  try{await runtime?.close(async()=>{});}finally{await storage.close();globalThis.fetch=originalFetch;}
 });
}
