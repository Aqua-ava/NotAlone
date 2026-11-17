import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID} from 'node:crypto';

export interface ProbeQuality {layout_verified:boolean;display_name_confidence:number;name_complete:boolean}
export interface ProbeTextFallback {version:'isolated-color-tail-v1';text:string;confidence:number;text_complete:boolean;mask_verified:boolean}
export interface ProbeObservation {wechat_in_front:boolean;display_name?:string|null;capture_version?:string;captured_at?:string;quality?:ProbeQuality|null;text_fallback?:ProbeTextFallback}
export class ForegroundProbeError extends Error {
  readonly code:string;
  constructor(code:string) {super(code);this.name='ForegroundProbeError';this.code=code;}
}
const failure=(code='probe_output_invalid')=>new ForegroundProbeError(code);
type Worker={child:ChildProcessWithoutNullStreams;closed:Promise<void>;dead:boolean;ready:boolean;error?:Error;pending?:{resolve:(value:unknown)=>void;reject:(error:Error)=>void};buffer:Buffer};
/** 常驻请求驱动 Worker；启动时只做合成图 OCR 预热，不缓存帧或名称。 */
export class NativeForegroundProbe {
  private worker?:Worker;
  private generation=0;
  private disposed=false;
  private permissionBlocked=false;
  private tail:Promise<void>=Promise.resolve();
  private closing:Promise<void>=Promise.resolve();
  private preparation?:Promise<void>;
  private readonly executable:string;
  private readonly args:readonly string[];
  constructor(options:{executable:string;args?:readonly string[]}) {
    if(!options.executable.trim() || /[\0\r\n]/.test(options.executable)) throw new TypeError('探针可执行文件无效。');
    this.executable=options.executable;this.args=options.args??[];
  }
  resetPermissionGate():void {this.permissionBlocked=false;}
  /** 启动常驻 Worker 并等待合成图预热完成；不截图、不读取微信内容。 */
  async start({timeoutMs=60_000}:{timeoutMs?:number}={}):Promise<void> {
    if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>120_000)throw new TypeError('Worker 预热预算无效。');
    if(this.disposed)throw failure('probe_failed');
    if(this.worker&&!this.worker.dead&&this.worker.ready)return;
    if(this.preparation)return this.preparation;
    const generation=this.generation;
    let worker:Worker|undefined;
    const preparing=(async()=>{
      await this.closing;
      if(this.disposed||generation!==this.generation)throw failure('probe_failed');
      worker=this.worker;
      if(!worker||worker.dead){worker=this.spawn();this.worker=worker;}
      let timer:ReturnType<typeof setTimeout>|undefined;
      const timeout=new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>reject(failure('probe_warmup_timeout')),timeoutMs);
      });
      let ready:unknown;
      try {ready=await Promise.race([this.read(worker),timeout]);}
      finally {clearTimeout(timer);}
      if(!exact(ready,['version','event'])||ready.version!==1||ready.event!=='ready')throw failure();
      if(this.disposed||generation!==this.generation||worker.dead)throw failure('probe_failed');
      worker.ready=true;
    })().catch(async error=>{
      if(worker&&this.worker===worker)this.worker=undefined;
      if(worker&&!worker.dead){
        const failure=error instanceof ForegroundProbeError?error:new ForegroundProbeError('probe_failed');
        worker.dead=true;worker.pending?.reject(failure);worker.pending=undefined;worker.child.kill('SIGKILL');
        this.closing=Promise.all([this.closing,worker.closed]).then(()=>{});
      }
      throw error instanceof ForegroundProbeError?error:failure('probe_failed');
    });
    let tracked!:Promise<void>;
    tracked=preparing.finally(()=>{
      if(this.preparation===tracked)this.preparation=undefined;
    });
    this.preparation=tracked;
    return tracked;
  }
  async close():Promise<void> {
    ++this.generation;
    this.preparation=undefined;
    const worker=this.worker;this.worker=undefined;
    if(worker){worker.dead=true;worker.pending?.reject(failure('probe_failed'));worker.pending=undefined;worker.child.kill('SIGKILL');this.closing=Promise.all([this.closing,worker.closed]).then(()=>{});}
    await this.closing;
  }
  async dispose():Promise<void> {this.disposed=true;await this.close();}
  async observe({signal,timeoutMs=2500}:{signal?:AbortSignal;timeoutMs?:number}={}):Promise<ProbeObservation> {
    if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>2500)throw new TypeError('新观察的探针预算超出有界范围。');
    if(this.disposed)throw failure('probe_failed');
    if(this.permissionBlocked)throw failure('screen_capture_permission_missing');
    const generation=this.generation;const deadline=performance.now()+timeoutMs;
    const prior=this.tail;let release!:()=>void;
    this.tail=new Promise<void>(resolve=>{release=resolve;});
    let timer:ReturnType<typeof setTimeout>|undefined;
    let requestSent=false;
    let rejectGuard!:(error:Error)=>void;
    const guard=new Promise<never>((_,reject)=>{rejectGuard=reject;});
    const abort=()=>{rejectGuard(failure('probe_failed'));void this.close();};
    signal?.addEventListener('abort',abort,{once:true});
    timer=setTimeout(()=>{
      const warming=!requestSent&&Boolean(this.preparation)&&!this.worker?.ready;
      rejectGuard(failure(warming?'probe_warming':'probe_timeout'));
      if(!warming)void this.close();
    },timeoutMs);
    const current=()=>{if(this.disposed||generation!==this.generation||signal?.aborted)throw failure('probe_failed');if(performance.now()>=deadline)throw failure('probe_timeout');};
    const work=async()=>{
      await prior;current();await this.closing;current();
      let worker=this.worker;
      if(worker?.dead){if(worker.error)throw worker.error;await worker.closed;current();}
      if(!worker||worker.dead||!worker.ready){await this.start();current();worker=this.worker;}
      if(!worker||worker.dead||!worker.ready)throw failure('probe_warming');
      current();const request_id=randomUUID();
      const response=this.read(worker);
      requestSent=true;
      worker.child.stdin.write(JSON.stringify({version:1,request_id,operation:'observe'})+'\n',error=>{if(error)worker!.pending?.reject(failure('probe_failed'));});
      const value=await response;current();
      if(!exact(value,['version','request_id','result'])||value.version!==1||value.request_id!==request_id||!object(value.result))throw failure();
      return parseObservation(value.result);
    };
    if(signal?.aborted)abort();
    try{return await Promise.race([work(),guard]);}
    catch(error){
      if(error instanceof ForegroundProbeError&&error.code==='probe_warming')throw error;
      if(error instanceof ForegroundProbeError && error.code==='screen_capture_permission_missing')this.permissionBlocked=true;
      await this.close();throw error instanceof ForegroundProbeError?error:failure('probe_failed');
    }
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);release();}
  }
  private read(worker:Worker):Promise<unknown> {
    if(worker.dead)return Promise.reject(failure('probe_failed'));
    return new Promise((resolve,reject)=>{worker.pending={resolve,reject};});
  }
  private spawn():Worker {
    const child=spawn(this.executable,[...this.args,'--session-worker','--json'],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'}});
    let closed!:()=>void;
    const worker:Worker={child,dead:false,ready:false,buffer:Buffer.alloc(0),closed:new Promise(resolve=>{closed=resolve;})};
    const reject=(error:Error)=>{worker.dead=true;worker.error=error;worker.pending?.reject(error);worker.pending=undefined;child.kill('SIGKILL');};
    child.stderr.resume();
    child.stdout.on('error',()=>reject(failure('probe_failed')));
    child.stderr.on('error',()=>reject(failure('probe_failed')));
    child.stdin.on('error',()=>reject(failure('probe_failed')));
    child.on('error',(error:NodeJS.ErrnoException)=>reject(failure(error.code==='ENOENT'?'probe_not_found':'probe_failed')));
    child.on('close',()=>{worker.dead=true;worker.ready=false;worker.pending?.reject(failure('probe_failed'));worker.pending=undefined;closed();});
    child.stdout.on('data',(chunk:Buffer)=>{
      if(worker.dead)return;
      if(!worker.pending){reject(failure());return;}
      worker.buffer=Buffer.concat([worker.buffer,chunk]);
      const newline=worker.buffer.indexOf(10);
      if(worker.buffer.length>65536 || (newline<0&&worker.buffer.length>=65536)){reject(failure());return;}
      if(newline<0)return;
      if(newline!==worker.buffer.length-1){reject(failure());return;}
      try {const text=new TextDecoder('utf-8',{fatal:true}).decode(worker.buffer);const value=strictJson(text);const pending=worker.pending;worker.pending=undefined;worker.buffer=Buffer.alloc(0);pending.resolve(value);}
      catch{reject(failure());}
    });
    return worker;
  }
}
function object(value:unknown):value is Record<string,any>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function exact(value:unknown,keys:string[]):value is Record<string,any>{return object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));}
const probeErrors = new Set([
  'probe_not_found','probe_timeout','probe_warming','probe_warmup_timeout','probe_output_invalid','probe_failed','screen_capture_permission_missing',
  'foreground_application_unavailable','calibration_wechat_instances_ambiguous','calibration_wechat_version_unsupported',
  'calibration_window_not_visible','calibration_windows_ambiguous','calibration_window_geometry_invalid','calibration_context_unavailable',
  'automatic_capture_context_changed','automatic_capture_window_metadata_changed','automatic_capture_scale_invalid','automatic_capture_dimensions_changed',
  'automatic_layout_vertical_boundary','automatic_layout_header_boundary','automatic_layout_selection_ambiguous','automatic_layout_sidebar_boundary',
  'minimal_region_layout_unverified','minimal_region_layout_changed','quality_unverified','header_name_unreadable','row_name_unreadable',
  'session_names_mismatch','session_name_confidence_low','minimal_region_capture_failed','wechat_not_in_front',
]);
/** 原生与领域边界共享的错误码过滤；未知输出不可进入公共消息。 */
export function safeForegroundProbeCode(value:unknown):string {return typeof value==='string'&&probeErrors.has(value)?value:'probe_failed';}
const versions=new Set(['automatic-header-v3','automatic-header-v4']);
const confidence=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;
function utcTime(value:unknown):value is string {
  if(typeof value!=='string'||Number(value.slice(0,4))<1||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value))return false;
  const time=Date.parse(value);
  return Number.isFinite(time)&&new Date(time).toISOString().slice(0,19)===value.slice(0,19);
}
function parseObservation(value:Record<string,any>):ProbeObservation {
  if(value.ok!==true)throw failure(safeForegroundProbeCode(value.error));
  if(typeof value.wechat_in_front!=='boolean')throw failure();
  if(!value.wechat_in_front)return {wechat_in_front:false};
  const version=value.capture_version;
  if(!versions.has(version))throw failure();
  const required=['ok','wechat_in_front','display_name','capture_version','captured_at','quality'];
  const allowed=version==='automatic-header-v4'?[...required,'text_fallback']:required;
  if(!required.every(key=>Object.hasOwn(value,key))||Object.keys(value).some(key=>!allowed.includes(key))
    ||value.display_name!==null&&typeof value.display_name!=='string'||!utcTime(value.captured_at))throw failure();
  const result:ProbeObservation={wechat_in_front:true,display_name:value.display_name,capture_version:version,captured_at:value.captured_at,quality:null};
  const quality=value.quality;
  if(quality!=null){
    const fields=['layout_verified','display_name_confidence','name_complete'];
    if(!object(quality)||Object.keys(quality).some(key=>!fields.includes(key)))throw failure();
    if(fields.every(key=>Object.hasOwn(quality,key))){
      if(typeof quality.layout_verified!=='boolean'||!confidence(quality.display_name_confidence)
        ||typeof quality.name_complete!=='boolean')throw failure();
      if(quality.layout_verified)result.quality=quality as ProbeQuality;
    }
  }
  if(Object.hasOwn(value,'text_fallback')){
    const fallback=value.text_fallback;
    if(version!=='automatic-header-v4'||!exact(fallback,['version','text','confidence','text_complete','mask_verified'])
      ||fallback.version!=='isolated-color-tail-v1'||typeof fallback.text!=='string'||!fallback.text.trim()
      ||Array.from(fallback.text).length>256||/[\r\n]|…|⋯|\.\.\./.test(fallback.text)||!confidence(fallback.confidence)
      ||typeof fallback.text_complete!=='boolean'||typeof fallback.mask_verified!=='boolean')throw failure();
    result.text_fallback=fallback as ProbeTextFallback;
  }
  return result;
}

