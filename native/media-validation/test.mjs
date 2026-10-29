import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createVisualValidator} from '../../backend-ts/src/media/visual/native.ts';
const directory=await mkdtemp(join(tmpdir(),'notalone-visual-'));
const nativeRoot=fileURLToPath(new URL('.',import.meta.url));
const binary=join(nativeRoot,'.build/media-validation');
const validate=createVisualValidator(binary);
const signal=()=>new AbortController().signal;
// 有界、明确的测试准备；产品不编译或自动下载资产。
execFileSync('bash',[join(nativeRoot,'build.sh')],{stdio:'pipe'});
execFileSync('bash',[join(nativeRoot,'build-fixtures.sh'),directory],{stdio:'pipe'});
test.after(async()=>{await rm(directory,{recursive:true,force:true});});
test('实际原生探针按内容解码PNG，不按扩展名或尺寸宣称原图',async()=>{
 const file=join(directory,'picture.media');
 await writeFile(file,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'));
 assert.deepEqual(await validate(file,'image',signal()),{format:'png',mimeType:'image/png',containerValid:true,viewable:true,playable:false});
});
test('图片末尾截短不能因ImageIO宽松解码而冒充完整',async()=>{
 for(const name of ['png','jpeg','gif','bmp']) {
  const bytes=await readFile(join(directory,name));
  for(const cut of [1,8,Math.floor(bytes.length/2)]) {
   const file=join(directory,'truncated-'+name);await writeFile(file,bytes.subarray(0,-cut));
   await assert.rejects(validate(file,'image',signal()),{code:'media_image_invalid'},name+':'+cut);
  }
 }
});
test('支持PNG JPEG BMP及完整GIF每帧，明确拒绝未支持容器',async()=>{
 for(const name of ['png','jpeg','gif','bmp']) {
  const result=await validate(join(directory,name),'image',signal());assert.equal(result.format,name);assert.equal(result.viewable,true);
 }
 await assert.rejects(validate(join(directory,'tiff'),'image',signal()),{code:'media_format_unsupported'});
 await assert.rejects(validate(join(directory,'many.gif'),'image',signal()),{code:'media_resource_limit'});
 const corrupt=await readFile(join(directory,'png'));corrupt[corrupt.length-1]^=1;
 await writeFile(join(directory,'bad-crc'),corrupt);
 await assert.rejects(validate(join(directory,'bad-crc'),'image',signal()),{code:'media_image_invalid'});
});
test('MP4 H264及AAC实际解码全轨，拒绝HEVC、截断与外部引用',async()=>{
 for(const name of ['h264.mp4','h264-aac.mp4'])assert.deepEqual(await validate(join(directory,name),'video',signal()),{format:'mp4',mimeType:'video/mp4',containerValid:true,viewable:false,playable:true});
 await assert.rejects(validate(join(directory,'hevc.mp4'),'video',signal()),{code:'media_format_unsupported'});
 const original=await readFile(join(directory,'h264.mp4'));
 for(const cut of [1,8,Math.floor(original.length/2)]) {
  await writeFile(join(directory,'cut.mp4'),original.subarray(0,-cut));
  await assert.rejects(validate(join(directory,'cut.mp4'),'video',signal()),{code:'media_video_invalid'});
 }
 const external=Buffer.from(original);const offset=external.indexOf(Buffer.from('url '));assert.ok(offset>0);external.writeUInt32BE(0,offset+4);
 await writeFile(join(directory,'external.mp4'),external);
 await assert.rejects(validate(join(directory,'external.mp4'),'video',signal()),{code:'media_format_unsupported'});
});
test('helper缺失、超限与取消明确失败，等待取消进程退出',async()=>{
 await assert.rejects(createVisualValidator(join(directory,'missing'))(join(directory,'png'),'image',signal()),{code:'media_validator_unavailable'});
 const canceled=new AbortController();canceled.abort();await assert.rejects(validate(join(directory,'png'),'image',canceled.signal),{code:'media_interrupted'});
 await writeFile(join(directory,'oversized'),Buffer.alloc(32*1024*1024+1));
 await assert.rejects(validate(join(directory,'oversized'),'image',signal()),{code:'media_resource_too_large'});
 await symlink(join(directory,'png'),join(directory,'symlink'));
 await assert.rejects(validate(join(directory,'symlink'),'image',signal()),{code:'media_file_io_failed'});
 const hanging=join(directory,'hanging');
 // 使用合成可终止的计算进程证明：取消必须等待子进程退出后才返回。
 await writeFile(hanging,'#!/bin/sh\nwhile :; do :; done\n',{mode:0o700});
 const controller=new AbortController();const pending=createVisualValidator(hanging)(join(directory,'png'),'image',controller.signal);
 setTimeout(()=>controller.abort(),10);await assert.rejects(pending,{code:'media_interrupted'});
});

test('真实10秒墙钟超时终止helper并等待退出',async()=>{
 const hanging=join(directory,'timeout-helper');
 await writeFile(hanging,'#!/bin/sh\nwhile :; do :; done\n',{mode:0o700});
 await assert.rejects(createVisualValidator(hanging)(join(directory,'png'),'image',signal()),{code:'media_validation_timeout'});
});
