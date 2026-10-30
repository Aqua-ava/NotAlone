import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,rename,rm,symlink,link,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync,spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteSkillLibrary,skillAnchor} from '../src/skills/sqlite/library.ts';
import {SecureSkillDirectory} from '../src/skills/secure-directory.ts';
import {readPackage} from '../src/skills/skill-package.ts';

test.before(()=>execFileSync('bash',[resolve('../native/skill-read/build.sh')],{stdio:'pipe'}));
async function fixture(t){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'notalone-skill-safe-')));t.after(()=>rm(dir,{recursive:true,force:true}));
 const root=join(dir,'root');await mkdir(join(root,'gentle/references'),{recursive:true});
 const document='---\nname: gentle\ndescription: 用于合成表达\n---\n先回应感受。\n';
 await writeFile(join(root,'gentle/SKILL.md'),document);await writeFile(join(root,'gentle/references/guide.md'),'已核验合成资料。');
 const storage=await SqliteStorage.open({userData:dir,intent:'create',role:'test',registryModule:new URL('./fixtures/sqlite-skills/registry.mjs',import.meta.url).href});t.after(()=>storage.close());await storage.execute('fixture.owner',{ownerId:'owner-a'});
 const library=new SqliteSkillLibrary(storage,'owner-a',root);let item=await library.discover('gentle');item=await library.setEnabled(item.id,item.headRevision,'enabled');
 return {dir,root,library,item,document};
}

test('原生读服务缺失拒绝启动，不回落 Node 路径读取；未知目录无需正文即可发现',async t=>{
 const {dir,root,library}=await fixture(t);
 assert.throws(()=>new SecureSkillDirectory(root,join(dir,'not-installed')),{code:'skill_reader_unavailable'});
 await mkdir(join(root,'new-policy'));await symlink(join(dir,'outside-unreadable'),join(root,'new-policy/SKILL.md'));
 const fresh=(await library.refresh()).find(item=>item.directoryName==='new-policy');
 assert.equal(fresh.enabledState,'unknown');assert.equal(fresh.currentRevisionNo,null);assert.deepEqual(fresh.revisions,[]);
});

test('冻结根与包目录身份，替换成同字节新目录也不可在正文读取时重新信任',async t=>{
 const {root,library,item,document}=await fixture(t),anchor=skillAnchor(item);
 await rename(root,root+'-original');await mkdir(join(root,'gentle'),{recursive:true});await writeFile(join(root,'gentle/SKILL.md'),document);
 await assert.rejects(library.assertAnchor(anchor),{code:'skill_directory_conflict'});
 await rm(root,{recursive:true});await rename(root+'-original',root);
 assert.equal((await library.get(item.id)).verificationState,'conflict');
 const reader=new SecureSkillDirectory(root),identity=reader.directoryIdentity('gentle');
 await rename(join(root,'gentle'),join(root,'old-package'));await mkdir(join(root,'gentle'));await writeFile(join(root,'gentle/SKILL.md'),document);
 assert.throws(()=>reader.snapshot('gentle',identity),{code:'skill_directory_conflict'});
});

test('逐段拒绝根祖先、包、正文、资源文件及资源目录链接，拒绝硬链接与任意路径',async t=>{
 const {dir,root,item}=await fixture(t),reader=new SecureSkillDirectory(root),identity=item.directoryIdentity;
 await symlink(root,join(dir,'root-link'));
 assert.throws(()=>new SecureSkillDirectory(join(dir,'root-link')),{code:'skill_package_invalid'});
 assert.throws(()=>reader.directoryIdentity('../gentle'));
 await rename(join(root,'gentle/SKILL.md'),join(dir,'original-document'));
 await symlink(join(dir,'original-document'),join(root,'gentle/SKILL.md'));
 assert.throws(()=>reader.snapshot('gentle',identity),{code:'skill_package_invalid'});
 await rm(join(root,'gentle/SKILL.md'));await link(join(dir,'original-document'),join(root,'gentle/SKILL.md'));
 assert.throws(()=>reader.snapshot('gentle',identity),{code:'skill_package_invalid'});
 await rm(join(root,'gentle/SKILL.md'));await rename(join(dir,'original-document'),join(root,'gentle/SKILL.md'));
 await rename(join(root,'gentle/references'),join(dir,'references-retained'));
 await symlink(join(dir,'references-retained'),join(root,'gentle/references'));
 assert.throws(()=>reader.snapshot('gentle',identity),{code:'skill_package_invalid'});
 await rm(join(root,'gentle/references'));await rename(join(dir,'references-retained'),join(root,'gentle/references'));
 await symlink(join(root,'gentle/SKILL.md'),join(root,'gentle/references/linked.md'));
 assert.throws(()=>reader.snapshot('gentle',identity),{code:'skill_package_invalid'});
});

