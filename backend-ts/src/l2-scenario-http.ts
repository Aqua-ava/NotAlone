/** L2共享宿主的私有Worker入口与已认证公共管理薄桥；profile修正仍回放旧执行方。 */
import type {IncomingMessage,ServerResponse} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {parseJson,stringifyJson} from './host-json.ts';
import {readWechatHttpBody,WechatHttpBodyError} from './wechat-http-body.ts';
import {
  L2ScenarioConflict,
  type L2ScenarioClaim,
  type L2ScenarioManagement,
} from './l2-scenario-service.ts';
import {L2ScenarioError,type L2ScenarioScope} from './l2-scenario-workspace.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const claimKeys=['task_id','step_id','step_name','worker_id','lease_generation'] as const;
const managementKeys=[
  'settings_generation','organization_generation','target_kind','version_id','item_index','reason','operation_id',
] as const;

export interface L2ScenarioHttpService {
  run(scope:L2ScenarioScope,claim:L2ScenarioClaim,signal:AbortSignal):Promise<{
    state:Record<string,unknown>;
    status:'completed'|'idle';
    processed_count:number;
  }>;
  read(scope:L2ScenarioScope,mappingCursor:string|null,signal:AbortSignal):Promise<Record<string,unknown>>;
  reportParagraphError(
    scope:L2ScenarioScope,
    command:L2ScenarioManagement,
    signal:AbortSignal,
  ):Promise<Record<string,unknown>>;
  withdrawScenario(
    scope:L2ScenarioScope,
    settingsGeneration:number,
    organizationGeneration:number,
    versionId:string,
    signal:AbortSignal,
  ):Promise<Record<string,unknown>>;
}

export interface L2ScenarioHttpOptions {
  ownerId?:string;
  token:string;
  service?:L2ScenarioHttpService;
}

export interface L2ScenarioHttpResult {
  handled:boolean;
  /** 已读取但应由旧执行方处理的请求体；未发生回放时不携带。 */
  replayBody?:Buffer;
}

function object(value:unknown):value is Record<string,any>{
  return Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
}

function exact(value:unknown,keys:readonly string[]):value is Record<string,any>{
  return object(value)&&Object.keys(value).sort().join('|')===[...keys].sort().join('|');
}

function identifier(value:unknown):value is string{
  return typeof value==='string'&&UUID.test(value);
}

function scopeValue(value:unknown,ownerId:string):L2ScenarioScope{
  if(
    !exact(value,['owner_id','contact_id'])
    || value.owner_id!==ownerId
    || value.contact_id!==null&&!identifier(value.contact_id)
  ) throw new L2ScenarioError('l2_scenario_scope_invalid');
  return {owner_id:ownerId,contact_id:value.contact_id};
}

function claimValue(value:unknown):L2ScenarioClaim{
  if(
    !exact(value,claimKeys)
    || !identifier(value.task_id)
    || !identifier(value.step_id)
    || value.step_name!=='organize_memory'
    || !identifier(value.worker_id)
    || !Number.isSafeInteger(value.lease_generation)
    || value.lease_generation<1
  ) throw new L2ScenarioError('l2_scenario_claim_invalid');
  return {
    task_id:value.task_id,
    step_id:value.step_id,
    step_name:'organize_memory',
    worker_id:value.worker_id,
    lease_generation:value.lease_generation,
  };
}

function statusFor(error:unknown):{status:number;error:string}{
  if(error instanceof WechatHttpBodyError)return {status:error.status,error:error.code};
  const code=object(error)&&typeof error.code==='string'?error.code:undefined;
  if(code){
    if(code==='l2_scenario_not_found')return {status:404,error:code};
    if([
      'l2_scenario_scope_invalid','l2_scenario_claim_invalid','l2_scenario_management_invalid',
      'l2_scenario_mapping_cursor_invalid','l2_scenario_budget_invalid',
    ].includes(code)) return {status:400,error:code};
    if(
      /_(?:stale|changed|conflict|required|disabled|not_found|no_changes)$/.test(code)
      || ['l2_scenario_source_processing','l2_scenario_source_unavailable'].includes(code)
    ) return {status:409,error:code};
  }
  if(error instanceof L2ScenarioConflict)return {status:409,error:error.code};
  if(error instanceof L2ScenarioError){
    return {status:503,error:'layered_memory_unavailable'};
  }
  return {status:503,error:'layered_memory_unavailable'};
}