// JSON.parse 本身拒绝非法数值；另扫描每层键，防止重复键被静默覆盖。
function strictJson(text:string):unknown {
  const parsed=JSON.parse(text);
  const finite=(value:unknown):void=>{if(typeof value==='number'&&!Number.isFinite(value))throw failure();if(value&&typeof value==='object')for(const item of Object.values(value))finite(item);};finite(parsed);
  const stack:Array<Set<string>|null>=[];
  for(let index=0;index<text.length;index++){
    const char=text[index];
    if(char==='{'||char==='[')stack.push(char==='{'?new Set():null);
    else if(char==='}'||char===']')stack.pop();
    else if(char==='"'){
      const start=index++;
      while(index<text.length){if(text[index]==='\\'){index+=2;continue;}if(text[index]==='"')break;index++;}
      let next=index+1;while(/\s/.test(text[next]??'')&&next<text.length)next++;
      if(text[next]===':'){const key=JSON.parse(text.slice(start,index+1));const fields=stack.at(-1);if(!fields||fields.has(key))throw failure();fields.add(key);if(key==='version'){const token=text.slice(next+1).trimStart();if(/^-?\d/.test(token)&&! /^-?\d+(?=\s*[,}])/.test(token))throw failure();}}
    }
  }
  return parsed;
}