test('资源目录在并发替换为越界链接时，只能返回原有效字节或拒绝结果',async t=>{
 const {dir,root,library,item}=await fixture(t),anchor=skillAnchor(item),outside=join(dir,'outside');
 await mkdir(outside);await writeFile(join(outside,'guide.md'),'不得读取的目录外合成文本。');
 const worker=spawn(process.execPath,['--input-type=module','-e',`
 import{renameSync,symlinkSync,unlinkSync,existsSync,lstatSync}from'node:fs';
 const [base,outside]=process.argv.slice(1),target=base+'/gentle/references',retained=base+'/retained';
 function restore(){try{if(existsSync(target)&&lstatSync(target).isSymbolicLink())unlinkSync(target);if(existsSync(retained))renameSync(retained,target);}catch{}}
 process.on('SIGTERM',()=>{restore();process.exit(0);});console.log('READY');
 function turn(){for(let i=0;i<20;i++)try{renameSync(target,retained);symlinkSync(outside,target);unlinkSync(target);renameSync(retained,target);}catch{restore();}setImmediate(turn);}turn();
 `,root,outside],{stdio:['ignore','pipe','ignore']});
 await once(worker.stdout,'data');const exited=once(worker,'exit');
 t.after(async()=>{if(worker.exitCode===null)worker.kill('SIGTERM');await exited;});
 for(let i=0;i<20;i++){
  try {const snapshot=await library.assertAnchor(anchor);assert.equal(snapshot.pkg.resources[0].content.toString(),'已核验合成资料。');}
  catch(error){assert.ok(['skill_package_invalid','skill_directory_unavailable','skill_content_changed','skill_run_invalidated'].includes(error.code),error.code);}
 }
 worker.kill('SIGTERM');await exited;
});


test('合同允许的50目录100资源可完整读取，不增加文件描述符总数限制',async t=>{
 const {root,item}=await fixture(t),packagePath=join(root,'gentle');
 await rm(join(packagePath,'references'),{recursive:true});
 for(let i=0;i<50;i++){
  const directory=join(packagePath,'references',`section-${i}`);await mkdir(directory,{recursive:true});
  await writeFile(join(directory,'a.md'),`合成资料甲 ${i}。`);await writeFile(join(directory,'b.md'),`合成资料乙 ${i}。`);
 }
 const expected=readPackage(packagePath);assert.equal(expected.resources.length,100);
 const reader=new SecureSkillDirectory(root),snapshot=reader.snapshot('gentle',item.directoryIdentity);
 assert.equal(snapshot.pkg.resources.length,100);assert.equal(snapshot.pkg.package_sha256,expected.package_sha256);
 // 同一合法包在较低进程 FD 额度下仍可读取；数量不应要求整包同时持有 FD。
 const rootStat=await stat(root,{bigint:true});
 const limited=spawnSync('/bin/bash',['-c','ulimit -n 32; exec "$@"','skill-reader-test',resolve('../native/skill-read/.build/skill-read'),'package',root,'gentle',rootStat.dev.toString(),rootStat.ino.toString(),...JSON.parse(item.directoryIdentity).slice(1)],{encoding:'utf8',timeout:5000,maxBuffer:12*1024*1024,env:{PATH:'/usr/bin:/bin'}});
 assert.equal(limited.status,0,limited.stdout);assert.equal(JSON.parse(limited.stdout).files.length,101);

});

test('较深的合法资源路径沿既有操作系统路径规则读取，不新增16层限制',async t=>{
 const {root,item}=await fixture(t),packagePath=join(root,'gentle');
 await rm(join(packagePath,'references'),{recursive:true});
 const deep=join(packagePath,'references',...Array.from({length:48},(_,i)=>`part${i}`));
 await mkdir(deep,{recursive:true});await writeFile(join(deep,'guide.md'),'深目录中的合成辅助资料。');
 const expected=readPackage(packagePath);assert.equal(expected.resources.length,1);
 const reader=new SecureSkillDirectory(root),snapshot=reader.snapshot('gentle',item.directoryIdentity);
 assert.equal(snapshot.pkg.resources[0].content.toString(),'深目录中的合成辅助资料。');
 assert.equal(snapshot.pkg.package_sha256,expected.package_sha256);
});


test('授权根发现沿既有预算处理目录，不新增1024包数量限制',async t=>{
 const {root}=await fixture(t);
 await Promise.all(Array.from({length:1025},(_,i)=>mkdir(join(root,`policy-${i}`))));
 const names=new SecureSkillDirectory(root).names();
 assert.equal(names.length,1026);assert.ok(names.includes('gentle'));assert.ok(names.includes('policy-0'));assert.ok(names.includes('policy-1024'));
});
