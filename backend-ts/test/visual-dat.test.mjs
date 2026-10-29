import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv} from 'node:crypto';
import {decodeWechatDat} from '../src/media/visual/dat.ts';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==','base64');
test('纯字节V3还原不依赖路径或外部密钥，返回后仍须实际解码',()=>{
 const encrypted=png.map(v=>v^0x8a);
 assert.deepEqual(decodeWechatDat(encrypted),png);
 assert.deepEqual(encrypted,png.map(v=>v^0x8a));
});

export function v4(bytes,{version=1,key=Buffer.from('cfcd208495d565ef'),aesSize=16,xorSize=8,xorKey=0x31}={}){
 const cipher=createCipheriv('aes-128-ecb',key,null),aes=Buffer.concat([cipher.update(bytes.subarray(0,aesSize)),cipher.final()]);
 const header=Buffer.from([7,8,0x56,0x30+version,8,7,0,0,0,0,0,0,0,0,0]);header.writeUInt32LE(aesSize,6);header.writeUInt32LE(xorSize,10);
 return Buffer.concat([header,aes,bytes.subarray(aesSize,bytes.length-xorSize),bytes.subarray(bytes.length-xorSize).map(v=>v^xorKey)]);
}
test('V4已核验版本按AES、明文、XOR分段还原，V2缺密钥保持不可用',()=>{
 assert.deepEqual(decodeWechatDat(v4(png),{xorKey:0x31}),png);
 const key=Buffer.from('synthetic-key17!'),encrypted=v4(png,{version:2,key});
 assert.throws(()=>decodeWechatDat(encrypted,{xorKey:0x31}),{code:'needs_image_key'});
 assert.deepEqual(decodeWechatDat(encrypted,{aesKey:key,xorKey:0x31}),png);
});
test('DAT拒绝未知版本和WXGF，不把未支持封装伪装成图片',()=>{
 assert.throws(()=>decodeWechatDat(Buffer.from('wxgf-unsupported')),{code:'unsupported'});
 const unknown=v4(png);unknown[3]=0x33;assert.throws(()=>decodeWechatDat(unknown),{code:'unsupported'});
 const reserved=v4(png);reserved[14]=1;assert.throws(()=>decodeWechatDat(reserved),{code:'unsupported'});
 assert.throws(()=>decodeWechatDat(v4(Buffer.concat([Buffer.from('wxgf'),Buffer.alloc(60)])),{xorKey:0x31}),{code:'unsupported'});
});
test('DAT声明长度与padding先核验，超长整数不溢出，V2错误密钥明确拒绝',()=>{
 for(const length of [0xffffffff,0xfffffff0]){
  const aes=v4(png);aes.writeUInt32LE(length,6);assert.throws(()=>decodeWechatDat(aes,{xorKey:0x31}),{code:'image_dat_invalid'});
  const xor=v4(png);xor.writeUInt32LE(length,10);assert.throws(()=>decodeWechatDat(xor,{xorKey:0x31}),{code:'image_dat_invalid'});
 }
 const truncated=v4(png).subarray(0,14);assert.throws(()=>decodeWechatDat(truncated),{code:'image_dat_invalid'});
 const mismatch=v4(png);mismatch.writeUInt32LE(17,6);assert.throws(()=>decodeWechatDat(mismatch,{xorKey:0x31}),{code:'image_dat_invalid'});
 const invalid=Buffer.from(png.subarray(0,16));invalid[15]=0;
 const cipher=createCipheriv('aes-128-ecb',Buffer.from('cfcd208495d565ef'),null);cipher.setAutoPadding(false);
 const padding=v4(png);Buffer.concat([cipher.update(invalid),cipher.final()]).copy(padding,31);
 assert.throws(()=>decodeWechatDat(padding,{xorKey:0x31}),{code:'image_dat_invalid'});
 const key=Buffer.from('synthetic-key17!');assert.throws(()=>decodeWechatDat(v4(png,{version:2,key}),{aesKey:Buffer.alloc(16),xorKey:0x31}),{code:'needs_image_key'});
 assert.throws(()=>decodeWechatDat(Buffer.alloc(32*1024*1024+1)),{code:'media_resource_too_large'});
});
