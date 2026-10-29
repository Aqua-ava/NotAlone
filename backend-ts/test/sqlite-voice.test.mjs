import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectSilk,pcmToWav,inspectWav} from '../src/media/voice/format.ts';

const packets=(...sizes)=>Buffer.concat([Buffer.from('\x02#!SILK_V3'),...sizes.map(n=>{const b=Buffer.alloc(2+Math.max(n,0));b.writeInt16LE(n);return b;})]);
test('严格SILK容器拒绝未知头、半帧、无效包长和不足前置包，整帧截短只证明结构',()=>{
 assert.equal(inspectSilk(packets(1,1,1)).packets,3);
 assert.equal(inspectSilk(packets(1,1,1,-1)).termination,'sentinel');
 for(const data of [Buffer.from('#!SILK_V3'),packets(1,1),packets(1,1,0),packets(1,1,-2),packets(1,1,1251),packets(1,1,1).subarray(0,-1),Buffer.concat([packets(1,1,1,-1),Buffer.from([0])])])assert.throws(()=>inspectSilk(data));
 const whole=packets(1,1,1,1);assert.equal(inspectSilk(whole.subarray(0,-3)).packets,3);
 assert.throws(()=>inspectSilk(packets(...Array(601).fill(1))),{code:'voice_resource_limit'});
});
test('WAV采用24k单声道s16le，精确RIFF与PCM长度，拒绝奇数字节及坏头',()=>{
 const wav=pcmToWav(Buffer.alloc(9600));assert.deepEqual(inspectWav(wav),{sampleRate:24000,channels:1,bitsPerSample:16,pcmBytes:9600,durationMs:200});
 assert.equal(wav.readUInt32LE(4),9636);assert.equal(wav.readUInt32LE(28),48000);
 assert.throws(()=>pcmToWav(Buffer.alloc(3)));wav[22]=2;assert.throws(()=>inspectWav(wav));
});

import {VoiceMediaAdapter} from '../src/media/voice/adapter.ts';
import {fixture} from './media-support.mjs';
import {createHash} from 'node:crypto';
const digest=data=>createHash('sha256').update(data).digest('hex');
function syntheticPort(data,options={}) {return {read:async context=>({expectedBytes:options.expectedBytes??data.length,expectedSha256:digest(data),bytes:(async function*(){yield data;})(),finish:async()=>({protocol:'voice-complete-read-v1',complete:options.complete??true,expectedBytes:options.expectedBytes??data.length,association:{protocol:'media-association-v1',profileId:'synthetic-voice-v1',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-voice-resource'}})})};}
test('缺完整读取证明不能发布SILK；合法SILK解码失败明确有限结果，读取关闭可本地重转',async t=>{
 const silk=packets(1,1,1);let fail=true,reads=0;
 const port=syntheticPort(silk,{complete:false});const read=port.read;port.read=async c=>{reads++;return read(c);};
 const decoder={decode:async()=>{if(fail)throw Error('不向外输出的私密解码细节');return Buffer.alloc(9600);},close:async()=>{}};
 const adapter=new VoiceMediaAdapter({source:port,decoder});const f=await fixture(t,adapter);const m=f.messages.find(m=>m.kind==='voice');
 await assert.rejects(f.media.extract(f.contact,m.id,{requestKey:'missing-proof',goal:'extract'}),{code:'voice_copy_unproven'});assert.equal((await f.media.read(f.contact,m.id)).files.length,0);
 port.read=async c=>{reads++;return syntheticPort(silk).read(c);};
 const first=await f.media.extract(f.contact,m.id,{requestKey:'silk-limited',goal:'extract'});assert.equal(first.latestAttempt.outcome,'limited');assert.equal(first.latestAttempt.errorCode,'voice_decode_failed');assert.equal(first.files[0].format,'silk');assert.equal(first.files[0].playable,false);
 await f.contacts.setReading(false);fail=false;
 const result=await f.media.extract(f.contact,m.id,{requestKey:'local-retry',goal:'audio_conversion'});assert.equal(result.latestAttempt.outcome,'full');assert.equal(result.files.length,2);assert.equal(reads,2);assert.equal(result.files.find(f=>f.role==='audio_playback').playable,true);
 await f.media.clear(f.contact,m.id,'voice-clear');assert.deepEqual((await f.media.read(f.contact,m.id)).files,[]);assert.equal((await f.history.read(f.contact)).messages.length,4);
});
