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

import {SilkWasmDecoder} from '../src/media/voice/decoder.ts';
test('转换取消和退出等待Worker终止；闭合后不重新执行',async()=>{
 const decoder=new SilkWasmDecoder();const controller=new AbortController();const pending=decoder.decode(packets(1,1,1),controller.signal);controller.abort();await assert.rejects(pending,{code:'voice_conversion_cancelled'});
 const next=decoder.decode(packets(1,1,1),new AbortController().signal);const rejected=assert.rejects(next,{code:'voice_conversion_cancelled'});await decoder.close();await rejected;
 await assert.rejects(decoder.decode(packets(1,1,1),new AbortController().signal),{code:'voice_conversion_cancelled'});
});

test('WAV写入失败仍发布已完整校验SILK，失败播放件进入同一删除计划',async t=>{
 const decoder={decode:async()=>Buffer.alloc(9600),close:async()=>{}};
 const f=await fixture(t,new VoiceMediaAdapter({source:syntheticPort(packets(1,1,1)),decoder}));const m=f.messages.find(m=>m.kind==='voice');
 const create=f.media.files.create.bind(f.media.files);let writes=0;
 f.media.files.create=async(...args)=>{writes++;if(writes===2){const {StorageFailure}=await import('../src/storage/sqlite/contracts.ts');throw new StorageFailure('media_space_insufficient');}return create(...args);};
 const result=await f.media.extract(f.contact,m.id,{requestKey:'wav-space-failure',goal:'extract'});
 assert.equal(result.latestAttempt.outcome,'limited');assert.equal(result.latestAttempt.errorCode,'media_space_insufficient');assert.deepEqual(result.files.map(f=>f.role),['audio_source']);
 const {readdir}=await import('node:fs/promises');assert.equal((await readdir(new URL(`file://${f.root}/managed/media/`))).length,1);
 await f.media.clear(f.contact,m.id,'clear-finite-wav-failure');assert.equal((await readdir(new URL(`file://${f.root}/managed/media/`))).length,0);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('锁定WASM离线解码合成纯音，独立afinfo核验PCM格式与播放长度',async t=>{
 const {encode}=await import('silk-wasm');const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {writeFile}=await import('node:fs/promises');
 const input=Buffer.alloc(9600);for(let n=0;n<4800;n++)input.writeInt16LE(Math.round(4000*Math.sin(2*Math.PI*440*n/24000)),n*2);
 const {data}=await encode(input,24000);const decoder=new SilkWasmDecoder();
 const f=await fixture(t,new VoiceMediaAdapter({source:syntheticPort(data),decoder}));const m=f.messages.find(m=>m.kind==='voice');
 const saved=await f.media.extract(f.contact,m.id,{requestKey:'real-codec-synthetic-resource',goal:'extract'});assert.equal(saved.latestAttempt.outcome,'full');assert.equal(saved.files.length,2);
 const playback=saved.files.find(f=>f.role==='audio_playback');const preview=await f.media.openPreview(f.contact,m.id,playback.fileId);const wav=Buffer.from(preview.dataBase64,'base64');assert.equal(inspectWav(wav).durationMs,200);assert.equal(wav.length,9644);
 const location=`${f.root}/independent-playback.wav`;await writeFile(location,wav);const result=await promisify(execFile)('/usr/bin/afinfo',[location]);assert.match(result.stdout,/24000 Hz/);assert.match(result.stdout,/1 ch/);assert.match(result.stdout,/0\.200000/);
 await f.media.releasePreview(preview.sessionId);
});

test('整帧截短与缺长度不因容器合法而通过，未知codec结果不能降低已有播放组合',async t=>{
 const silk=packets(1,1,1,1);let fail=false;const decoder={decode:async()=>{if(fail)throw Error('合成失败');return Buffer.alloc(9600);},close:async()=>{}};
 const port=syntheticPort(silk);const adapter=new VoiceMediaAdapter({source:port,decoder});const f=await fixture(t,adapter),m=f.messages.find(m=>m.kind==='voice');
 const first=await f.media.extract(f.contact,m.id,{requestKey:'voice-full-first',goal:'extract'});
 port.read=syntheticPort(silk.subarray(0,-3),{expectedBytes:silk.length}).read;
 await assert.rejects(f.media.extract(f.contact,m.id,{requestKey:'whole-packet-short',goal:'extract'}),{code:'voice_copy_incomplete'});
 port.read=async c=>({...await syntheticPort(silk).read(c),expectedBytes:undefined});await assert.rejects(f.media.extract(f.contact,m.id,{requestKey:'missing-length',goal:'extract'}),{code:'voice_copy_unproven'});
 port.read=syntheticPort(silk).read;fail=true;await assert.rejects(f.media.extract(f.contact,m.id,{requestKey:'finite-would-degrade',goal:'extract'}),{code:'media_result_would_degrade'});
 const after=await f.media.read(f.contact,m.id);assert.deepEqual(after.files.map(f=>f.fileId),first.files.map(f=>f.fileId));
});

for(const scenario of ['source','clear','unselect'])test(`本地转换在${scenario}撤销后拒绝迟到PCM，文件不复活`,async t=>{
 let convert=false,entered;const ready=new Promise(r=>{entered=r;});
 const decoder={decode:async(_silk,signal)=>{if(!convert)throw Error('合成首次暂不可解码');entered();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));return Buffer.alloc(9600);},close:async()=>{}};
 const f=await fixture(t,new VoiceMediaAdapter({source:syntheticPort(packets(1,1,1)),decoder}));const m=f.messages.find(m=>m.kind==='voice');await f.media.extract(f.contact,m.id,{requestKey:'source-before-revoke',goal:'extract'});await f.contacts.setReading(false);convert=true;
 const converting=f.media.extract(f.contact,m.id,{requestKey:'late-local',goal:'audio_conversion'});const rejected=assert.rejects(converting);await ready;
 if(scenario==='unselect') {const b=(await f.contacts.directory()).bindings.find(b=>b.contact_id===f.contact);await f.contacts.revoke(f.contact,b.binding_id,b.selection_generation);await f.media.stop(f.contact);}
 else if(scenario==='clear')await f.media.clear(f.contact,m.id,'clear-converting');
 else {const op=await f.media.deletion.plan({ownerId:f.owner,requestKey:'source-converting',scope:{kind:'source',contactId:f.contact,sourceId:m.sourceRecordIds[0]}});assert.equal((await f.media.deletion.advance(op)).state,'completed');}
 await rejected;
 const {readdir}=await import('node:fs/promises');assert.equal((await readdir(`${f.root}/managed/media`)).length,scenario==='unselect'?1:0);
 if(scenario!=='source')assert.equal((await f.media.read(f.contact,m.id)).files.some(f=>f.role==='audio_playback'),false);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('实际播放件校验失败后精确删除失败WAV，SILK与来源证明仍合法',async t=>{
 const decoder={decode:async()=>Buffer.alloc(9600),close:async()=>{}};
 const f=await fixture(t,new VoiceMediaAdapter({source:syntheticPort(packets(1,1,1)),decoder})),m=f.messages.find(m=>m.kind==='voice');
 const create=f.media.files.create.bind(f.media.files);let count=0;
 f.media.files.create=async(...args)=>{if(++count===2)args[5]=async()=>{const {StorageFailure}=await import('../src/storage/sqlite/contracts.ts');throw new StorageFailure('voice_pcm_invalid');};return create(...args);};
 const saved=await f.media.extract(f.contact,m.id,{requestKey:'failed-wav-on-disk',goal:'extract'});assert.equal(saved.latestAttempt.outcome,'limited');assert.equal(saved.latestAttempt.errorCode,'voice_pcm_invalid');assert.equal(saved.files.length,1);
 const {readdir}=await import('node:fs/promises');assert.equal((await readdir(`${f.root}/managed/media`)).length,1);
 const operations=await f.media.deletion.list({ownerId:f.owner});assert.ok(operations.some(op=>op.scope.kind==='media_result_replace'&&op.state==='completed'));
});

test('本地输入在初验后被换字节也不得进入解码或发布',async t=>{
 let calls=0;const decoder={decode:async()=>{calls++;throw Error('首轮有限结果');},close:async()=>{}};
 const adapter=new VoiceMediaAdapter({source:syntheticPort(packets(1,1,1)),decoder});const f=await fixture(t,adapter),m=f.messages.find(m=>m.kind==='voice');await f.media.extract(f.contact,m.id,{requestKey:'before-file-change',goal:'extract'});
 const execute=adapter.execute.bind(adapter);adapter.execute=async c=>{if(c.input){const {writeFile}=await import('node:fs/promises');const changed=packets(1,1,1);changed[12]=1;await writeFile(c.input.localPath,changed);}return execute(c);};
 await assert.rejects(f.media.extract(f.contact,m.id,{requestKey:'changed-local-bytes',goal:'audio_conversion'}),{code:'voice_file_changed'});assert.equal(calls,1);
});
