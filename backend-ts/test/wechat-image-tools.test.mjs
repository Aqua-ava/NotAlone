import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createImageRuntimeKeyProvider} from '../src/media/visual/image-tools.ts';

async function fixture(t,{wrongAccount=false}={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-image-key-synthetic-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const dbRoot=join(root,'synthetic-account');await mkdir(dbRoot);
 const configPath=join(root,'config.json'),keyTool=join(root,'wxkey'),calls=join(root,'calls');
 await writeFile(configPath,JSON.stringify({wxid:'synthetic-account',db_root:dbRoot}),{mode:0o600});
 await writeFile(keyTool,`#!${process.execPath}\nimport fs from 'node:fs';fs.appendFileSync(${JSON.stringify(calls)},'called\\n');console.log(JSON.stringify({wxid:${JSON.stringify(wrongAccount?'another-account':'synthetic-account')},scan_root:${JSON.stringify(dbRoot)},image_key:{key:'0123456789abcdef',xor_key:138}}));`,{mode:0o700});
 const provider=createImageRuntimeKeyProvider({configPath,keyTool});t.after(()=>provider.clear());
 return {provider,calls,configPath,dbRoot};
}

test('图片密钥按账号在内存复用，调用方清零副本不破坏下一张原图',async t=>{
 const f=await fixture(t),signal=new AbortController().signal;
 const first=await f.provider.prepare('synthetic-account',signal);
 assert.equal(Buffer.from(first.aesKey).toString(),'0123456789abcdef');assert.equal(first.xorKey,138);
 assert.equal(first.rootSha256,createHash('sha256').update(f.dbRoot).digest('hex'));
 first.aesKey.fill(0);
 const second=await f.provider.prepare('synthetic-account',signal);
 assert.equal(Buffer.from(second.aesKey).toString(),'0123456789abcdef');second.aesKey.fill(0);
 assert.equal(await readFile(f.calls,'utf8'),'called\n');
 assert.equal(JSON.parse(await readFile(f.configPath,'utf8')).image_key,undefined);
 await f.provider.clear();
 const third=await f.provider.prepare('synthetic-account',signal);third.aesKey.fill(0);
 assert.equal(await readFile(f.calls,'utf8'),'called\ncalled\n');
});

test('账号不匹配不调用图片工具；工具返回其他账号密钥不接受',async t=>{
 const f=await fixture(t,{wrongAccount:true}),signal=new AbortController().signal;
 assert.equal(await f.provider.prepare('unconfirmed-account',signal),null);
 await assert.rejects(readFile(f.calls),{code:'ENOENT'});
 assert.equal(await f.provider.prepare('synthetic-account',signal),null);
 assert.equal(await readFile(f.calls,'utf8'),'called\n');
});

test('取消的图片密钥准备不启动外部进程',async t=>{
 const f=await fixture(t),controller=new AbortController();controller.abort();
 await assert.rejects(f.provider.prepare('synthetic-account',controller.signal),{code:'media_interrupted'});
 await assert.rejects(readFile(f.calls),{code:'ENOENT'});
});
