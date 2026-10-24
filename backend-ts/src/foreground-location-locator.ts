/** 前台定位只投影当轮名称与已验证身份，不读取正文、不改变绑定或后台同步。 */
import {randomUUID} from 'node:crypto';
import {safeForegroundProbeCode} from './foreground-location-probe.ts';
import {canonicalSessionName, matchSessionNames} from './foreground-location-name-matching.ts';

export interface ForegroundProbeObservation {
  wechat_in_front: boolean; display_name?: string | null; captured_at?: string | null;
  capture_version?: string; selected_row_name?: string | null;
  quality?: {layout_verified?: boolean;display_name_confidence:number;name_complete?:boolean;selected_row_name_confidence?:number} | null;
  text_fallback?: {version:string;text:string;confidence:number;text_complete:boolean;mask_verified:boolean} | null;
}
export interface ForegroundProbe {
  observe(options:{signal?:AbortSignal;timeoutMs:number}):Promise<ForegroundProbeObservation>;
  close():Promise<void>;
  dispose():Promise<void>;
}
export interface ForegroundSession {username:string;display_name:string;chat_type:string}
export interface ForegroundBinding {
  binding_id:string;contact_id:string;owner_id:string;channel:string;account_scope:string;
  conversation_locator:string;display_name:string|null;status:string;
}
export interface ForegroundObservation {
  observation_id:string;observed_at:string;phase:'confirmed'|'paused'|'manual-required'|'unavailable';
  reason:string;probe_available:boolean;wechat_in_front:boolean;binding_id:string|null;contact_id:string|null;
  recognized_name:string|null;recognition_confidence:number|null;
}
export class ForegroundLocationError extends Error {
  readonly code:string;
  constructor(code:string) {super('前台联系人定位暂不可用。');this.code=code;}
}
export interface ForegroundLocatorOptions {
  ownerId:string;accountScope:string;probe:ForegroundProbe;
  sessions(options:{signal:AbortSignal;timeoutMs:number;keyword?:string;limit:number}):Promise<readonly ForegroundSession[]>;
  bindings(signal:AbortSignal,check:()=>void):Promise<readonly ForegroundBinding[]>;
  clock?:()=>number;
}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
// 与旧Python split一致：含Unicode信息分隔符，排除BOM。
const whitespace=/[\p{White_Space}\u001c-\u001f]+/gu;
const normalize=(value:string|null|undefined)=>(value??'').split(whitespace).filter(Boolean).join(' ');
const suffix=/[（(][\p{White_Space}\u001c-\u001f]*[0-9０-９]+[\p{White_Space}\u001c-\u001f]*[）)][\p{White_Space}\u001c-\u001f]*$/u;
const trailingWhitespace=/[\p{White_Space}\u001c-\u001f]$/u;

