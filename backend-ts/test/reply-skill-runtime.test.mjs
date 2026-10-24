import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {Context} from '@deepseek-ai/cordis';
import {createScope} from '@deepseek-ai/dsh-scope';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import {ReplySkillSession} from '../src/reply-skill-runtime.ts';
function fixture(){
 const body='合成批准策略正文',hash=createHash('sha256').update(body).digest('hex'),ownerId=randomUUID(),contactId=randomUUID();
 const entries=['alpha','beta'].map(name=>({skillId:randomUUID(),versionId:randomUUID(),name,description:'合成描述',contentHash:hash,resourcePaths:[]}));
 const port={catalog:async()=>({revision:'3',entries}),validate:async()=>{},loadVersion:async()=>({content:body,contentHash:hash}),resource:async()=>{throw Error('unused');},captureUse:async(_scope,entry,_revision,meta)=>({skill_id:entry.skillId,version_id:entry.versionId,name:entry.name,version_number:1,scope_kind:'contact',scope_contact_id:contactId,scope_scene:null,execution_view:{policy_revision:0,method_ids:[],sha256:hash},...meta}),dispose(){}};
 return {body,entries,port,scope:{ownerId,contactId,scene:''}};
}
test('用户版本选择过滤官方scope目录；只有实际加载的版本可成为Skill回执',async()=>{
 const f=fixture(),ctx=new Context();await ctx.plugin(SkillRegistry);const layer=createScope(ctx,{});
 const session=await ReplySkillSession.open(f.port,f.scope,{skill_version_id:f.entries[0].versionId,skill_disabled:false});
 const dispose=session.mount(layer.ctx);
 try{
  await session.validateRegistry();assert.equal(session.runtime.catalog.entries.length,1);
  assert.deepEqual((await ctx.skills.snapshot()).skills,[]);
  const content=await session.tools()[0].execute({file_path:'/notalone/reply-skills/alpha/SKILL.md',offset:0,limit:1000},{signal:new AbortController().signal});
  assert.match(content,/合成批准策略正文/);
  await session.captureClaim(null);assert.equal(session.use.version_id,f.entries[0].versionId);assert.equal(session.use.selection_method,'user');
  await assert.rejects(session.captureClaim(f.entries[1].versionId),{code:'reply_candidates_rejected'});
 }finally{dispose();await layer.dispose();await ctx.fiber.dispose();}
 assert.equal(session.runtime.signal.aborted,true);
});
test('显式禁用或越范围版本不提供可读工具，不从目录猜测实际使用',async()=>{
 for(const choice of [{skill_disabled:true,skill_version_id:null},{skill_disabled:false,skill_version_id:randomUUID()}]){
  const f=fixture(),session=await ReplySkillSession.open(f.port,f.scope,choice);
  assert.deepEqual(session.tools(),[]);await session.captureClaim(null);assert.equal(session.use,null);
  await assert.rejects(session.captureClaim(f.entries[0].versionId),{code:'reply_candidates_rejected'});session.close();
 }
});
test('宿主全局额外Skill不能混入回复scope的目录',async()=>{
 const f=fixture(),ctx=new Context();await ctx.plugin(SkillRegistry);
 const other=await ReplySkillSession.open(f.port,f.scope,{skill_disabled:false,skill_version_id:f.entries[1].versionId});
 const disposeOther=other.mount(ctx),layer=createScope(ctx,{}),session=await ReplySkillSession.open(f.port,f.scope,{skill_disabled:false,skill_version_id:f.entries[0].versionId});
 const dispose=session.mount(layer.ctx);
 try{await assert.rejects(session.validateRegistry(),{code:'reply_skill_runtime_unavailable'});}finally{dispose();disposeOther();await layer.dispose();await ctx.fiber.dispose();}
});
