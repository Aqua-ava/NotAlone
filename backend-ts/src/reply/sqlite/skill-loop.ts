/** 每轮仅开放官方 Skill 加载与本版本静态资料；不提供任意文件能力。 */
import {RELATIONSHIP_DOCUMENT_TOOL} from './document-tool.ts';
import type {Context} from '@deepseek-ai/cordis';
import {defineTool} from '@deepseek-ai/dsh-tools';
import type {SqliteSkillRun} from '../../skills/sqlite/provider.ts';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';

export const REPLY_MODEL_CALL_LIMIT=5;
export class ReplySkillUnavailable extends Error {
 constructor(){super('reply_skill_unavailable');}
}
export function isSkillReadFailure(error:unknown):boolean{
 const code=(error as {code?:string})?.code;
 return typeof code==='string'&&(/^skill_(reader_unavailable|directory_unavailable|directory_conflict|content_changed|package_invalid|run_invalidated|revision_unavailable|unverified|source_verification_required|preload_limit)$/.test(code)||['discussion_resource_limit','discussion_skill_tool_failed'].includes(code));
}
export function installReplySkillTools(ctx:Context,run:SqliteSkillRun|null,check:()=>Promise<void>,failed:(error:unknown)=>void,documents=false):void{
 const active=run;
 const preloaded=!!active&&active.preloadOrigin!==null;
 const loaded=()=>!!active&&active.loadedSkills.length>0;
 const demandCatalog=!!active&&!preloaded&&active.revision.eligible.length>0;
 // 预加载路径隐藏官方目录工具；默认DSH目录与本工具可见性绑定，隐藏后不再发布摘要目录。
 ctx.tools.restrict({allow:demandCatalog?['skill']:[]});
 let resources=0;
 ctx.tools.guard(exec=>{
  if(documents&&exec.name===RELATIONSHIP_DOCUMENT_TOOL)return;
  if(!active)return 'discussion_tools_forbidden';
  if(exec.name==='skill_resource'){
   if(!loaded()||++resources>2){failed(new StorageFailure('discussion_resource_limit'));return 'discussion_resource_limit';}
   return;
  }
  if(exec.name==='skill'){
   if(!demandCatalog)return 'discussion_tools_forbidden';
   return;
  }
  failed(new StorageFailure('discussion_tools_forbidden'));return 'discussion_tools_forbidden';
 });
 if(!active||(!loaded()&&!demandCatalog))return;
 // 按需路径在正文载入前也展示资源工具；guard 仍拒绝未加载身份。
 ctx.tools.register(defineTool({name:'skill_resource',description:'仅在已加载Skill明确需要补充资料时，按资源目录中的相对路径读取本版本静态文字。最多两次。',
  parameters:{name:{type:'string',required:true,description:'已成功加载正文的准确Skill名称。'},path:{type:'string',required:true,description:'该Skill资源目录中的准确references/或assets/相对路径。'}},
  async execute(args,exec){await check();return {text:await active.readLoadedResource(args.name,args.path,exec.signal)};},
  output:{schema:{type:'object',additionalProperties:false,properties:{text:{type:'string',required:true}}},render:(_args,value)=>[{type:'text',text:value.text}]},
 }));
 ctx.on('tools/pre-execute',async(_exec,next)=>{await check();return next();});
 ctx.on('tools/post-execute',async(exec,result,next)=>{
  if(result.isError){
   failed(isSkillReadFailure(active.failure)?new ReplySkillUnavailable():active.failure??new StorageFailure('discussion_skill_tool_failed'));
   return next();
  }
  await check();
  const selected=exec.name==='skill'?active.loadedSkills.find(skill=>skill.name===(exec.arguments as {name?:unknown})?.name):undefined;
  if(selected){
   const decision=await next();if(decision.kind!=='accept')return decision;
   return {kind:'accept',content:[...result.content,{type:'text',text:'本版本可按需读取的静态资料：'+JSON.stringify({name:selected.name,resources:selected.resources.map(r=>({path:r.relativePath,bytes:r.bytes}))}) }]};
  }
  return next();
 });
}
