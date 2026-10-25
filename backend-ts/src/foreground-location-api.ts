/** 公开HTTP业务适配；认证由既有宿主负责，不接受调用方联系人或采集参数。 */
import type {HostStorage} from './host-storage.ts';
import {ForegroundLocator,ForegroundLocationError,type ForegroundProbe,type ForegroundBinding} from './foreground-location-locator.ts';
import {ForegroundSessions} from './foreground-location-sessions.ts';
import type {WechatCliRunner} from './wechat-setup-probe.ts';
export const foregroundLocationPath='/api/sync/foreground/observe';
export interface ForegroundLocationResponse {status:number;body:Record<string,unknown>}
interface Scope {owner:string;account:string;enabled:boolean}

export async function createForegroundLocationApi(options:{storage:HostStorage;probe:ForegroundProbe;executable:string;environment?:NodeJS.ProcessEnv;runner?:WechatCliRunner}) {
  const sessions=new ForegroundSessions(options);
  let activated=false,closed=false,revision=0,mutations=0,observing=false;
  let warmup:Promise<void>|undefined;
  let locator:ForegroundLocator|undefined,locatorScope:Scope|undefined;
  const pending=new Set<Promise<ForegroundLocationResponse>>();
  const accepting=()=>activated&&!closed&&mutations===0;
  const startWarmup=()=>{
    if(!options.probe.start||warmup)return;
    warmup=Promise.resolve().then(()=>options.probe.start!()).catch(()=>{warmup=undefined;});
  };
  // 只准备本机合成图 OCR；在数据库和其余宿主初始化并行时完成模型冷启动。
  startWarmup();
  const scope=async():Promise<Scope>=>{
    const owner=options.storage.runtimeOwnerId?.toLowerCase();
    if(!owner)throw new ForegroundLocationError('foreground_scope_unavailable');
    return options.storage.businessReadTransaction(async client=>{
      const rows=await client.query(`SELECT i.external_id,coalesce(s.enabled,false) AS enabled FROM public.owner_channel_identity i LEFT JOIN public.front_sync_state s ON s.owner_id=i.owner_id WHERE i.owner_id=$1 AND i.channel='wechat' AND i.status='active'`,[owner]);
      if(rows.rows.length!==1)throw new ForegroundLocationError('foreground_scope_unavailable');
      return {owner,account:rows.rows[0].external_id,enabled:rows.rows[0].enabled};
    });
  };
  const makeLocator=(current:Scope)=>new ForegroundLocator({ownerId:current.owner,accountScope:current.account,probe:options.probe,
    sessions:input=>sessions.sessions(input),
    bindings:async(signal,check)=>options.storage.businessReadTransaction(async client=>{
      const account=await client.query("SELECT external_id FROM public.owner_channel_identity WHERE owner_id=$1 AND channel='wechat' AND status='active'",[current.owner]);
      if(account.rows.length!==1||account.rows[0].external_id!==current.account||signal.aborted)throw new ForegroundLocationError('foreground_scope_unavailable');
      const rows=await client.query("SELECT b.id AS binding_id,b.owner_id,b.contact_id,b.channel,b.account_scope,b.conversation_locator,b.display_name,b.status FROM public.conversation_binding b JOIN public.contact c ON c.owner_id=b.owner_id AND c.id=b.contact_id WHERE b.owner_id=$1 AND b.channel='wechat' AND b.account_scope=$2 AND b.status='active'",[current.owner,current.account]);
      check();return rows.rows as ForegroundBinding[];
    }),
  });
  const drain=async()=>{revision++;await locator?.invalidate();await Promise.allSettled([...pending]);};
  const beginAuthorityChange=async()=>{
    mutations++;let released=false;
    const release=()=>{if(!released){released=true;mutations--;}};
    try{await drain();if(closed)throw new ForegroundLocationError('runtime_stopped');return release;}
    catch(error){release();throw error;}
  };
  return {
    /** 仅在旧实现已停收排空后由宿主调用；无逐请求自动回退。 */
    activate(){if(closed)throw new ForegroundLocationError('runtime_stopped');activated=true;revision++;startWarmup();},
    async suspend(){activated=false;await drain();},
    async invalidate(){activated=false;await drain();},
    /** 并发变更全部结束才恢复接收；移交/退出不会被finally重开。 */
    beginAuthorityChange,
    async changeAuthority<T>(operation:()=>Promise<T>):Promise<T>{
      const release=await beginAuthorityChange();try{return await operation();}finally{release();}
    },
    handle(method:string,body:Buffer,signal?:AbortSignal):Promise<ForegroundLocationResponse>{
      const response=(status:number,body:Record<string,unknown>)=>({status,body});
      if(method!=='POST')return Promise.resolve(response(405,{error:'method_not_allowed'}));
      try{const payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));if(!payload||Array.isArray(payload)||typeof payload!=='object'||Object.keys(payload).length)throw new Error();}
      catch{return Promise.resolve(response(400,{error:'foreground_observation_invalid'}));}
      if(!accepting())return Promise.resolve(response(409,{error:'runtime_stopped'}));
      if(observing)return Promise.resolve(response(409,{error:'foreground_observation_busy'}));
      observing=true;
      const expected=revision,deadline=performance.now()+3200,controller=new AbortController();
      const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      const timer=setTimeout(abort,3200);
      const check=()=>{
        if(!accepting()||expected!==revision||signal?.aborted)throw new ForegroundLocationError('foreground_observation_cancelled');
        if(controller.signal.aborted||performance.now()>=deadline)throw new ForegroundLocationError('observation_timeout');
      };
      const run=async():Promise<ForegroundLocationResponse>=>{
        try{
          check();const before=await scope();check();
          if(!locator||locatorScope?.owner!==before.owner||locatorScope.account!==before.account){
            await locator?.invalidate();check();locator=makeLocator(before);locatorScope=before;
          }
          const result=await locator.observe({enabled:before.enabled,signal:controller.signal});check();
          const after=await scope();check();
          if(after.owner!==before.owner||after.account!==before.account||after.enabled!==before.enabled)throw new ForegroundLocationError('foreground_observation_cancelled');
          const age=Date.now()-Date.parse(result.observed_at);
          if(result.phase==='confirmed'&&(!Number.isFinite(age)||age>=5000||age< -1000))throw new ForegroundLocationError('observation_timeout');
          const {recognized_name,recognition_confidence,...rest}=result;
          return response(200,{...rest,...(recognized_name===null?{}:{recognized_name,recognition_confidence})});
        }catch(error){
          await locator?.invalidate();
          const code=(error as {code?:string}).code;
          if(code==='foreground_observation_busy')return response(409,{error:code});
          if(code==='foreground_observation_cancelled'||!accepting())return response(409,{error:'runtime_stopped'});
          return response(503,{error:'foreground_observation_unavailable'});
        }
      };
      const request=run().finally(()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);observing=false;});
      pending.add(request);void request.finally(()=>pending.delete(request)).catch(()=>{});return request;
    },
    async close(){closed=true;activated=false;await drain();await locator?.close();if(!locator)await options.probe.dispose();await sessions.close();},
  };
}

/** 只枚举会改变身份/授权的请求；内部只读状态与后台发现不串入前台锁。 */
export function isForegroundAuthorityMutation(method:string,path:string):boolean {
  if(method==='DELETE')return /^\/api\/(contacts|owner|owners)(?:\/|$)/.test(path);
  if(method!=='POST')return false;
  return path==='/api/runtime/wechat-scope/revoke'
    ||/^\/api\/(sync\/(enable|disable|confirm|confirm-pending|scope|history-authorization|cli-bindings\/(confirm|revoke))|setup\/(initialize|recover-owner|owner|wechat)(?:\/.*)?)$/.test(path);
}
