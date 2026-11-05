import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resourceDatabaseKeyMissing,resetDatabaseKeyDiagnosis} from '../src/media/visual/database-keys.ts';

// 合成数据：只用随机盐与占位密钥，不涉及任何真实微信资料。
const salt=Buffer.from('0123456789abcdef0123456789abcdef','hex');
const saltHex=salt.toString('hex');

async function fixture(t,{keys,header=salt,mode=0o600,database=true}={}){
 const root=await mkdtemp(join(tmpdir(),'notalone-db-key-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const accountRoot=join(root,'account');
 await mkdir(join(accountRoot,'db_storage/message'),{recursive:true});
 if(database){const page=Buffer.alloc(4096);header.copy(page,0);await writeFile(join(accountRoot,'db_storage/message/message_resource.db'),page);}
 const config=join(root,'config.json');
 await writeFile(config,JSON.stringify({schema_version:2,wxid:'synthetic',db_root:accountRoot,keys:keys??{}}),{mode});
 await chmod(config,mode);
 resetDatabaseKeyDiagnosis();
 return {root,config,accountRoot};
}

test('资源库当前盐在密钥表中没有条目时判定为缺密钥',async t=>{
 const f=await fixture(t,{keys:{['f'.repeat(32)]:'0'.repeat(64)}});
 assert.equal(await resourceDatabaseKeyMissing(f.config),true);
});

test('密钥表含该盐（大小写不敏感）时不报缺密钥',async t=>{
 const f=await fixture(t,{keys:{[saltHex.toUpperCase()]:'0'.repeat(64)}});
 assert.equal(await resourceDatabaseKeyMissing(f.config),false);
});

test('无法明确判断时一律不改变原有错误',async t=>{
 const base={keys:{['f'.repeat(32)]:'0'.repeat(64)}};
 // 配置权限过宽、库不存在、库未加密、配置缺失或路径无效。
 assert.equal(await resourceDatabaseKeyMissing((await fixture(t,{...base,mode:0o644})).config),false);
 assert.equal(await resourceDatabaseKeyMissing((await fixture(t,{...base,database:false})).config),false);
 assert.equal(await resourceDatabaseKeyMissing((await fixture(t,{...base,header:Buffer.from('SQLite format 3\0')})).config),false);
 resetDatabaseKeyDiagnosis();
 assert.equal(await resourceDatabaseKeyMissing(join(tmpdir(),'notalone-no-such-config.json')),false);
 assert.equal(await resourceDatabaseKeyMissing('relative.json'),false);
 assert.equal(await resourceDatabaseKeyMissing(undefined),false);
});

test('符号链接配置不被跟随',async t=>{
 const f=await fixture(t,{keys:{['f'.repeat(32)]:'0'.repeat(64)}});
 const link=join(f.root,'link.json');await symlink(f.config,link);resetDatabaseKeyDiagnosis();
 assert.equal(await resourceDatabaseKeyMissing(link),false);
});

test('结果短期缓存，补取密钥后重置即可立即复核',async t=>{
 const f=await fixture(t,{keys:{['f'.repeat(32)]:'0'.repeat(64)}});
 assert.equal(await resourceDatabaseKeyMissing(f.config,1_000),true);
 await writeFile(f.config,JSON.stringify({schema_version:2,wxid:'synthetic',db_root:f.accountRoot,keys:{[saltHex]:'0'.repeat(64)}}),{mode:0o600});
 assert.equal(await resourceDatabaseKeyMissing(f.config,5_000),true,'缓存期内沿用旧结果');
 assert.equal(await resourceDatabaseKeyMissing(f.config,12_000),false,'缓存过期后重新判断');
});
