import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,rm,rename} from 'node:fs/promises';
import {watch} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteSkillLibrary,skillAnchor} from '../src/skills/sqlite/library.ts';
import {SqliteSkillHttp} from '../src/skills/sqlite/http.ts';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {AsyncSecureSkillDirectory} from '../src/skills/secure-directory-async.ts';

const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
async function fixture(t){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'notalone-skill-async-'))),root=join(dir,'originals');
 await mkdir(join(root,'gentle'),{recursive:true});
 const document='---\nname: gentle\ndescription: 合成策略\n---\n保留选择。\n';await writeFile(join(root,'gentle/SKILL.md'),document);
 const slow=join(dir,'enable-slow'),reader=join(dir,'slow-reader');
 await writeFile(reader,`#!/bin/sh\nif [ "$1" = package ] && [ -f ${quote(slow)} ]; then : > ${quote(join(dir,'native-entered'))}; /bin/sleep 0.8; fi\nexec ${quote(resolve('../native/skill-read/.build/skill-read'))} "$@"\n`,{mode:0o700});
 const storage=await SqliteStorage.open({userData:dir,intent:'create',role:'test',registryModule:new URL('./fixtures/sqlite-skills/registry.mjs',import.meta.url).href});
 await storage.execute('fixture.owner',{ownerId:'owner-a'});
 const library=new SqliteSkillLibrary(storage,'owner-a',root,{readerBinary:reader});
 t.after(async()=>{await library.close();await storage.close();await rm(dir,{recursive:true,force:true});});
 const [item]=await library.refresh();
 async function enterSlow(){
  const entered=Promise.withResolvers(),watcher=watch(dir,(_event,name)=>{if(name==='native-entered')entered.resolve();});
  const timer=setTimeout(()=>entered.reject(new Error('原生合成检查未进入')),3000);
  t.after(()=>{clearTimeout(timer);watcher.close();});await writeFile(slow,'enabled');
  return {entered:entered.promise.finally(()=>{clearTimeout(timer);watcher.close();})};
 }
 return {dir,root,reader,storage,library,item,document,enterSlow};
}

test('关闭Skill库时中止在途文件核验，不把关闭误写为文件失效',async t=>{
 const f=await fixture(t),{entered}=await f.enterSlow();
 const result=f.library.assertAnchor(skillAnchor(f.item)).then(value=>({value}),error=>({error}));
 await entered;await f.library.close();
 assert.ok((await result).error,'关闭必须拒绝旧文件结果');
 const reader=new SqliteSkillLibrary(f.storage,'owner-a',f.root);t.after(()=>reader.close());
 assert.deepEqual(await reader.get(f.item.id),f.item);
});

test('取消慢刷新后不提交已读取的新Skill字节或修改既有核验状态',async t=>{
 const f=await fixture(t);await writeFile(join(f.root,'gentle/SKILL.md'),f.document+'新的合成方法。\n');
 const {entered}=await f.enterSlow(),controller=new AbortController();
 const result=f.library.refresh(controller.signal).then(value=>({value}),error=>({error}));
 await entered;controller.abort(new Error('synthetic-skill-cancelled'));
 assert.equal((await result).error?.message,'synthetic-skill-cancelled');
 await f.library.close();
 const reader=new SqliteSkillLibrary(f.storage,'owner-a',f.root);t.after(()=>reader.close());
 assert.deepEqual(await reader.get(f.item.id),f.item);
});

test('异步原生读取期间撤销来源资格，迟到快照不能恢复Skill',async t=>{
 const f=await fixture(t);await writeFile(join(f.root,'gentle/SKILL.md'),f.document+'新的合成方法。\n');
 const {entered}=await f.enterSlow(),refreshing=f.library.refresh();
 await entered;
 const blocked=await f.library.requireVerification(f.item.id,f.item.headRevision);
 const [actual]=await refreshing;
 assert.equal(actual.verificationReason,'source_qualification_changed');
 assert.equal(actual.currentRevisionNo,null);
 assert.deepEqual(await f.library.get(f.item.id),blocked);
});

