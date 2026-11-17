import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

async function fixture(t){
 const dir=await mkdtemp(path.join(tmpdir(),'notalone-skill-library-14-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const output=path.join(dir,'library.mjs');await build({stdin:{contents:"export {SkillLibraryController} from './src/main/skill-learning/library';export {installSkillLearningBridge} from './src/main/skill-learning/bridge';export {createSkillLearningBridge} from './src/preload/skill-learning';",resolveDir:process.cwd()},outfile:output,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
 const ports=await import(pathToFileURL(output).href),{SkillLibraryController}=ports;
 const item={package_id:'11111111-1111-4111-8111-111111111111',name:'gentle',title:'温和回应',tags:['日常沟通'],description:'合成说明',directory_name:'gentle',enabled_state:'unknown',verification_state:'verified',verification_reason:null,
  head_revision:'9007199254740993',current_revision_no:'1',state_label:'待核验启停 · 目录已核验',revisions:[{revision_no:'1',manifest_digest:'a'.repeat(64),content_digest:'b'.repeat(64),source_kind:'user_directory',availability:'current',verification_state:'verified'}]};
 let generation=1;const calls=[];const backend={getConnectionGeneration:()=>generation,requestJson:async input=>{calls.push(input);return {generation,data:input.method==='GET'?{storage:'sqlite',mode:'minimal',skills:[item]}:{skill:{...item,head_revision:'9007199254740994',enabled_state:'enabled'}}};}};
 return {controller:new SkillLibraryController(backend),ports,backend,item,calls,changeGeneration:()=>{generation++;}};
}
test('最小DTO区分未知状态并保留精确head，明确启用带原CAS而不调用旧学习',async t=>{
 const {controller,item,calls}=await fixture(t);const view=await controller.read();assert.equal(view.mode,'sqlite');assert.equal(view.skills[0].headRevision,'9007199254740993');assert.equal(view.skills[0].enabledState,'unknown');assert.equal(view.skills[0].title,'温和回应');assert.deepEqual(view.skills[0].tags,['日常沟通']);
 await controller.changeEnabled({packageId:item.package_id,expectedHeadRevision:item.head_revision,connectionGeneration:1,confirmed:true,enabled:true});
 const write=calls.find(c=>c.method==='POST');assert.equal(write.path,`/api/skills/${item.package_id}/enable`);assert.deepEqual(write.body,{expected_head_revision:item.head_revision,confirmed:true});assert.ok(calls.every(c=>!c.path.includes('skill-learning')));
});
test('重连后旧页面写入在出站前拒绝，renderer不能传owner/根路径/旧删除动作',async t=>{
 const {controller,item,calls,changeGeneration}=await fixture(t);changeGeneration();
 await assert.rejects(controller.verify({packageId:item.package_id,expectedHeadRevision:'1',connectionGeneration:1,confirmed:true}));assert.equal(calls.length,0);
 assert.equal('discover' in controller,false);
 await assert.rejects(controller.verify({packageId:item.package_id,expectedHeadRevision:'1',connectionGeneration:2,confirmed:true,ownerId:'other'}));assert.equal(calls.length,0);
});

test('中文展示元数据必须合法，不把重复标签或无效标题交给页面',async t=>{
 const {controller,item}=await fixture(t);
 item.title=' ';await assert.rejects(controller.read());
 item.title='温和回应';item.tags=['日常沟通','日常沟通'];await assert.rejects(controller.read());
 item.tags=['日常沟通'];assert.equal((await controller.read()).skills[0].title,'温和回应');
});


test('正式桥仅暴露八个库管理操作，沿管理窗口直接读取和启停，不订阅旧学习状态',async t=>{
 const {ports,backend,item,calls}=await fixture(t),handlers=new Map(),roles=new Map();let invalidations=0;
 ports.installSkillLearningBridge({handle:(channel,handler,role)=>{handlers.set(channel,handler);roles.set(channel,role);},
  publish:()=>assert.fail('库管理不发布旧学习状态')},backend,()=>{invalidations++;});
 const bridge=ports.createSkillLearningBridge({invoke:(channel,...args)=>Promise.resolve().then(()=>handlers.get(channel)(...args)),
  on:()=>assert.fail('库管理不订阅旧学习状态'),removeListener:()=>assert.fail('库管理不订阅旧学习状态')});
 assert.deepEqual([...handlers.keys()].sort(),['skill-library:read','skill-library:verify','skill-library:enabled','skill-library:groups-read',
  'skill-library:group-create','skill-library:group-update','skill-library:group-delete','skill-library:group-assign'].sort());
 assert.deepEqual(Object.keys(bridge).sort(),['readLibrary','verifyLibrary','changeLibraryEnabled','readGroups','createGroup','updateGroup','deleteGroup','assignContactGroup'].sort());
 assert.ok([...roles.values()].every(role=>role==='manager'));
 await assert.rejects(bridge.readLibrary({ownerId:'other'}));
 await assert.rejects(bridge.readGroups({ownerId:'other'}));
 assert.throws(()=>handlers.get('skill-library:read')({ownerId:'other'}));
 assert.throws(()=>handlers.get('skill-library:enabled')());
 assert.equal(calls.length,0);
 assert.equal((await bridge.readLibrary()).skills[0].packageId,item.package_id);
 await bridge.changeLibraryEnabled({packageId:item.package_id,expectedHeadRevision:item.head_revision,connectionGeneration:1,confirmed:true,enabled:true});
 assert.equal(invalidations,1,'库写入继续使在途讨论资格失效');
 assert.ok(calls.every(call=>call.path.startsWith('/api/skills')));
});

test('旧后端形状拒绝读取，连接换代后迟到列表不能恢复旧库快照',async t=>{
 const {controller,backend,changeGeneration}=await fixture(t);
 backend.requestJson=async()=>({generation:1,data:{skills:[]}});
 await assert.rejects(controller.read());
 let resolve;
 backend.requestJson=()=>new Promise(done=>{resolve=done;});
 const pending=controller.read();changeGeneration();
 resolve({generation:1,data:{storage:'sqlite',mode:'minimal',skills:[]}});
 await assert.rejects(pending);
});
