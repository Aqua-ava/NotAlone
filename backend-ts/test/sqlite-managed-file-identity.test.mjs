import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,rm,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {MediaFiles} from '../src/media/sqlite/files.ts';

// 合成夹具：受管文件身份不再包含系统设备号；重启或重新挂载后设备号变化不得使既有受管文件失效。
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-managed-identity-')));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'managed'),{mode:0o700});
 const files=new MediaFiles(root);
 const locator='00000000-0000-4000-8000-0000000000aa.media';
 const bytes=Buffer.from('synthetic-managed-file');
 await writeFile(join(root,'managed','media',locator),bytes,{mode:0o600});
 const address=files.managed.capture('media',locator);
 return {files,address,path:join(root,'managed','media',locator),size:bytes.length,digest:createHash('sha256').update(bytes).digest('hex'),bytes};
}
const withDevice=(address,dev)=>({...address,identity:{...address.identity,dev},ancestors:address.ancestors.map(item=>({...item,dev}))});

test('新捕获的受管文件身份不含设备号，仍保留 inode、创建时间与属主',async t=>{
 const {address}=await fixture(t);
 for(const item of [address.identity,...address.ancestors]){
  assert.equal(Object.hasOwn(item,'dev'),false);
  for(const key of ['ino','birthtimeNs','uid'])assert.match(item[key],/^\d+$/);
 }
});

test('库内旧记录带有不同的设备号时，读取、预览与校验仍通过',async t=>{
 const {files,address,size,digest,bytes}=await fixture(t);
 const legacy=withDevice(address,'999999999');
 await files.verify(legacy,size,digest);
 assert.deepEqual(await files.preview(legacy,size,digest),bytes);
 assert.equal(files.location(legacy).endsWith(address.locator),true);
});

test('inode 或创建时间变化仍判为身份变化',async t=>{
 const {files,address,size,digest}=await fixture(t);
 const swapped=structuredClone(address);swapped.identity.ino=String(BigInt(swapped.identity.ino)+1n);
 await assert.rejects(files.verify(swapped,size,digest),{message:'media_file_identity_changed'});
 const reborn=structuredClone(address);reborn.identity.birthtimeNs=String(BigInt(reborn.identity.birthtimeNs)+1n);
 await assert.rejects(async()=>files.location(reborn),{message:'media_file_identity_changed'});
 const ancestor=structuredClone(address);ancestor.ancestors[0].ino=String(BigInt(ancestor.ancestors[0].ino)+1n);
 await assert.rejects(async()=>files.location(ancestor),{message:'media_file_identity_changed'});
});

test('旧记录带设备号时受管删除仍按其余身份核对并删除文件',async t=>{
 const {files,address,path}=await fixture(t);
 const legacy=withDevice(address,'999999999');
 files.managed.erase(legacy);
 await assert.rejects(stat(path),{code:'ENOENT'});
});