function localRequest(req:IncomingMessage):boolean{
  return ['127.0.0.1','::ffff:127.0.0.1','::1'].includes(req.socket.remoteAddress??'');
}

function publicLayeredPath(path:string):boolean{
  return path==='/api/memories/owner/layered-memory'
    || /^\/api\/contacts\/[^/]+\/layered-memory$/.test(path)
    || path==='/api/memories/owner/layered-memory/summary-error'
    || path==='/api/memories/owner/layered-memory/withdraw-scenario'
    || /^\/api\/contacts\/[^/]+\/layered-memory\/(?:summary-error|withdraw-scenario)$/.test(path);
}

export function createL2ScenarioHttp(options:L2ScenarioHttpOptions){
  if(options.token.length<32||!/^[\x21-\x7e]+$/.test(options.token))
    throw new Error('layered_memory_http_config_invalid');
  if(options.ownerId!==undefined&&!identifier(options.ownerId))
    throw new Error('layered_memory_http_config_invalid');
  const expected=Buffer.from(`Bearer ${options.token}`);
  const respond=(res:ServerResponse,status:number,body:unknown)=>{
    if(res.destroyed||res.writableEnded)return;
    res.writeHead(status,{
      'Content-Type':'application/json; charset=utf-8',
      'Cache-Control':'no-store',
      Connection:'close',
    });
    res.end(stringifyJson(body));
  };
  const readJson=async(req:IncomingMessage,limit:number):Promise<{value:unknown;bytes:Buffer}>=>{
    if((req.headers['content-type']??'').split(';')[0].trim()!=='application/json')
      throw new L2ScenarioError('l2_scenario_management_invalid');
    const bytes=await readWechatHttpBody(req,limit);
    try{return {value:parseJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),bytes};}
    catch{throw new L2ScenarioError('l2_scenario_management_invalid');}
  };
  return {
    /** 原唯一Worker专用；token与正文都不由模型或公开桌面路径提供。 */
    async handlePrivate(req:IncomingMessage,res:ServerResponse):Promise<boolean>{
      if(!(req.url??'').startsWith('/internal/layered-memory'))return false;
      const supplied=Buffer.from(typeof req.headers.authorization==='string'?req.headers.authorization:'');
      const authCount=req.rawHeaders.filter((_,index)=>index%2===0&&req.rawHeaders[index].toLowerCase()==='authorization').length;
      if(
        !localRequest(req)
        || authCount!==1
        || req.headers.origin!==undefined
        || supplied.length!==expected.length
        || !timingSafeEqual(supplied,expected)
      ){
        respond(res,401,{error:'unauthorized'});
        return true;
      }
      if(req.method!=='POST'||req.url!=='/internal/layered-memory/run'){
        respond(res,404,{error:'not_found'});
        return true;
      }
      if(!options.ownerId||!options.service){
        respond(res,503,{error:'layered_memory_unavailable'});
        return true;
      }
      const controller=new AbortController();
      const abort=()=>controller.abort();
      req.once('aborted',abort);
      res.once('close',abort);
      try{
        const {value:body}=await readJson(req,16*1024);
        if(!exact(body,['scope','claim']))throw new L2ScenarioError('l2_scenario_management_invalid');
        const scope=scopeValue(body.scope,options.ownerId);
        const claim=claimValue(body.claim);
        controller.signal.throwIfAborted();
        const result=await options.service.run(scope,claim,controller.signal);
        controller.signal.throwIfAborted();
        respond(res,200,result);
      }catch(error){
        if(!controller.signal.aborted){
          const failure=statusFor(error);
          respond(res,failure.status,{error:failure.error});
        }
      }finally{
        req.removeListener('aborted',abort);
        res.removeListener('close',abort);
      }
      return true;
    },

    /** 只在主宿主已经完成公开token认证后调用。 */
    async handlePublic(req:IncomingMessage,res:ServerResponse,url:URL):Promise<L2ScenarioHttpResult>{
      if(!publicLayeredPath(url.pathname))return {handled:false};
      if(!options.ownerId||!options.service){
        respond(res,503,{error:'layered_memory_unavailable'});
        return {handled:true};
      }
      const ownerPath=url.pathname.startsWith('/api/memories/owner/layered-memory');
      const contactMatch=!ownerPath?/^\/api\/contacts\/([^/]+)\/layered-memory/.exec(url.pathname):null;
      const contactId=contactMatch?.[1]??null;
      if(!ownerPath&&(!contactId||!identifier(contactId))){
        respond(res,400,{error:'layered_memory_request_invalid'});
        return {handled:true};
      }
      const scope:L2ScenarioScope={owner_id:options.ownerId,contact_id:ownerPath?null:contactId};
      const action=ownerPath
        ? url.pathname.slice('/api/memories/owner/layered-memory'.length)
        : url.pathname.slice(`/api/contacts/${contactId}/layered-memory`.length);
      const controller=new AbortController();
      const abort=()=>controller.abort();
      req.once('aborted',abort);
      res.once('close',abort);
      try{
        if(!action){
          if(req.method!=='GET'){
            respond(res,405,{error:'method_not_allowed'});
            return {handled:true};
          }
          if(
            [...url.searchParams.keys()].some(key=>key!=='mapping_cursor')
            || url.searchParams.getAll('mapping_cursor').length>1
          ) throw new L2ScenarioError('l2_scenario_mapping_cursor_invalid');
          const cursor=url.searchParams.get('mapping_cursor');
          const state=await options.service.read(scope,cursor,controller.signal);
          controller.signal.throwIfAborted();
          respond(res,200,{layered_memory:state});
          return {handled:true};
        }
        if(req.method!=='POST'){
          respond(res,405,{error:'method_not_allowed'});
          return {handled:true};
        }
        if(url.search)throw new L2ScenarioError('l2_scenario_management_invalid');
        const {value:body,bytes}=await readJson(req,64*1024);
        if(action==='/summary-error'&&object(body)&&body.target_kind==='profile')
          return {handled:false,replayBody:bytes};
        if(action==='/summary-error'){
          if(
            !exact(body,managementKeys)
            || body.target_kind!=='scenario'
            || !identifier(body.version_id)
            || !identifier(body.operation_id)
          ) throw new L2ScenarioError('l2_scenario_management_invalid');
          const command:L2ScenarioManagement={
            settings_generation:body.settings_generation,
            organization_generation:body.organization_generation,
            version_id:body.version_id,
            item_index:body.item_index,
            operation_id:body.operation_id,
            reason:body.reason,
          };
          const state=await options.service.reportParagraphError(scope,command,controller.signal);
          controller.signal.throwIfAborted();
          respond(res,200,{layered_memory:state});
          return {handled:true};
        }
        if(action==='/withdraw-scenario'){
          if(!exact(body,['settings_generation','organization_generation','scenario_version_id']))
            throw new L2ScenarioError('l2_scenario_management_invalid');
          const state=await options.service.withdrawScenario(
            scope,
            body.settings_generation,
            body.organization_generation,
            body.scenario_version_id,
            controller.signal,
          );
          controller.signal.throwIfAborted();
          respond(res,200,{layered_memory:state});
          return {handled:true};
        }
        return {handled:false};
      }catch(error){
        if(!controller.signal.aborted){
          const failure=statusFor(error);
          respond(res,failure.status,{error:failure.error});
        }
        return {handled:true};
      }finally{
        req.removeListener('aborted',abort);
        res.removeListener('close',abort);
      }
    },
  };
}
