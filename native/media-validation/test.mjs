import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, open, readFile, writeFile, rm, symlink, unlink, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {constants as fileConstants} from 'node:fs';
import {createVisualValidator} from '../../backend-ts/src/media/visual/native.ts';
const directory=await mkdtemp(join(tmpdir(),'notalone-visual-'));
const nativeRoot=fileURLToPath(new URL('.',import.meta.url));
const binary=join(nativeRoot,'.build/media-validation');
const validate=createVisualValidator(binary);
test.after(async()=>{await rm(directory,{recursive:true,force:true});});
const signal=()=>new AbortController().signal;
async function decodeWxgf(file){
 const handle=await open(file,fileConstants.O_RDONLY|fileConstants.O_NOFOLLOW);
 try{return spawnSync(binary,['wxgf'],{encoding:null,timeout:12_000,maxBuffer:32*1024*1024+4096,stdio:['ignore','pipe','pipe',handle.fd]});}
 finally{await handle.close();}
}
async function decodeUnlinkedWxgf(file){
 const handle=await open(file,fileConstants.O_RDONLY|fileConstants.O_NOFOLLOW);
 try{
  await unlink(file);
  assert.equal((await handle.stat()).nlink,0);
  const result=spawnSync(binary,['wxgf'],{encoding:null,timeout:12_000,maxBuffer:32*1024*1024+4096,stdio:['ignore','pipe','pipe',handle.fd]});
  assert.deepEqual(await readdir(dirname(file)),[]);
  return result;
 }finally{await handle.close();}
}
// 有界、明确的测试准备；产品不编译或自动下载资产。
execFileSync('bash',[join(nativeRoot,'build.sh')],{stdio:'pipe'});
execFileSync('bash',[join(nativeRoot,'build-fixtures.sh'),directory],{stdio:'pipe',timeout:60_000});
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
test('JPEG按段结构接受至多32字节尾随，拒绝截断、超限与拼接第二张图',async()=>{
 const bytes=await readFile(join(directory,'jpeg'));
 const withTail=size=>Buffer.concat([bytes,Buffer.alloc(size,0x5a)]);
 for(const size of [1,24,32]){
  const file=join(directory,'jpeg-tail-'+size);await writeFile(file,withTail(size));
  assert.deepEqual(await validate(file,'image',signal()),{format:'jpeg',mimeType:'image/jpeg',containerValid:true,viewable:true,playable:false},'尾随'+size);
 }
 for(const [name,payload] of [['jpeg-tail-33',withTail(33)],['jpeg-tail-image',Buffer.concat([bytes,Buffer.from([0xff,0xd8,0xff,0xd9])])],['jpeg-no-eoi',bytes.subarray(0,-2)]]){
  const file=join(directory,name);await writeFile(file,payload);
  await assert.rejects(validate(file,'image',signal()),{code:'media_image_invalid'},name);
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
test('WXGF中的HEVC帧解码为同尺寸PNG',async()=>{
 const input=join(directory,'wxgf');
 const result=await decodeWxgf(input);
 assert.equal(result.status,0,result.stderr?.toString());
 assert.deepEqual([...result.stdout.subarray(0,8)],[137,80,78,71,13,10,26,10]);
 const output=join(directory,'wxgf.png');await writeFile(output,result.stdout);
 assert.deepEqual(await validate(output,'image',signal()),{format:'png',mimeType:'image/png',containerValid:true,viewable:true,playable:false});
});
test('WXGF包头伪起始码后仍解码合法HEVC单帧',async()=>{
 const input=join(directory,'wxgf.header-preamble');
 const result=await decodeWxgf(input);
 assert.equal(result.status,0,result.stderr?.toString());
 assert.deepEqual([...result.stdout.subarray(0,8)],[137,80,78,71,13,10,26,10]);
 const output=join(directory,'wxgf.header-preamble.png');await writeFile(output,result.stdout);
 assert.deepEqual(await validate(output,'image',signal()),{format:'png',mimeType:'image/png',containerValid:true,viewable:true,playable:false});
});
test('WXGF可从已unlink的继承fd3解码且不创建临时文件',async()=>{
 const scratch=join(directory,'wxgf-unlinked');await mkdir(scratch);
 const input=join(scratch,'input');await writeFile(input,await readFile(join(directory,'wxgf')));
 const result=await decodeUnlinkedWxgf(input);
 assert.equal(result.status,0,result.stderr?.toString());
 assert.deepEqual([...result.stdout.subarray(0,8)],[137,80,78,71,13,10,26,10]);
 assert.deepEqual(await readdir(scratch),[]);
});
test('WXGF内嵌JPEG与PNG保留内容并转成经过校验的PNG',async()=>{
 for(const name of ['jpeg','png']){
  const input=join(directory,'wxgf-'+name);await writeFile(input,Buffer.concat([Buffer.from('wxgf'),await readFile(join(directory,name))]));
  const result=await decodeWxgf(input);assert.equal(result.status,0,result.stderr?.toString());
  const output=join(directory,'wxgf-'+name+'.png');await writeFile(output,result.stdout);
  assert.deepEqual(await validate(output,'image',signal()),{format:'png',mimeType:'image/png',containerValid:true,viewable:true,playable:false});
 }
});
test('拒绝损坏或无法完整解码的WXGF，不输出部分图片',async()=>{
 const source=await readFile(join(directory,'wxgf'));
 for(const [name,bytes] of [['truncated',source.subarray(0,-8)],['unknown',Buffer.from('wxgfnot-an-image')],['multiframe',await readFile(join(directory,'wxgf.multiframe'))],['header-over-limit',await readFile(join(directory,'wxgf.header-over-limit'))]]){
  const input=join(directory,'wxgf-'+name);await writeFile(input,bytes);
  const result=await decodeWxgf(input);assert.equal(result.status,1,name);assert.equal(result.stdout.length,0,name);
  assert.match(result.stderr.toString(),/^media_(image_invalid|format_unsupported)\n$/);
 }
});
test('合成夹具自测覆盖JPEG容器与HEVC双帧分类、分组和透明度合成',()=>{
 const result=execFileSync('bash',[join(nativeRoot,'build-fixtures.sh'),'--selftest'],{stdio:'pipe',timeout:60_000});
 assert.match(result.toString(),/selftest ok/);
});
test('WXGF双帧彩色加单色透明度输出alpha PNG，透明度不可用时退回不透明彩色图',async()=>{
 const plain=await decodeWxgf(join(directory,'wxgf'));
 assert.equal(plain.status,0,plain.stderr?.toString());
 const dual=await decodeWxgf(join(directory,'wxgf.dual-frame'));
 assert.equal(dual.status,0,dual.stderr?.toString());
 assert.deepEqual([...dual.stdout.subarray(0,8)],[137,80,78,71,13,10,26,10]);
 assert.equal(dual.stdout[25],6,'彩色帧加透明度应输出带alpha的PNG');
 const alphaOutput=join(directory,'wxgf.dual-frame.png');await writeFile(alphaOutput,dual.stdout);
 assert.deepEqual(await validate(alphaOutput,'image',signal()),{format:'png',mimeType:'image/png',containerValid:true,viewable:true,playable:false});
 const broken=await decodeWxgf(join(directory,'wxgf.dual-frame-broken-alpha'));
 assert.equal(broken.status,0,broken.stderr?.toString());
 assert.equal(broken.stdout[25],2,'透明度解码失败时应退回不透明PNG');
 assert.ok(broken.stdout.equals(plain.stdout),'透明度解码失败时应退回与单帧彩色一致的不透明图');
 for(const name of ['wxgf.dual-frame-sei','wxgf.dual-frame-sei-leading']){
  const result=await decodeWxgf(join(directory,name));
  assert.equal(result.status,0,name+':'+(result.stderr?.toString()??''));
  assert.ok(result.stdout.equals(dual.stdout),name+'应与无SEI双帧输出一致');
 }
 const singleSei=await decodeWxgf(join(directory,'wxgf.sei'));
 assert.equal(singleSei.status,0,singleSei.stderr?.toString());
 assert.ok(singleSei.stdout.equals(plain.stdout),'单帧带SEI输出应与无SEI单帧一致');
 const unsupported=await decodeWxgf(join(directory,'wxgf.dual-frame-two-color'));
 assert.equal(unsupported.status,1);
 assert.equal(unsupported.stdout.length,0);
 assert.match(unsupported.stderr.toString(),/^media_format_unsupported\n$/);
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