export class ForegroundLocator {
  private readonly options:ForegroundLocatorOptions;
  private epoch=0;
  private closed=false;
  private active:{controller:AbortController;promise:Promise<ForegroundObservation>}|undefined;
  constructor(options:ForegroundLocatorOptions) {
    if(!uuid(options.ownerId)||!options.accountScope.trim())throw new ForegroundLocationError('foreground_scope_invalid');
    this.options={...options,ownerId:options.ownerId.toLowerCase()};
  }
  /** 变更开始即失效，调用方应await后才完成关闭、解绑或移交。 */
  async invalidate():Promise<void> {
    this.epoch++;this.active?.controller.abort();
    await this.options.probe.close();
    if(this.active)await Promise.allSettled([this.active.promise]);
  }
  async close():Promise<void> {this.closed=true;await this.invalidate();await this.options.probe.dispose();}
  observe(options:{enabled:boolean;signal?:AbortSignal}):Promise<ForegroundObservation> {
    if(this.closed)return Promise.reject(new ForegroundLocationError('foreground_observation_cancelled'));
    if(this.active)return Promise.reject(new ForegroundLocationError('foreground_observation_busy'));
    const epoch=this.epoch, controller=new AbortController();
    const abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});
    if(options.signal?.aborted)abort();
    const deadline=performance.now()+3200;
    const timer=setTimeout(abort,3200);
    const check=()=>{
      if(this.closed||epoch!==this.epoch||options.signal?.aborted)throw new ForegroundLocationError('foreground_observation_cancelled');
      if(controller.signal.aborted||performance.now()>=deadline)throw new ForegroundLocationError('observation_timeout');
    };
    const promise=Promise.resolve().then(()=>this.run(options.enabled,controller.signal,deadline,check)).finally(()=>{
      clearTimeout(timer);options.signal?.removeEventListener('abort',abort);this.active=undefined;
    });
    this.active={controller,promise};return promise;
  }
  private async run(enabled:boolean,signal:AbortSignal,deadline:number,check:()=>void):Promise<ForegroundObservation> {
    let observation:ForegroundProbeObservation|undefined;
    const result=(phase:ForegroundObservation['phase'],reason:string,preview=false):ForegroundObservation=>({
      observation_id:randomUUID(),observed_at:observation?.captured_at??new Date((this.options.clock??Date.now)()).toISOString(),
      phase,reason,probe_available:phase!=='unavailable'&&enabled,wechat_in_front:observation?.wechat_in_front??false,
      binding_id:null,contact_id:null,recognized_name:preview?observation?.display_name??null:null,
      recognition_confidence:preview?observation?.quality?.display_name_confidence??null:null,
    });
    try {
      check();
      if(!enabled){await this.options.probe.close();check();return result('paused','sync_disabled');}
      try {observation=await this.options.probe.observe({signal,timeoutMs:Math.min(2500,deadline-performance.now())});}
      catch(error) {check();await this.options.probe.close();const code=(error as {code?:string}).code??'';return result('unavailable',safeForegroundProbeCode(code));}
      check();
      if(!observation.wechat_in_front)return result('paused','wechat_not_in_front');
      const captured=Date.parse(observation.captured_at??'');
      const age=(this.options.clock??Date.now)()-captured;
      if(!Number.isFinite(captured)||age< -1000||age>=5000)return result('unavailable','observation_timeout');
      const title=observation.display_name??'',quality=observation.quality,tail=observation.text_fallback;
      const header=['automatic-header-v3','automatic-header-v4'].includes(observation.capture_version??'');
      const hasSuffix=suffix.test(title);
      const preview=header&&quality?.layout_verified===true&&typeof title==='string'&&!!normalize(title)&&[...title].length<=256&&!/[\r\n]/u.test(title);
      const failure=(phase:ForegroundObservation['phase'],reason:string)=>hasSuffix?result('paused','group_chat_suspected'):result(phase,reason,phase==='manual-required'&&preview);
      if(!quality||quality.layout_verified!==true||!preview&&!(!header&&observation.capture_version==='automatic-window-v2'))return failure('manual-required','quality_unverified');
      if(hasSuffix&&tail)return result('paused','group_chat_suspected');
      if(tail&&(observation.capture_version!=='automatic-header-v4'||!tail.text_complete||!tail.mask_verified||tail.confidence<0.9))return failure('manual-required','quality_unverified');
      if(tail&&suffix.test(tail.text))return result('paused','group_chat_suspected');
      const qualityFailure=header?(quality.name_complete!==true||/…|⋯|\.\.\./u.test(title)||!tail&&quality.display_name_confidence<0.3):
        !normalize(title)||quality.display_name_confidence<0.9||(quality.selected_row_name_confidence??0)<0.9||normalize(title)!==normalize(observation.selected_row_name);
      let sessions:readonly ForegroundSession[],bindings:readonly ForegroundBinding[];
      try {
        check();sessions=await this.options.sessions({signal,timeoutMs:Math.min(250,deadline-performance.now()),limit:header?5000:51,...(!header?{keyword:normalize(title.replace(suffix,''))||normalize(title)}:{})});check();
        if(sessions.length>=(header?5000:51))return failure('manual-required','session_candidates_truncated');
        if(qualityFailure){if(sessions.some(row=>row.chat_type==='group'&&normalize(row.display_name)===normalize(title)))return result('paused','group_chat_unsupported');return failure('manual-required','quality_unverified');}
        if(hasSuffix&&sessions.some(row=>row.chat_type==='group'&&[canonicalSessionName(title),canonicalSessionName(title.replace(suffix,''))].includes(canonicalSessionName(row.display_name))))return result('paused','group_chat_suspected');
        const exactLegacy=sessions.map((row,index)=>({row,index})).filter(({row})=>normalize(row.display_name)===normalize(title));
        const decision=header?matchSessionNames(title,quality.display_name_confidence,sessions.map(row=>({displayName:row.display_name,chatType:row.chat_type})),{tailText:tail?.text,tailConfidence:tail?.confidence,checkCurrent:check}):{
          kind:exactLegacy.some(({row})=>row.chat_type==='group')?'group':exactLegacy.length===1&&exactLegacy[0].row.chat_type==='private'?'unique':'ambiguous',
          candidateIndex:exactLegacy.length===1?exactLegacy[0].index:null,method:'exact',plausibleIndices:exactLegacy.map(({index})=>index),
        };
        check();
        if(decision.kind==='group')return result('paused',decision.plausibleIndices.some(index=>sessions[index].chat_type==='private')?'group_chat_suspected':'group_chat_unsupported');
        if(decision.kind==='quality-unverified')return failure('manual-required','quality_unverified');
        if(decision.kind!=='unique'||decision.candidateIndex===null)return failure('manual-required','ambiguous_requires_selection');
        if(hasSuffix&&(decision.method!=='exact'||quality.display_name_confidence<0.9))return result('paused','group_chat_suspected');
        const candidate=sessions[decision.candidateIndex];
        if(!candidate.username.trim()||sessions.filter(row=>row.username===candidate.username).length!==1||trailingWhitespace.test(candidate.display_name))return failure('manual-required','unmatched_requires_selection');
        bindings=await this.options.bindings(signal,check);check();
        const active=bindings.filter(row=>row.conversation_locator===candidate.username);
        const binding=active[0];
        if(active.length!==1||binding.owner_id.toLowerCase()!==this.options.ownerId||binding.channel!=='wechat'||binding.account_scope!==this.options.accountScope||binding.status!=='active'||normalize(binding.display_name)!==normalize(candidate.display_name)||!uuid(binding.binding_id)||!uuid(binding.contact_id))return failure('manual-required','unmatched_requires_selection');
        if((this.options.clock??Date.now)()-captured>=5000)return result('unavailable','observation_timeout');
        return {...result('confirmed',decision.method==='exact'&&quality.display_name_confidence>=0.9?'confirmed_active_binding':'confirmed_active_binding_name_match',preview),binding_id:binding.binding_id,contact_id:binding.contact_id};
      } catch(error) {check();await this.options.probe.close();return failure('unavailable','binding_verification_unavailable');}
    } catch(error) {await this.options.probe.close();throw error;}
  }
}
