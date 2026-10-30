import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createSyntheticProfile} from './profile-support.mjs';

test('正式 profile 的 scoped Skill 正文后按需读取同版本资源，目录和实际载荷可追踪且不扩权',{timeout:20000},async t=>{
 const directory=await realpath(await mkdtemp(join(tmpdir(),'notalone-resource-profile-')));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const root=join(directory,'originals'),profile=join(directory,'profiles/notalone');await mkdir(profile,{recursive:true});
 await mkdir(join(root,'gentle/references'),{recursive:true});
 await writeFile(join(root,'gentle/SKILL.md'),'---\nname: gentle\ndescription: 用于合成资源回复\n---\n先了解表达方向。\n保留本意。\n参考 references/guide.md。\n');
 await writeFile(join(root,'gentle/references/guide.md'),'正式 profile 的合成辅助资料。');
 await writeFile(join(profile,'package.json'),JSON.stringify({private:true,dsh:{profile:{bundles:[]}}}));
 await writeFile(join(profile,'cordis.patch.yml'),await createSyntheticProfile(resolve('test/fixtures/sqlite-skills/profile-plugin.ts'),'http://127.0.0.1:1/anthropic'));
 const child=spawn(process.execPath,['--import',resolve('test/observe.mjs'),resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','notalone'],{
  cwd:directory,env:{PATH:process.env.PATH,HOME:directory,DSH_HOME:directory,DSH_TELEMETRY_DISABLED:'1',DEEPSEEK_API_KEY:'synthetic-only',NOTALONE_SKILL_TEST_DIR:directory},stdio:['ignore','pipe','pipe']});
 const exited=once(child,'exit');let output='';
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await exited;assert.doesNotMatch(output,/VALIDATION_NETWORK /);});
 child.stderr.on('data',bytes=>output+=bytes);
 const base=await new Promise((resolveReady,reject)=>{
  const timer=setTimeout(()=>reject(new Error('正式 profile 资源测试启动超时：'+output.slice(-1500))),10000);
  child.once('exit',()=>{clearTimeout(timer);reject(new Error('正式 profile 提前退出：'+output.slice(-1500)));});
  child.stdout.on('data',bytes=>{output+=bytes;const match=output.match(/SQLITE_SKILL_READY (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);resolveReady(match[1]);}});
 });
 const request=async(path,input)=>{
  const response=await fetch(base+path,{method:input?'POST':'GET',headers:{'content-type':'application/json',authorization:'Bearer profile-only'},body:input?JSON.stringify(input):undefined});
  return {status:response.status,body:await response.json()};
 };
 let item=(await request('/discover',{name:'gentle'})).body;
 item=(await request('/enabled',{id:item.id,head:item.headRevision,state:'enabled'})).body;
 const loaded=await request('/load-resource',{id:item.id,path:'references/guide.md'});
 assert.equal(loaded.status,200,JSON.stringify(loaded.body));assert.equal(loaded.body.resource,'正式 profile 的合成辅助资料。');
 assert.equal(loaded.body.loaded.name,'gentle');assert.equal(loaded.body.loaded.packageId,item.id);assert.equal(loaded.body.loaded.revisionNo,item.currentRevisionNo);
 assert.deepEqual(loaded.body.loaded.resources.map(resource=>resource.relativePath),['references/guide.md']);
 assert.deepEqual(loaded.body.inputs.map(input=>input.relative_path),['SKILL.md','references/guide.md']);
 assert.equal(loaded.body.inputs[1].text,loaded.body.resource);assert.equal(loaded.body.hostCatalog,0);
 assert.ok(!JSON.stringify(loaded.body.loaded).includes(root));
 assert.equal((await request('/load-resource',{id:item.id,path:'../outside.txt'})).body.code,'skill_path_invalid');
 assert.equal((await request('/load-resource',{id:item.id,path:'references/guide.md',contactId:'other'})).status,409);
 item=(await request('/enabled',{id:item.id,head:item.headRevision,state:'disabled'})).body;
 assert.equal((await request('/load-resource',{id:item.id,path:'references/guide.md'})).status,409);
 assert.deepEqual((await request('/check')).body,{integrity:'ok',foreignKeys:'ok'});
});
