/** 官方 DSH 0.2.1-rc.2 registry 薄适配；必须挂在每轮独占 scope，禁止 host 全局共享。 */
import type SkillRegistry from '@deepseek-ai/dsh-skill';
import type {SkillCandidate,SkillProvider,SkillProviderControl} from '@deepseek-ai/dsh-skill';
import {SkillRuntime,SKILL_VIRTUAL_ROOT,SkillRuntimeError} from './skill-runtime.ts';
export function createSkillProvider(run:SkillRuntime,control:SkillProviderControl):SkillProvider {
 const name='notalone-reply-skills';
 const candidates:SkillCandidate[]=run.catalog.entries.map(entry=>({name:entry.name,description:entry.description,provider:name,source:'notalone',rank:0,
  path:`${SKILL_VIRTUAL_ROOT}/${entry.name}/SKILL.md`,
  resourceBase:{kind:'opaque',description:`仅通过 read_file 读取 ${SKILL_VIRTUAL_ROOT}/${entry.name} 下获准资源`},
  invocation:{modelInvocable:true,userInvocable:false},locator:entry.versionId}));
 const dispose=()=>run.cancel();
 if(control.signal.aborted)run.cancel();else control.signal.addEventListener('abort',dispose,{once:true,signal:run.signal});
 run.signal.addEventListener('abort',()=>control.invalidate(),{once:true});
 return {name,
  async list(options){await run.validate(options.signal);return candidates;},
  async get(candidate,options){
   const trusted=candidates.find(item=>item.name===candidate.name&&item.locator===candidate.locator);
   if(!trusted)throw new SkillRuntimeError('skill_candidate_invalid');
   const content=await run.readFile(trusted.path!,0,1000,options.signal);
   return {name:trusted.name,description:trusted.description,provider:name,source:'notalone',path:trusted.path,resourceBase:trusted.resourceBase,invocation:trusted.invocation,content};
  }};
}
/** 调用方必须在物理请求及提交前调用 run.validate；registry 缓存不代替业务资格。 */
export function registerSkillRuntime(registry:SkillRegistry,run:SkillRuntime):()=>void {
 const dispose=registry.registerProvider(control=>createSkillProvider(run,control));
 return ()=>{run.cancel();dispose();};
}
