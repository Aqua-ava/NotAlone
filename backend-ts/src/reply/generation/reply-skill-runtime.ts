/** 本轮回复的Skill选择、受控工具与官方scope注册；不提供通用文件能力。 */
import type {Context} from '@deepseek-ai/cordis';
import {scopeOf,type ScopeKey} from '@deepseek-ai/dsh-scope';
import SkillRegistry,{renderSkillContent} from '@deepseek-ai/dsh-skill';
import {defineTool,type ToolDefinition} from '@deepseek-ai/dsh-tools';
import {SkillRuntime,SKILL_VIRTUAL_ROOT,type SkillReadPort,type SkillScope} from '../../skills/skill-runtime.ts';
import {registerSkillRuntime} from '../../skills/skill-provider.ts';
import type {SkillUse} from '../../skills/skill-port.ts';
import {ReplyError,type ReplyRequestInput} from './reply-contract.ts';
import {createEvidenceAliases,type EvidenceAliases} from './reply-evidence-alias.ts';
export interface SelectedSkillFailure {readonly version_id:string;readonly load_state:'resource_failed'}
const failures=new WeakMap<object,{runtime:SkillRuntime;port:SkillReadPort}>();
export function isSelectedSkillFailure(value:SelectedSkillFailure|null,port:unknown,scope:{ownerId:string;contactId:string},revision:string):boolean {if(!value)return false;const actual=failures.get(value);return !!actual&&actual.port===port&&!actual.runtime.signal.aborted&&actual.runtime.loadState==='resource_failed'&&actual.runtime.usedVersionId===value.version_id&&actual.runtime.scope.ownerId===scope.ownerId&&actual.runtime.scope.contactId===scope.contactId&&actual.runtime.catalog.revision===revision;}
export function selectedSkillFailureEntry(value:SelectedSkillFailure|null,port:unknown,scope:{ownerId:string;contactId:string},revision:string){if(!isSelectedSkillFailure(value,port,scope,revision))return null;return failures.get(value!)!.runtime.catalog.entries.find(entry=>entry.versionId===value!.version_id)??null;}
type Selection=Pick<ReplyRequestInput,'skill_version_id'|'skill_disabled'>;
export class ReplySkillSession {
 readonly runtime:SkillRuntime;
 readonly aliases:EvidenceAliases;
 private readonly selection:Selection;
 private captured:SkillUse|null=null;
 private readonly port:SkillReadPort;
 private mounted=false;
 private registry:SkillRegistry|null=null;
 private scopeKey:ScopeKey|undefined;
 private constructor(runtime:SkillRuntime,selection:Selection,port:SkillReadPort,aliases:EvidenceAliases){this.runtime=runtime;this.selection={...selection};this.port=port;this.aliases=aliases;}
 static async open(port:SkillReadPort,scope:SkillScope,selection:Selection,signal?:AbortSignal,sharedAliases?:EvidenceAliases):Promise<ReplySkillSession>{
  const aliases=sharedAliases??createEvidenceAliases();
  const filtered:SkillReadPort={
   catalog:async(s,signal)=>{const catalog=await port.catalog(s,signal);return {...catalog,entries:selection.skill_disabled?[]:selection.skill_version_id?catalog.entries.filter(e=>e.versionId===selection.skill_version_id):catalog.entries};},
   loadVersion:(...args)=>port.loadVersion(...args),resource:(...args)=>port.resource(...args),validate:(...args)=>port.validate(...args),
   ...port.captureUse?{captureUse:(...args:Parameters<NonNullable<SkillReadPort['captureUse']>>)=>port.captureUse!(...args)}:{},
   dispose:()=>port.dispose?.(),
  };
  return new ReplySkillSession(await SkillRuntime.open(filtered,scope,signal,versionId=>aliases.skillFor(versionId)),selection,port,aliases);
 }
 async preloadSelected(signal?:AbortSignal):Promise<string>{
  if(!this.selection.skill_version_id||this.selection.skill_disabled)return '';
  signal?.throwIfAborted();await this.runtime.validate(signal);
  const entry=this.runtime.catalog.entries.find(e=>e.versionId===this.selection.skill_version_id);
  if(!entry||!this.registry)throw new ReplyError('reply_skill_runtime_unavailable',502);
  const loaded=await this.registry.get(entry.name,{scope:this.scopeKey,signal});
  if(!loaded||this.runtime.usedVersionId!==entry.versionId||this.runtime.loadState!=='loaded')throw new ReplyError('reply_skill_runtime_unavailable',502);
  await this.runtime.validate(signal);return renderSkillContent(loaded);
 }
 selectedSkillFailure():SelectedSkillFailure|null{
  if(this.runtime.signal.aborted||this.runtime.loadState!=='resource_failed'||!this.selection.skill_version_id||this.runtime.usedVersionId!==this.selection.skill_version_id)return null;
  const value=Object.freeze({version_id:this.selection.skill_version_id,load_state:'resource_failed' as const});failures.set(value,{runtime:this.runtime,port:this.port});return value;
 }
 get use():SkillUse|null{return structuredClone(this.captured);}
 get revision():string{return this.runtime.catalog.revision;}
 catalogText():string{return JSON.stringify({skills:this.runtime.catalog.entries.map(e=>({name:e.name,description:e.description,version_id:this.aliases.skillFor(e.versionId),path:`${SKILL_VIRTUAL_ROOT}/${e.name}/SKILL.md`}))});}
 mount(scope:Context):()=>void {
  const registry=scope.get('skills');
  if(this.mounted||!registry)throw new ReplyError('reply_skill_runtime_unavailable',502);
  this.mounted=true;this.registry=registry;this.scopeKey=scopeOf(scope);
  return registerSkillRuntime(registry,this.runtime);
 }
 async validateRegistry(signal?:AbortSignal):Promise<void>{
  if(!this.registry)throw new ReplyError('reply_skill_runtime_unavailable',502);
  const catalog=await this.registry.snapshot({scope:this.scopeKey,signal});
  if(!catalog.complete||catalog.skills.length!==this.runtime.catalog.entries.length||catalog.skills.some(e=>e.provider!=='notalone-reply-skills'||!this.runtime.catalog.entries.some(known=>known.name===e.name&&e.description===known.description&&e.path===`${SKILL_VIRTUAL_ROOT}/${known.name}/SKILL.md`)))throw new ReplyError('reply_skill_runtime_unavailable',502);
 }
 tools():ToolDefinition[]{
  if(!this.runtime.catalog.entries.length)return [];
  return [defineTool({name:'read_file',description:'仅按本轮当前联系人目录读取一个已批准Skill正文或其受控辅助资料。',
   parameters:{file_path:{type:'string',required:true},offset:{type:'integer',default:0},limit:{type:'integer',default:1000}},
   output:{schema:{type:'string'},render:(_args,result)=>[{type:'text',text:result}]},
   execute:async(args,exec)=>{
    const offset=args.offset??0,limit=args.limit??1000;
    const entry=this.runtime.catalog.entries.find(e=>args.file_path===`${SKILL_VIRTUAL_ROOT}/${e.name}/SKILL.md`);
    if(entry){
     if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>1000)throw new ReplyError('reply_skill_page_invalid',400);
     if(!this.registry)throw new ReplyError('reply_skill_runtime_unavailable',502);
     const loaded=await this.registry.get(entry.name,{scope:this.scopeKey,signal:exec.signal});
     if(!loaded)throw new ReplyError('reply_skill_runtime_unavailable',502);
     if(offset===0&&limit===1000)return loaded.content;
    }
    return this.runtime.readFile(args.file_path,offset,limit,exec.signal);
   },
  })];
 }
 async captureClaim(versionAlias:string|null,signal?:AbortSignal):Promise<void>{
  await this.runtime.validate(signal);
  const actual=this.runtime.usedVersionId;
  // 旧兼容协议允许模型漏写null，由本轮真实读取回执恢复，不能从目录推断。
  const claimed=versionAlias===null?null:this.aliases.resolveSkill(versionAlias);
  if(versionAlias!==null&&claimed===null||claimed!==null&&claimed!==actual)throw new ReplyError('reply_candidates_rejected');
  this.captured=await this.runtime.captureUse(this.selection.skill_version_id?{
   selection_method:'user',selection_reason:'用户明确选择该版本，且本轮实际读取。',
  }:{selection_method:'auto',selection_reason:'系统按当前联系人目录推荐，模型在本次回复中实际读取。'},signal);
 }
 close():void{this.runtime.cancel();}
}
