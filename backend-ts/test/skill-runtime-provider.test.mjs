import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Context} from '@deepseek-ai/cordis';
import {createScope} from '@deepseek-ai/dsh-scope';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import {SkillRuntime} from '../src/skills/skill-runtime.ts';
import {registerSkillRuntime} from '../src/skills/skill-provider.ts';
test('官方registry使用受控provider，撤销与dispose使读取失败且不暴露物理路径',async()=>{
 const entries=['alpha','beta'].map(name=>({skillId:name,versionId:name+'-v1',name,description:'合成',contentHash:'frozen',resourcePaths:[]}));
 const port={catalog:async()=>({revision:'1',entries}),validate:async()=>{},loadVersion:async()=>({content:'合成正文',contentHash:'frozen'}),resource:async()=>{throw Error('unused');}};
 const run=await SkillRuntime.open(port,{ownerId:'owner',contactId:'contact',scene:'reply'});
 const ctx=new Context();await ctx.plugin(SkillRegistry);
 try{
  const dispose=registerSkillRuntime(ctx.skills,run);
  const snapshot=await ctx.skills.snapshot();assert.equal(snapshot.complete,true);assert.equal(snapshot.skills.length,2);
  assert.equal(snapshot.skills[0].path,'/notalone/reply-skills/alpha/SKILL.md');
  assert.match((await ctx.skills.get('alpha')).content,/合成正文/);
  await assert.rejects(ctx.skills.get('beta'),/second_skill/);
  dispose();assert.equal(run.signal.aborted,true);assert.equal((await ctx.skills.snapshot()).skills.length,0);
 }finally{await ctx.fiber.dispose();}
});

test('官方scope隔离同名策略，释放一轮不影响其他轮，宿主无可读策略',async()=>{
 const ctx=new Context();await ctx.plugin(SkillRegistry);
 const a={},b={},sa=createScope(ctx,a),sb=createScope(ctx,b),runs=[];
 try{
  for(const [layer,key] of [[sa,'a'],[sb,'b']]){
   const port={catalog:async()=>({revision:'1',entries:[{skillId:key,versionId:key+'-v1',name:'same',description:key,contentHash:'frozen',resourcePaths:[]}]}),validate:async()=>{},loadVersion:async()=>({content:key+'正文',contentHash:'frozen'}),resource:async()=>{throw Error('unused');}};
   const run=await SkillRuntime.open(port,{ownerId:key,contactId:key,scene:'reply'});runs.push(run);registerSkillRuntime(layer.ctx.get('skills'),run);
  }
  assert.deepEqual((await ctx.skills.snapshot()).skills,[]);
  assert.match((await ctx.skills.get('same',{scope:a})).content,/a正文/);
  assert.match((await ctx.skills.get('same',{scope:b})).content,/b正文/);
  await sa.dispose();assert.equal(runs[0].signal.aborted,true);assert.equal(runs[1].signal.aborted,false);
  assert.deepEqual((await ctx.skills.snapshot({scope:a})).skills,[]);
  assert.match((await ctx.skills.get('same',{scope:b})).content,/b正文/);
 }finally{await sa.dispose();await sb.dispose();await ctx.fiber.dispose();}
});

test('官方scope释放中断在途provider读取，迟到结果不重新进入目录',async()=>{
 const ctx=new Context();await ctx.plugin(SkillRegistry);const key={},layer=createScope(ctx,key);let finish;
 const port={catalog:async()=>({revision:'1',entries:[{skillId:'a',versionId:'a-v1',name:'alpha',description:'合成',contentHash:'frozen',resourcePaths:[]}]}),validate:async()=>{},loadVersion:()=>new Promise(resolve=>{finish=resolve;}),resource:async()=>{throw Error('unused');}};
 const run=await SkillRuntime.open(port,{ownerId:'owner',contactId:'contact',scene:'reply'});
 try{
  registerSkillRuntime(layer.ctx.get('skills'),run);const pending=ctx.skills.get('alpha',{scope:key});
  await new Promise(resolve=>setImmediate(resolve));await layer.dispose();await assert.rejects(pending,/invalidated/);
  finish({content:'迟到正文',contentHash:'frozen'});assert.deepEqual((await ctx.skills.snapshot({scope:key})).skills,[]);assert.equal(run.usedVersionId,null);
 }finally{await layer.dispose();await ctx.fiber.dispose();}
});
