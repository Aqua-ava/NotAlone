import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {fixture} from './media-support.mjs';
import {mediaMigration,mediaImageQualityEvidenceMigration} from '../src/media/sqlite/schema.ts';
import {registry} from '../src/storage/sqlite/registry.ts';

// ADR-170：原图／缩略图分类列因已发布迁移保留，但不再写入也不再读取。
const bytes=Buffer.from('synthetic saved image content');
const digest=createHash('sha256').update(bytes).digest('hex');
function adapter(){
 return {version:'synthetic-no-quality-v1',supports:kind=>kind==='image',async execute(context){
  await context.save({role:'image_display',expectedBytes:bytes.length,expectedSha256:digest,
   bytes:(async function*(){yield bytes;})(),validate:async()=>({format:'synthetic',mimeType:'image/png',containerValid:true,viewable:true,playable:false})});
  return {association:{protocol:'media-association-v1',profileId:'synthetic-no-quality-v1',recordId:context.source.recordId,
   messageId:context.messageId,resourceIdentity:'synthetic-fixed-image'}};
 }};
}
function stored(f){const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'),{readOnly:true});
 try{return db.prepare('SELECT image_quality,image_quality_evidence,quality_proof,content_digest FROM media_file WHERE owner_id=?').all(f.owner);}finally{db.close();}}

test('新保存的图片只写占位分类，不写原图证明或来源分类依据，快照也不暴露分类',async t=>{
 const f=await fixture(t,adapter()),message=f.messages.find(m=>m.kind==='image');
 const snapshot=await f.media.extract(f.contact,message.id,{requestKey:'save-without-quality',goal:'extract'});
 assert.equal(snapshot.latestAttempt.outcome,'full');assert.equal(snapshot.files.length,1);
 assert.equal('imageQuality' in snapshot.files[0],false);assert.equal('originalUpgrade' in snapshot.capabilities,false);
 assert.deepEqual(stored(f).map(row=>({...row})),[{image_quality:'unknown',image_quality_evidence:null,quality_proof:null,content_digest:digest}]);
});

test('清除图片时文件行与受管副本一并清除',async t=>{
 const f=await fixture(t,adapter()),message=f.messages.find(m=>m.kind==='image');
 await f.media.extract(f.contact,message.id,{requestKey:'save-before-clear',goal:'extract'});
 await f.media.clear(f.contact,message.id,'clear-saved-image');
 assert.deepEqual(stored(f),[]);
});

test('第31版只追加可空依据列，已有原图记录和证明保留且不会伪造新分类',()=>{
 assert.equal(registry.migrations.find(m=>m.version===31)?.sql,mediaImageQualityEvidenceMigration(31).sql);
 const db=new DatabaseSync(':memory:');
 try{
  // 独立迁移夹具只建媒体表，关系闭包由正常存储服务用例验证。
  db.exec('PRAGMA foreign_keys=OFF');
  db.exec(mediaMigration(6).sql);
  db.prepare("INSERT INTO media_file(owner_id,id,contact_id,message_id,produced_attempt_id,role,image_quality,quality_proof,content_state,publish_state,created_at) VALUES('owner','file','contact','message','attempt','image_display','original','legacy-original-proof','present','staged',0)").run();
  db.exec(mediaImageQualityEvidenceMigration(31).sql);
  const row=db.prepare('SELECT image_quality,quality_proof,image_quality_evidence FROM media_file').get();
  assert.deepEqual({...row},{image_quality:'original',quality_proof:'legacy-original-proof',image_quality_evidence:null});
  assert.throws(()=>db.prepare("UPDATE media_file SET image_quality_evidence='not json'").run());
 }finally{db.close();}
});
