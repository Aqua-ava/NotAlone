import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadNarrowWechatOptions,supportsWechatQuotes,supportsWechatOriginalImages} from '../src/history/wechat/artifacts.ts';

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
