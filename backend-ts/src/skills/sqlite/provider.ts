/** 官方 DSH scoped provider；Skill 只提供文字，不产生业务权限或执行能力。 */
import type {Context} from '@deepseek-ai/cordis';
import {scopeOf} from '@deepseek-ai/dsh-scope';
import type SkillRegistry from '@deepseek-ai/dsh-skill';
import type {SkillCandidate,SkillProvider,SkillProviderControl} from '@deepseek-ai/dsh-skill';
import {sha256} from '../skill-package.ts';
import {SqliteSkillLibrary,SqliteSkillError,skillAnchor} from './library.ts';
import type {SkillAnchor,SkillPackageState,SkillRunProtection,SkillRunScope} from './contracts.ts';

const providerName='notalone-sqlite-skills';
const virtualRoot='/notalone/reply-skills';
const catalogRevision=(items: SkillPackageState[])=>JSON.stringify(items.map(i=>[i.id,i.headRevision.toString()]));
async function abortable<T>(work: Promise<T>,signal: AbortSignal): Promise<T> {
  if(signal.aborted){void work.catch(()=>{});signal.throwIfAborted();}
  return new Promise<T>((resolve,reject)=>{
    const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
    work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
export async function openSqliteSkillRun(library: SqliteSkillLibrary,request: {contactId:string;callId:string},protection: SkillRunProtection,selectedPackageId?: string,signal?: AbortSignal): Promise<SqliteSkillRun> {
  if(!request.contactId || !request.callId || !protection?.assertCurrent || !protection.recordInput || !protection.recordSelection)throw new SqliteSkillError('skill_protection_required');
  const scope=Object.freeze({ownerId:library.ownerId,contactId:request.contactId,callId:request.callId});
  signal?.throwIfAborted();await protection.assertCurrent(scope,signal);
  const items=await library.list();
  const available=items.filter(item=>item.enabledState==='enabled' && item.verificationState==='verified' && item.currentRevisionNo!==null);
  for(const item of available)await library.assertAnchor(skillAnchor(item));
  const selected=selectedPackageId?available.find(item=>item.id===selectedPackageId):undefined;
  if(selectedPackageId && !selected)throw new SqliteSkillError('skill_selection_unavailable');
  const run=new SqliteSkillRun(library,scope,protection,items,selected?skillAnchor(selected):null,signal);
  try {
    await run.validate();
    await protection.recordSelection(scope,run.selection,signal);
    await run.validate();
    return run;
  }catch(error){run.close();throw error;}
}
export class SqliteSkillRun {
  readonly scope: SkillRunScope;
  private readonly selected: SkillAnchor | null;
  private readonly library: SqliteSkillLibrary;
  private readonly protection: SkillRunProtection;
  private readonly catalog: SkillPackageState[];
  private readonly revision: string;
  private readonly controller=new AbortController();
  private reserved: string | null=null;
  private bodyLoaded=false;
  private unregister?: ()=>void;
  constructor(library: SqliteSkillLibrary,scope: SkillRunScope,protection: SkillRunProtection,items: SkillPackageState[],selected: SkillAnchor|null,signal?: AbortSignal) {
    this.library=library;this.scope=scope;this.protection=protection;this.catalog=structuredClone(items);this.revision=catalogRevision(items);this.selected=selected?Object.freeze({...selected}):null;
    if(signal?.aborted)this.close();else signal?.addEventListener('abort',()=>this.close(),{once:true,signal:this.controller.signal});
  }
  get selection(): SkillAnchor|null {return this.selected?{...this.selected}:null;}
  /** 每次实际模型发送和业务提交前，12必须复验；registry缓存不是资格凭证。 */
  async validate(signal?: AbortSignal): Promise<void> {
    try {
      const combined=this.signal(signal);combined.throwIfAborted();
      await abortable(this.protection.assertCurrent(this.scope,combined),combined);
      if(catalogRevision(await this.library.list())!==this.revision)throw new SqliteSkillError('skill_run_invalidated');
      for(const item of this.eligible())await this.library.assertAnchor(skillAnchor(item));
      await abortable(this.protection.assertCurrent(this.scope,combined),combined);
      combined.throwIfAborted();
    }catch(error){this.close();throw error;}
  }
  mount(context: Context): ()=>void {
    if(scopeOf(context)===undefined || this.unregister || this.controller.signal.aborted)throw new SqliteSkillError('skill_scope_required');
    const registry=context.get('skills') as SkillRegistry|undefined;
    if(!registry)throw new SqliteSkillError('skill_registry_unavailable');
    this.unregister=registry.registerProvider(control=>this.provider(control));
    return ()=>this.close();
  }
  async readResource(anchor: SkillAnchor,relativePath: string,signal?: AbortSignal): Promise<string> {
    const item=this.eligible().find(item=>item.id===anchor.packageId);
    if(!item || JSON.stringify(skillAnchor(item),bigintJson)!==JSON.stringify(anchor,bigintJson))throw new SqliteSkillError('skill_candidate_invalid');
    if(this.reserved!==item.id || !this.bodyLoaded)throw new SqliteSkillError('skill_body_required');
    await this.validate(signal);
    const snapshot=await this.library.assertAnchor(anchor);
    const resource=snapshot.pkg.resources.find(r=>r.relative_path===relativePath);
    if(!resource)throw new SqliteSkillError('skill_path_invalid');
    return this.record(anchor,relativePath,resource.content.toString('utf8'),signal);
  }
  close(): void {
    if(!this.controller.signal.aborted)this.controller.abort(new SqliteSkillError('skill_run_invalidated'));
    const unregister=this.unregister;this.unregister=undefined;unregister?.();
  }
  private signal(signal?: AbortSignal): AbortSignal {return signal?AbortSignal.any([this.controller.signal,signal]):this.controller.signal;}
  private eligible(): SkillPackageState[] {return this.catalog.filter(item=>item.enabledState==='enabled' && item.verificationState==='verified' && item.currentRevisionNo!==null && (!this.selected || item.id===this.selected.packageId));}
  private provider(control: SkillProviderControl): SkillProvider {
    if(control.signal.aborted)this.close();else control.signal.addEventListener('abort',()=>this.close(),{once:true,signal:this.controller.signal});
    this.controller.signal.addEventListener('abort',()=>control.invalidate(),{once:true});
    const candidates: SkillCandidate[]=this.eligible().map(item=>({name:item.displayName,description:item.description,provider:providerName,source:'notalone',rank:0,
      path:`${virtualRoot}/${item.displayName}/SKILL.md`,resourceBase:{kind:'opaque',description:'仅允许本次修订清单内的只读文字资源'},
      invocation:{modelInvocable:true,userInvocable:false},locator:item.id}));
    return {name:providerName,
      list:async options=>{await this.validate(options.signal);return candidates;},
      get:async(candidate,options)=>{
        const trusted=candidates.find(item=>item===candidate);
        const item=this.eligible().find(item=>item.id===trusted?.locator);
        if(!trusted || !item)throw new SqliteSkillError('skill_candidate_invalid');
        if(this.reserved!==null && this.reserved!==item.id)throw new SqliteSkillError('second_skill_load');
        this.reserved=item.id;
        await this.validate(options.signal);
        const anchor=skillAnchor(item),snapshot=await this.library.assertAnchor(anchor);
        const content=await this.record(anchor,'SKILL.md',snapshot.pkg.content,options.signal);
        this.bodyLoaded=true;
        return {name:trusted.name,description:trusted.description,provider:providerName,source:'notalone',path:trusted.path,resourceBase:trusted.resourceBase,invocation:trusted.invocation,content};
      }};
  }
  private async record(anchor: SkillAnchor,relativePath: string,text: string,signal?: AbortSignal): Promise<string> {
    try {
      await this.validate(signal);
      const combined=this.signal(signal);
      await abortable(this.protection.recordInput({scope:this.scope,selected:this.selection,loaded:{...anchor},relativePath,text,payloadDigest:sha256(text)},combined),combined);
      await this.validate(signal);
      return text;
    }catch(error){this.close();throw error;}
  }
}
function bigintJson(_key: string,value: unknown): unknown {return typeof value==='bigint'?value.toString():value;}
