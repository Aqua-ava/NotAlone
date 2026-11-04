import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createSyntheticProfile} from './profile-support.mjs';
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
test('正式 DSH profile 首请求仅含简介，官方工具载入选定Skill后生成候选',{timeout:30000},async t=>{
 const require=createRequire(import.meta.url);
 for(const name of ['@deepseek-ai/dsh','@deepseek-ai/dsh-skill','@deepseek-ai/dsh-tool-skill']){const pkg=JSON.parse(await readFile(require.resolve(name+'/package.json'),'utf8'));assert.equal(pkg.version,'0.2.1-rc.2');}
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-skill-precall-profile-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const profile=join(root,'profiles/notalone'),plugin=fileURLToPath(new URL('./fixtures/sqlite-reply-skill-precall/profile-plugin.ts',import.meta.url)),preload=fileURLToPath(new URL('./fixtures/sqlite-reply-skill-precall/fetch-preload.mjs',import.meta.url)),dsh=fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh/lib/bin.js',import.meta.url));
 const providerURL='http://127.0.0.1:9/anthropic',patch=await createSyntheticProfile(plugin,providerURL);
 await mkdir(profile,{recursive:true});await writeFile(join(profile,'package.json'),JSON.stringify({private:true,dsh:{profile:{bundles:[]}}}));await writeFile(join(profile,'cordis.patch.yml'),patch);
 const stdout=[],stderr=[];
 const child=spawn(process.execPath,['--import',preload,dsh,'--profile','notalone'],{cwd:root,env:{...process.env,PATH:process.env.PATH,HOME:root,DSH_HOME:root,DSH_TELEMETRY_DISABLED:'1',NOTALONE_PRECALL_PROFILE_DIR:root,NOTALONE_PRECALL_PROVIDER_URL:providerURL,NOTALONE_DEEPSEEK_API_KEY:'synthetic-only'},stdio:['ignore','pipe','pipe']});
 const exited=once(child,'exit');t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await exited;});
 let output='';child.stdout.on('data',chunk=>{output+=chunk;stdout.push(String(chunk));});child.stderr.on('data',chunk=>{stderr.push(String(chunk));});
 const result=await new Promise((resolveValue,reject)=>{
  const timer=setTimeout(()=>reject(new Error('formal profile precall timeout: '+(output+stderr.join('')).slice(-3000))),20000);
  child.on('exit',code=>{clearTimeout(timer);reject(new Error(`formal profile exited ${code}: ${(output+stderr.join('')).slice(-3000)}`));});
  child.stdout.on('data',()=>{const match=output.match(/PRECALL_PROFILE_RESULT (\{[^\n]+\})/);if(match){clearTimeout(timer);resolveValue(JSON.parse(match[1]));}});
 });
 const calls=output.split('\n').filter(line=>line.startsWith('PRECALL_MODEL_CALL ')).map(line=>JSON.parse(line.slice('PRECALL_MODEL_CALL '.length)));
 assert.equal(calls.length,2,'正式 profile 先经官方工具读取Skill，再生成候选');
 assert.equal(calls[0].hasSkillBody,false);assert.equal(calls[0].hasSkillCatalog,true);assert.deepEqual(calls[0].tools.sort(),['skill','skill_resource']);
 assert.equal(calls[1].hasSkillBody,true);
 assert.equal(result.candidates,1);assert.deepEqual(result.preloadedSkills,[]);
 assert.deepEqual(result.loadedSkills.map(skill=>[skill.name,skill.relativePath]),[['gentle','SKILL.md']]);
 assert.ok(result.finishedAt-result.startedAt>=0);assert.ok(calls[0].bytes>0);
 child.kill('SIGTERM');await exited;t.diagnostic(`model_calls=${calls.length} first_request_bytes=${calls[0].bytes} local_prepare_ms=${(calls[0].at-result.startedAt).toFixed(1)}`);
});
