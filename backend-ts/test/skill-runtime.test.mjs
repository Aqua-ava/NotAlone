import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {SkillRuntime} from '../src/skills/skill-runtime.ts';
const hash=x=>createHash('sha256').update(x).digest('hex');
const scope={ownerId:'owner',contactId:'contact',scene:'reply'};
function fixture(){
 const content='第一行\n第二行\n第三行';
 const entries=['alpha','beta'].map(name=>({skillId:name,versionId:`${name}-v1`,name,description:'合成策略',contentHash:hash(content),resourcePaths:['references/help.txt']}));
 let valid=true;
 const port={catalog:async()=>({revision:'1',entries}),validate:async()=>{if(!valid)throw Error('revoked');},loadVersion:async()=>({content,contentHash:hash(content)}),resource:async()=>({content:Buffer.from('辅助材料')})};
 return {port,entries,revoke(){valid=false;}};
}
test('冻结目录的分页读取只带请求内版本 alias，资源只在同一版本正文之后读取',async()=>{
 const f=fixture(),run=await SkillRuntime.open(f.port,scope);
 const page=await run.readFile('/notalone/reply-skills/alpha/SKILL.md',1,1);
 assert.match(page,/"used_skill_version_id":"k1"/);assert.doesNotMatch(page,/alpha-v1/);assert.match(page,/第二行/);assert.doesNotMatch(page,/第一行|第三行/);
 assert.equal(await run.readFile('/notalone/reply-skills/alpha/references/help.txt'),'辅助材料');
 assert.equal(run.usedVersionId,'alpha-v1');
 await assert.rejects(run.readFile('/notalone/reply-skills/beta/SKILL.md'),/second_skill/);
});
test('取消在途读取及时返回且迟到内容不再可用',async()=>{
 const f=fixture();f.port.loadVersion=()=>new Promise(()=>{});
 const run=await SkillRuntime.open(f.port,scope),pending=run.readFile('/notalone/reply-skills/alpha/SKILL.md');
 await new Promise(resolve=>setImmediate(resolve));run.cancel();
 await assert.rejects(pending,/skill_run_invalidated/);
 assert.equal(run.usedVersionId,null);
});
test('目录撤销永久关闭运行，恢复旧目录也不能复活',async()=>{
 const f=fixture(),run=await SkillRuntime.open(f.port,scope);
 await run.readFile('/notalone/reply-skills/alpha/SKILL.md');f.revoke();
 await assert.rejects(run.validate(),/revoked/);
 assert.equal(run.usedVersionId,null);
 await assert.rejects(run.readFile('/notalone/reply-skills/alpha/SKILL.md'),/invalidated/);
});
test('限制路径、分页参数及先正文后资源，不读取第二版本',async()=>{
 const run=await SkillRuntime.open(fixture().port,scope);
 for(const path of ['/etc/passwd','https://example.test/a','/notalone/reply-skills/alpha/../SKILL.md','/notalone/reply-skills/alpha/references/no.txt','/notalone/reply-skills/alpha/scripts/a.py'])await assert.rejects(run.readFile(path),/path_invalid/);
 await assert.rejects(run.readFile('/notalone/reply-skills/alpha/SKILL.md',0,1001),/page_invalid/);
 await assert.rejects(run.readFile('/notalone/reply-skills/alpha/references/help.txt'),/body_required/);
 const results=await Promise.allSettled(['alpha','beta'].map(name=>run.readFile(`/notalone/reply-skills/${name}/SKILL.md`)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.match(results.find(r=>r.status==='rejected').reason.message,/second_skill/);
});
test('不可变执行正文变化与读取期间资格变化都不返回新内容',async()=>{
 const f=fixture(),run=await SkillRuntime.open(f.port,scope);
 await run.readFile('/notalone/reply-skills/alpha/SKILL.md');
 f.port.loadVersion=async()=>({content:'新正文',contentHash:f.entries[0].contentHash});
 await assert.rejects(run.readFile('/notalone/reply-skills/alpha/SKILL.md'),/content_changed/);
 const g=fixture(),other=await SkillRuntime.open(g.port,scope);
 g.port.loadVersion=async()=>{g.revoke();return {content:'迟到正文',contentHash:g.entries[0].contentHash};};
 await assert.rejects(other.readFile('/notalone/reply-skills/alpha/SKILL.md'),/revoked/);
});

test('正文每页与空页保留同一 alias 回执，资源保持旧合同整份读取',async()=>{
 const f=fixture();f.port.resource=async()=>({content:Buffer.from('辅助一\n辅助二\n辅助三')});
 const run=await SkillRuntime.open(f.port,scope);
 for(const offset of [0,1,99])assert.match(await run.readFile('/notalone/reply-skills/alpha/SKILL.md',offset,1),/used_skill_version_id":"k1"/);
 assert.equal(await run.readFile('/notalone/reply-skills/alpha/references/help.txt',1,1),'辅助一\n辅助二\n辅助三');
});
test('外部取消中断目录、正文及资源等待，迟到结果不能重新开放读取',async()=>{
 for(const stage of ['catalog','loadVersion','resource']){
  const f=fixture(),controller=new AbortController();let finish;
  f.port[stage]=()=>new Promise(resolve=>{finish=resolve;});
  if(stage==='catalog'){
   const pending=SkillRuntime.open(f.port,scope,controller.signal);controller.abort(Error('synthetic_abort'));
   await assert.rejects(pending,/synthetic_abort/);finish({revision:'1',entries:f.entries});continue;
  }
  const run=await SkillRuntime.open(f.port,scope,controller.signal);
  if(stage==='resource')await run.readFile('/notalone/reply-skills/alpha/SKILL.md');
  const pending=run.readFile('/notalone/reply-skills/alpha/'+(stage==='resource'?'references/help.txt':'SKILL.md'));
  await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(pending,/invalidated/);
  finish(stage==='resource'?{content:Buffer.from('迟到资源')}:{content:'迟到正文',contentHash:f.entries[0].contentHash});
  assert.equal(run.usedVersionId,null);await assert.rejects(run.validate(),/invalidated/);
 }
});

test('资源坏字节仅在资格仍有效时允许原无Skill回退，撤销和未知错误终止',async()=>{
 const {SkillFileError}=await import('../src/skills/skill-files.ts');
 for(const kind of ['utf8','file','revoked','unknown']){
  const f=fixture(),run=await SkillRuntime.open(f.port,scope);await run.readFile('/notalone/reply-skills/alpha/SKILL.md');
  f.port.resource=async()=>{if(kind==='revoked')f.revoke();if(kind==='unknown')throw Error('unknown');if(kind!=='utf8')throw new SkillFileError();return {content:Uint8Array.from([0xff])};};
  const pending=run.readFile('/notalone/reply-skills/alpha/references/help.txt');
  if(kind==='utf8'||kind==='file'){
   assert.match(await pending,/辅助资源不可用/);assert.equal(run.loadState,'resource_failed');assert.equal(run.usedVersionId,'alpha-v1');assert.equal(await run.captureUse(),null);assert.equal(run.signal.aborted,false);
  }else{await assert.rejects(pending,kind==='revoked'?/revoked/:/unknown/);assert.equal(run.signal.aborted,true);}
 }
});
test('读取回执由port产生完整DTO，只传实际成功资源且不接受调用方伪造路径',async()=>{
 const f=fixture(),calls=[];f.port.captureUse=async(...args)=>{calls.push(args);return {version_id:'alpha-v1',execution_view:{synthetic:true}};};
 const run=await SkillRuntime.open(f.port,scope);assert.equal(await run.captureUse(),null);
 await run.readFile('/notalone/reply-skills/alpha/SKILL.md');
 for(let i=0;i<2;i++)await run.readFile('/notalone/reply-skills/alpha/references/help.txt');
 assert.deepEqual(run.loadedResourcePaths,['references/help.txt']);
 assert.deepEqual(await run.captureUse({selection_method:'user',selection_reason:'合成选择',resource_paths:['forged']}),{version_id:'alpha-v1',execution_view:{synthetic:true}});
 assert.deepEqual(calls[0][3],{selection_method:'user',selection_reason:'合成选择',resource_paths:['references/help.txt'],load_state:'loaded'});
 run.cancel();assert.equal(run.usedVersionId,null);assert.deepEqual(run.loadedResourcePaths,[]);await assert.rejects(run.captureUse(),/invalidated/);
});

test('端口同步触发取消时吞掉迟到拒绝并释放独占读取缓存',async()=>{
 const f=fixture(),controller=new AbortController();let disposed=0;f.port.dispose=()=>{disposed++;};
 const run=await SkillRuntime.open(f.port,scope,controller.signal);
 f.port.loadVersion=async()=>{controller.abort();throw Error('late_failure');};
 await assert.rejects(run.readFile('/notalone/reply-skills/alpha/SKILL.md'),/invalidated/);
 await new Promise(resolve=>setImmediate(resolve));assert.ok(disposed>0);
});
