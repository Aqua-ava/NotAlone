import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadSharedNarrowWechatOptions,loadNarrowWechatOptions,supportsWechatQuotes,supportsWechatOriginalImages} from '../src/history/wechat/artifacts.ts';

test('旧引用组件保留普通读取和图片能力，仅完整认证的tail引用reader启用补齐',async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-quote-artifact-'))),executable=path.join(root,'bin/wechat-cli');
 t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.dirname(executable));await writeFile(executable,'synthetic-cli',{mode:0o700});
 const manifest={cliSha256:'a'.repeat(64),wcdbSha256:'b'.repeat(64),originalImageProtocol:'wechat-original-image-v1',originalImageQualityProof:'wechat-message-image-content-v1',quoteProtocol:'wechat-quote-message-v1'};
 const save=reader=>writeFile(path.join(root,'manifest.json'),JSON.stringify({...manifest,...(reader===null?{}:{quoteReader:reader})}));
 await save(null);assert.equal(await supportsWechatQuotes(executable),false);
 assert.equal((await loadNarrowWechatOptions(executable)).expectedCliSha256,manifest.cliSha256);assert.equal(await supportsWechatOriginalImages(executable),true);
 await save('unverified');assert.equal(await supportsWechatQuotes(executable),false);
 await save('wechat-quote-normal-tail-v1');assert.equal(await supportsWechatQuotes(executable),false);
 await save('wechat-quote-normal-tail-v2');assert.equal(await supportsWechatQuotes(executable),true);assert.equal(await supportsWechatOriginalImages(executable),true);
});

test('仅声明完整内联引用协议的组件启用同步引用解码，旧组件继续普通读取',async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-inline-quote-artifact-'))),executable=path.join(root,'bin/wechat-cli');
 t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.dirname(executable));await writeFile(executable,'synthetic-cli',{mode:0o700});
 const manifest={cliSha256:'a'.repeat(64),wcdbSha256:'b'.repeat(64),quoteProtocol:'wechat-quote-message-v1',quoteReader:'wechat-quote-normal-tail-v2'};
 const save=extra=>writeFile(path.join(root,'manifest.json'),JSON.stringify({...manifest,...extra}));
 await save({});assert.equal((await loadNarrowWechatOptions(executable)).inlineQuotes,undefined);
 await save({quoteInline:'unverified'});assert.equal((await loadNarrowWechatOptions(executable)).inlineQuotes,undefined);
 await save({quoteInline:'wechat-quote-inline-sync-v1'});assert.equal((await loadNarrowWechatOptions(executable)).inlineQuotes,true);
 assert.equal(await supportsWechatQuotes(executable),true,'内联组件继续支持旧占位补齐');
 await save({quoteInline:'wechat-quote-inline-sync-v1',quoteProtocol:'unverified'});assert.equal((await loadNarrowWechatOptions(executable)).inlineQuotes,undefined);
});


test('共享宿主仅接受显式共享进程协议，旧独立客户端继续可加载用于升级对照',async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-shared-artifact-'))),executable=path.join(root,'bin/wechat-cli');
 t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.dirname(executable));await writeFile(executable,'synthetic-cli',{mode:0o700});
 const manifest={cliSha256:'a'.repeat(64),wcdbSha256:'b'.repeat(64)};
 const save=extra=>writeFile(path.join(root,'manifest.json'),JSON.stringify({...manifest,...extra}));
 for(const extra of [{},{sharedProcessProtocol:'unverified'},{sharedProcessProtocol:'wechat-shared-process-v2'}]){
  await save(extra);
  await assert.rejects(loadSharedNarrowWechatOptions(executable),{code:'history_artifact_unverified'});
  assert.equal((await loadNarrowWechatOptions(executable)).expectedCliSha256,manifest.cliSha256);
 }
 await save({sharedProcessProtocol:'wechat-shared-process-v1'});
 assert.deepEqual(await loadSharedNarrowWechatOptions(executable),await loadNarrowWechatOptions(executable));
});
