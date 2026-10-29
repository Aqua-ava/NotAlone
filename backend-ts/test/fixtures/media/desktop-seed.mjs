// 实际开发App的隔离合成资料。仅以业务服务准备；不认证真实渠道或类型适配器。
import {fixture} from '../../media-support.mjs';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const wav=Buffer.alloc(44+1600);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(1600,40);
const adapter={version:'synthetic-desktop-media-v1',supports:kind=>kind==='image'||kind==='voice',execute:async context=>{
 const save=async(role,bytes,parentFileId)=>context.save({role,parentFileId,expectedBytes:bytes.length,expectedSha256:createHash('sha256').update(bytes).digest('hex'),bytes:(async function*(){yield bytes;})(),validate:async()=>({format:role==='image_display'?'png':role==='audio_source'?'synthetic-silk':'wav',mimeType:role==='image_display'?'image/png':role==='audio_source'?'audio/silk':'audio/wav',containerValid:true,viewable:role==='image_display',playable:role==='audio_playback',imageQuality:role==='image_display'?'thumbnail':'not_applicable',qualityProof:null})});
 if(context.kind==='image')await save('image_display',png);else{const source=await save('audio_source',Buffer.from('synthetic-not-real-silk'));await save('audio_playback',wav,source.fileId);}
 return {association:{protocol:'media-association-v1',profileId:'synthetic-desktop-media-v1',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:`synthetic-${context.kind}`}};
}};
const f=await fixture({after(){}},adapter);const second=f.saved[1].contact_id;await f.history.synchronize(second);
const image=f.messages.find(m=>m.kind==='image'),voice=f.messages.find(m=>m.kind==='voice');
const savedImage=await f.media.extract(f.contact,image.id,{requestKey:'desktop-seed-image',goal:'extract'});const savedVoice=await f.media.extract(f.contact,voice.id,{requestKey:'desktop-seed-voice',goal:'extract'});
await f.contacts.setReading(false);const databaseId=f.storage.status.databaseId;
await f.media.close();await f.history.close();await f.contacts.close();await f.storage.close();
const project=path.resolve(new URL('../../../../',import.meta.url).pathname);
await writeFile(path.join(f.root,'backend-launch.json'),JSON.stringify({projectDirectory:project,envFilePath:path.join(f.root,'unused.env'),backendInfoPath:path.join(f.root,'managed/sqlite-backend.info')}),{mode:0o600});
await writeFile(path.join(f.root,'sqlite-development.json'),JSON.stringify({formatVersion:1,intent:'open',role:'test',expectedDatabaseId:databaseId,capabilities:['contacts','history']}),{mode:0o600});
await writeFile(path.join(f.root,'unused.env'),'# 隔离合成资料，不设置模型或真实渠道\n',{mode:0o600});
const evidence={root:f.root,databaseId,ownerId:f.owner,contactId:f.contact,secondContactId:second,imageId:image.id,voiceId:voice.id,imageSource:image.sourceRecordIds[0],voiceSource:voice.sourceRecordIds[0],imageFiles:savedImage.files,voiceFiles:savedVoice.files};
await writeFile(path.join(f.root,'media-acceptance.json'),JSON.stringify(evidence),{mode:0o600});console.log(JSON.stringify({root:f.root,databaseId,readEnabled:false,files:savedImage.files.length+savedVoice.files.length}));
