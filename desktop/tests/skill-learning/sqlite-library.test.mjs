import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

async function fixture(t){
 const dir=await mkdtemp(path.join(tmpdir(),'notalone-skill-library-14-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const output=path.join(dir,'library.mjs');await build({entryPoints:['src/main/skill-learning/library.ts'],outfile:output,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
 const {SkillLibraryController}=await import(pathToFileURL(output).href);
 const item={package_id:'11111111-1111-4111-8111-111111111111',name:'gentle',description:'合成说明',directory_name:'gentle',enabled_state:'unknown',verification_state:'verified',verification_reason:null,
  head_revision:'9007199254740993',current_revision_no:'1',state_label:'待核验启停 · 目录已核验',revisions:[{revision_no:'1',manifest_digest:'a'.repeat(64),content_digest:'b'.repeat(64),source_kind:'user_directory',availability:'current',verification_state:'verified'}]};
 let generation=1;const calls=[];const backend={getConnectionGeneration:()=>generation,requestJson:async input=>{calls.push(input);return {generation,data:input.method==='GET'?{storage:'sqlite',mode:'minimal',skills:[item]}:{skill:{...item,head_revision:'9007199254740994',enabled_state:'enabled'}}};}};
 return {controller:new SkillLibraryController(backend),item,calls,changeGeneration:()=>{generation++;}};
}
test('最小DTO区分未知状态并保留精确head，明确启用带原CAS而不调用旧学习',async t=>{
 const {controller,item,calls}=await fixture(t);const view=await controller.read();assert.equal(view.mode,'sqlite');assert.equal(view.skills[0].headRevision,'9007199254740993');assert.equal(view.skills[0].enabledState,'unknown');
 await controller.changeEnabled({packageId:item.package_id,expectedHeadRevision:item.head_revision,connectionGeneration:1,confirmed:true,enabled:true});
 const write=calls.find(c=>c.method==='POST');assert.equal(write.path,`/api/skills/${item.package_id}/enable`);assert.deepEqual(write.body,{expected_head_revision:item.head_revision,confirmed:true});assert.ok(calls.every(c=>!c.path.includes('skill-learning')));
});
test('重连后旧页面写入在出站前拒绝，renderer不能传owner/根路径/旧删除动作',async t=>{
 const {controller,item,calls,changeGeneration}=await fixture(t);changeGeneration();
 await assert.rejects(controller.verify({packageId:item.package_id,expectedHeadRevision:'1',connectionGeneration:1,confirmed:true}));assert.equal(calls.length,0);
 await assert.rejects(controller.discover({directoryName:'../private',connectionGeneration:2,confirmed:true}));assert.equal(calls.length,0);
 await assert.rejects(controller.discover({directoryName:'gentle',connectionGeneration:2,confirmed:true,ownerId:'other'}));assert.equal(calls.length,0);
});
