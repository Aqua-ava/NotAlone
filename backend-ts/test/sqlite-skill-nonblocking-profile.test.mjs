import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';
import {watch} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createSyntheticProfile} from './profile-support.mjs';

const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
test('正式profile中原生Skill读取变慢时，已缓存状态仍能并发响应',{timeout:20000},async t=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'notalone-skill-nonblocking-')));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const root=join(dir,'originals'),profile=join(dir,'profiles/notalone');await mkdir(profile,{recursive:true});
 await mkdir(join(root,'gentle'),{recursive:true});
 await writeFile(join(root,'gentle/SKILL.md'),'---\nname: gentle\ndescription: 合成策略\n---\n保留选择。\n');
 const slow=join(dir,'enable-slow'),entered=join(dir,'native-entered'),reader=join(dir,'slow-reader');
 await writeFile(reader,`#!/bin/sh\nif [ "$1" = package ] && [ -f ${quote(slow)} ]; then : > ${quote(entered)}; /bin/sleep 0.8; fi\nexec ${quote(resolve('../native/skill-read/.build/skill-read'))} "$@"\n`,{mode:0o700});
 await writeFile(join(profile,'package.json'),JSON.stringify({private:true,dsh:{profile:{bundles:[]}}}));
 await writeFile(join(profile,'cordis.patch.yml'),await createSyntheticProfile(resolve('test/fixtures/sqlite-skills/profile-plugin.ts'),'http://127.0.0.1:1/anthropic'));
 const child=spawn(process.execPath,['--import',resolve('test/observe.mjs'),resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','notalone'],{
  cwd:dir,env:{PATH:process.env.PATH,HOME:dir,DSH_HOME:dir,DSH_TELEMETRY_DISABLED:'1',DEEPSEEK_API_KEY:'synthetic-only',NOTALONE_SKILL_TEST_DIR:dir,NOTALONE_SKILL_TEST_READER:reader},stdio:['ignore','pipe','pipe']});
 const exited=once(child,'exit');let output='';child.stderr.on('data',b=>{output+=b;});
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await exited;assert.doesNotMatch(output,/VALIDATION_NETWORK /);});
 const base=await new Promise((ready,reject)=>{
  const timer=setTimeout(()=>reject(new Error('合成profile启动超时')),10000);
  child.once('exit',()=>{clearTimeout(timer);reject(new Error('合成profile提前退出'));});
  child.stdout.on('data',b=>{output+=b;const match=output.match(/SQLITE_SKILL_READY (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);ready(match[1]);}});
 });
 const request=async path=>{const response=await fetch(base+path,{headers:{authorization:'Bearer profile-only'}});return {status:response.status,body:await response.json()};};
 assert.equal((await request('/api/skills')).body.skills[0].enabled_state,'enabled');
 const seen=Promise.withResolvers(),watcher=watch(dir,(_event,name)=>{if(name==='native-entered')seen.resolve();});t.after(()=>watcher.close());
 const timer=setTimeout(()=>seen.reject(new Error('慢原生检查未进入')),3000);t.after(()=>clearTimeout(timer));
 await writeFile(slow,'enabled');
 const scanning=request('/api/skills');await seen.promise;clearTimeout(timer);
 const start=performance.now(),status=await request('/cached-status'),elapsed=performance.now()-start;
 await scanning;
 t.diagnostic(`原生合成读取延迟800ms；缓存状态响应 ${elapsed.toFixed(1)}ms`);
 assert.deepEqual(status.body,{ready:true});assert.equal(status.status,200);
 assert.ok(elapsed<250,`原生检查期间缓存状态不应等待文件扫描，实际 ${Math.round(elapsed)}ms`);
});
