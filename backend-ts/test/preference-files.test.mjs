import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,chmod,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {eraseManagedUpdateBackups} from '../src/preferences/preference-files.ts';
// 数据库身份端口为确定性合成值；这些测试只证明文件边界，不代表PG集成。
async function setup(t){
 const root=await mkdtemp(join(tmpdir(),'notalone-preference-files-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const fingerprint=createHash('sha256').update('["123",42,"synthetic",7]').digest('hex');
 const identity={system_identifier:'123',oid:42,datname:'synthetic',datdba:7};
 const client={async query(sql){return {rows:[sql.includes('pg_try_advisory')?{locked:true}:identity]};}};
 await mkdir(join(root,'managed'),{mode:0o700});await writeFile(join(root,'managed','state.json'),JSON.stringify({formatVersion:1,bootstrapComplete:true}),{mode:0o600});
 const checkpoint={format_version:1,target_fingerprint:fingerprint,phase:'complete',restore_verified:true,connection_gate:false};
 async function archive(change={}){const path=join(root,'updates',randomUUID());await mkdir(path,{recursive:true,mode:0o700});await writeFile(join(path,'checkpoint.json'),JSON.stringify({...checkpoint,...change}),{mode:0o600});await writeFile(join(path,'database.dump'),'仅合成备份',{mode:0o600});return path;}
 return {root,client,archive,env:{NOTALONE_MANAGED_USER_DATA:root}};
}
test('全部备份核验归属后只擦dump，同删除重试幂等',async t=>{
 const f=await setup(t),one=await f.archive(),two=await f.archive();
 await eraseManagedUpdateBackups(f.client,f.env);
 for(const path of [one,two]){await assert.rejects(access(join(path,'database.dump')));assert.ok(await readFile(join(path,'checkpoint.json'),'utf8'));}
 await eraseManagedUpdateBackups(f.client,f.env);
});
test('后一备份归属不符时前一备份也不擦除',async t=>{
 const f=await setup(t),one=await f.archive(),two=await f.archive({target_fingerprint:'0'.repeat(64)});
 await assert.rejects(eraseManagedUpdateBackups(f.client,f.env),e=>e.code==='update_backup_cleanup_required');
 for(const path of [one,two])assert.equal(await readFile(join(path,'database.dump'),'utf8'),'仅合成备份');
});
test('未知文件、开放权限和链接都拒绝，外部合成文件保留',async t=>{
 const f=await setup(t),one=await f.archive();await writeFile(join(one,'unknown'),'未知');
 await assert.rejects(eraseManagedUpdateBackups(f.client,f.env));await rm(join(one,'unknown'));
 await chmod(join(one,'checkpoint.json'),0o644);await assert.rejects(eraseManagedUpdateBackups(f.client,f.env));await chmod(join(one,'checkpoint.json'),0o600);
 const external=join(f.root,'external');await writeFile(external,'合成外部',{mode:0o600});await rm(join(one,'database.dump'));await symlink(external,join(one,'database.dump'));
 await assert.rejects(eraseManagedUpdateBackups(f.client,f.env));assert.equal(await readFile(external,'utf8'),'合成外部');
});
test('连接门或激活未完成禁止擦除',async t=>{
 const f=await setup(t);await f.archive({destination_fingerprint:'0'.repeat(64),activation_complete:false,connection_gate:true});
 await assert.rejects(eraseManagedUpdateBackups(f.client,f.env),e=>e.code==='update_backup_cleanup_required');
});