test('Skill管理HTTP断连取消慢核验，不在请求结束后提交新字节',async t=>{
 const f=await fixture(t);await writeFile(join(f.root,'gentle/SKILL.md'),f.document+'新的合成方法。\n');
 const http=new SqliteSkillHttp(f.library,()=>true),settled=Promise.withResolvers();
 const server=createServer(async(req,res)=>{try{await http.handle(req,res);}finally{settled.resolve();}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const {entered}=await f.enterSlow(),controller=new AbortController();
 const response=fetch(`http://127.0.0.1:${server.address().port}/api/skills`,{signal:controller.signal}).then(value=>({value}),error=>({error}));
 await entered;controller.abort(new Error('synthetic-http-cancelled'));
 assert.ok((await response).error);await settled.promise;
 assert.deepEqual(await f.library.get(f.item.id),f.item);
});

test('首次异步扫描之前替换授权根也不能重新信任同字节目录',async t=>{
 const f=await fixture(t),library=new SqliteSkillLibrary(f.storage,'owner-a',f.root);t.after(()=>library.close());
 await rename(f.root,f.root+'-retained');await mkdir(join(f.root,'gentle'),{recursive:true});
 await writeFile(join(f.root,'gentle/SKILL.md'),f.document);
 await assert.rejects(library.inspect(),{code:'skill_directory_conflict'});
 await assert.rejects(library.inspect(),{code:'skill_directory_conflict'});
 assert.deepEqual(await f.library.get(f.item.id),f.item);
});

test('各自可取消的并发管理请求仍合并同一轮原生核验',async t=>{
 const f=await fixture(t),calls=[],execute=f.storage.execute.bind(f.storage);
 f.storage.execute=(name,...args)=>{calls.push(name);return execute(name,...args);};
 const a=new AbortController(),b=new AbortController();
 const views=await Promise.all([f.library.inspect(a.signal),f.library.refresh(b.signal)]);
 for(const view of views)assert.deepEqual(view,[f.item]);
 assert.ok(calls.length<=3,`并发核验应共用读取，实际 ${calls.length} 次`);
});

test('共享核验中单个请求取消不撤销另一个仍有效的请求',async t=>{
 const f=await fixture(t);await writeFile(join(f.root,'gentle/SKILL.md'),f.document+'新的合成方法。\n');
 const {entered}=await f.enterSlow(),a=new AbortController(),b=new AbortController();
 const first=f.library.inspect(a.signal).then(value=>({value}),error=>({error}));
 const second=f.library.inspect(b.signal);
 await entered;a.abort(new Error('synthetic-first-cancelled'));
 assert.equal((await first).error?.message,'synthetic-first-cancelled');
 const [actual]=await second;
 assert.equal(actual.currentRevisionNo,2n);assert.equal(actual.verificationState,'verified');
});

test('取消洪泛仍受真实在途读取上限约束，确认排空后才能接收新读取',async t=>{
 const f=await fixture(t),reader=new AsyncSecureSkillDirectory(f.root,f.reader);t.after(()=>reader.close());
 const identity=await reader.directoryIdentity('gentle'),{entered}=await f.enterSlow();
 const activeController=new AbortController(),reason=new Error('synthetic-queue-cancelled');
 const active=reader.snapshot('gentle',identity,activeController.signal).then(value=>({value}),error=>({error}));
 await entered;
 const started=performance.now();activeController.abort(reason);
 assert.equal((await active).error,reason);
 assert.ok(performance.now()-started<250,'调用者取消不能等待慢原生读取');
 const cancelled=[];
 for(let i=0;i<30;i++){
  const controller=new AbortController();
  cancelled.push(reader.names(controller.signal).then(value=>({value}),error=>({error})));
  controller.abort(reason);
 }
 const draining=reader.names();
 const overflow=reader.names();
 await assert.rejects(overflow,{code:'skill_reader_busy'});
 for(const result of await Promise.all(cancelled))assert.equal(result.error,reason);
 assert.deepEqual(await draining,['gentle']);
 assert.deepEqual(await reader.names(),['gentle']);
});


test('Skill排队超时只取消对应读取，排空后同一读取器仍可用',async t=>{
 const f=await fixture(t),reader=new AsyncSecureSkillDirectory(f.root,f.reader);t.after(()=>reader.close());
 await writeFile(f.reader,`#!/bin/sh\nif [ "$1" = list ]; then /bin/sleep 0.75; fi\nexec ${quote(resolve('../native/skill-read/.build/skill-read'))} "$@"\n`,{mode:0o700});
 const results=await Promise.allSettled(Array.from({length:16},()=>reader.names()));
 assert.ok(results.some(result=>result.status==='rejected'),'排队超过期限必须结束对应调用者等待');
 assert.ok(results.filter(result=>result.status==='fulfilled').length>=13,'排队超时不能终止尚在期限内执行的读取');
 assert.deepEqual(await reader.names(),['gentle'],'同一读取器排空后必须仍可读取');
});


test('原生读取器暂时不可用不改变已核验Skill的内容资格',async t=>{
 const f=await fixture(t);
 await rename(f.reader,f.reader+'-retained');
 await assert.rejects(f.library.assertAnchor(skillAnchor(f.item)),{code:'skill_reader_unavailable'});
 assert.deepEqual(await f.library.get(f.item.id),f.item,'基础设施故障不能写成包内容无效');
 await rename(f.reader+'-retained',f.reader);
 assert.equal((await f.library.assertAnchor(skillAnchor(f.item))).contentDigest,f.item.revisions[0].contentDigest);
});


test('Skill文件线程启动失败后确认退休并恢复读取，仍固定原授权根身份',async t=>{
 const f=await fixture(t),reader=new AsyncSecureSkillDirectory(f.root,f.reader);t.after(()=>reader.close());
 await rename(f.reader,f.reader+'-retained');
 await assert.rejects(reader.names(),{code:'skill_reader_unavailable'});
 await rename(f.reader+'-retained',f.reader);
 assert.deepEqual(await reader.names(),['gentle']);
});


test('排队期限已过但线程尚未确认跳过时仍保留全部32个邮箱位置',async t=>{
 const f=await fixture(t),reader=new AsyncSecureSkillDirectory(f.root,f.reader);t.after(()=>reader.close());
 await reader.names();
 // 只推进主线程的排队时钟；真实Worker尚未有机会回传完成确认。
 t.mock.timers.enable({apis:['setTimeout']});
 const queued=Array.from({length:32},()=>reader.names());
 t.mock.timers.tick(10000);
 const results=await Promise.allSettled(queued);
 assert.ok(results.every(result=>result.status==='rejected'&&result.reason.code==='skill_reader_unavailable'));
 await assert.rejects(reader.names(),{code:'skill_reader_busy'});
 t.mock.timers.reset();
 await reader.close();
});
