import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {fixture} from './media-support.mjs';
import {mediaMigration,mediaImageQualityEvidenceMigration} from '../src/media/sqlite/schema.ts';
import {registry} from '../src/storage/sqlite/registry.ts';

// 同一份合成字节用于全部来源类别；分类不能随尺寸或文件大小变化。
const bytes=Buffer.from('synthetic same-size image content');
const digest=createHash('sha256').update(bytes).digest('hex');
function evidence(quality='thumbnail'){
 return {protocol:'wechat-image-quality-v1',quality,sourceVariant:quality==='thumbnail'?'thumbnail':'main',resourceInfoId:'9',
  resources:[{resourceId:'10',resourceTypeRaw:65537},{resourceId:'12',resourceTypeRaw:131073}],
  sourceSha256:digest,contentSha256:digest,originalProofDigest:quality==='original'?'a'.repeat(64):null};
}
function adapter(quality='thumbnail',proof=evidence(quality)){
 return {version:'synthetic-quality-evidence-v1',supports:kind=>kind==='image',async execute(context){
  await context.save({role:'image_display',expectedBytes:bytes.length,expectedSha256:digest,
   bytes:(async function*(){yield bytes;})(),validate:async()=>({format:'synthetic',mimeType:'image/png',containerValid:true,
    viewable:true,playable:false,imageQuality:quality,qualityProof:quality==='original'?'synthetic-original-proof':null,
    ...(proof==null?{}:{imageQualityEvidence:proof})})});
  return {association:{protocol:'media-association-v1',profileId:'synthetic-quality-evidence-v1',recordId:context.source.recordId,
   messageId:context.messageId,resourceIdentity:'synthetic-fixed-image'}};
 }};
}
function stored(f){const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'),{readOnly:true});
 try{return db.prepare('SELECT image_quality,image_quality_evidence,quality_proof,content_digest FROM media_file WHERE owner_id=? AND publish_state=\'current\'').all(f.owner);}finally{db.close();}}

test('相同字节的图片按已核验来源分类并持久化依据，不向展示快照暴露资源身份',async t=>{
 for(const quality of ['original','thumbnail','unknown'])await t.test(quality,async t=>{
  const proof=evidence(quality),f=await fixture(t,adapter(quality,proof)),message=f.messages.find(m=>m.kind==='image');
  const snapshot=await f.media.extract(f.contact,message.id,{requestKey:'same-content-source-quality',goal:'extract'});
  assert.equal(snapshot.files[0].imageQuality,quality);
  const summary=(await f.history.imageMedia(f.contact,[message.id])).get(message.id);
  assert.equal(summary.imageVariant,quality==='thumbnail'?'thumbnail':'main');
  assert.equal(summary.imageQuality,quality);
  assert.equal(JSON.stringify(summary).includes('resourceInfoId'),false);
  const rows=stored(f);assert.equal(rows.length,1);assert.deepEqual(JSON.parse(rows[0].image_quality_evidence),proof);
  assert.equal(rows[0].content_digest,digest);assert.equal(JSON.stringify(snapshot).includes('resourceInfoId'),false);
 });
});

test('旧未知图片没有来源角色依据时不猜测为主图',async t=>{
 const f=await fixture(t,adapter('unknown',null)),message=f.messages.find(m=>m.kind==='image');
 await f.media.extract(f.contact,message.id,{requestKey:'legacy-unknown-role',goal:'extract'});
 const summary=(await f.history.imageMedia(f.contact,[message.id])).get(message.id);
 assert.equal(summary.imageVariant,'unknown');
 assert.equal(summary.imageQuality,'unknown');
});

test('拒绝与保存内容或分类不一致、越界及夹带额外字段的图片来源依据',async t=>{
 const invalid=[
  {name:'wrong digest',patch:{contentSha256:'b'.repeat(64)}},
  {name:'wrong quality',patch:{quality:'unknown'}},
  {name:'wrong variant',patch:{sourceVariant:'main'}},
  {name:'thumbnail with original proof',patch:{originalProofDigest:'a'.repeat(64)}},
  {name:'extra private field',patch:{path:'/synthetic/private'}},
  {name:'bad source digest',patch:{sourceSha256:'bad'}},
  {name:'empty resources',patch:{resources:[]}},
  {name:'too many resources',patch:{resources:Array.from({length:33},(_,index)=>({resourceId:String(index+1),resourceTypeRaw:1}))}},
  {name:'unsorted resources',patch:{resources:[{resourceId:'12',resourceTypeRaw:1},{resourceId:'10',resourceTypeRaw:1}]}},
  {name:'duplicate resources',patch:{resources:[{resourceId:'10',resourceTypeRaw:1},{resourceId:'10',resourceTypeRaw:1}]}},
  {name:'wrong resource kind',patch:{resources:[{resourceId:'10',resourceTypeRaw:65538}]}},
  {name:'unsafe raw type',patch:{resources:[{resourceId:'10',resourceTypeRaw:Number.MAX_SAFE_INTEGER+1}]}},
  {name:'extra resource field',patch:{resources:[{resourceId:'10',resourceTypeRaw:1,url:'https://example.invalid'}]}},
  {name:'zero resource identity',patch:{resourceInfoId:'0'}},
  {name:'oversized identity',patch:{resourceInfoId:'9'.repeat(100)}},
 ];
 for(const {name,patch} of invalid)await t.test(name,async t=>{
  const f=await fixture(t,adapter('thumbnail',{...evidence(),...patch})),message=f.messages.find(m=>m.kind==='image');
  await assert.rejects(f.media.extract(f.contact,message.id,{requestKey:'invalid-source-quality',goal:'extract'}),{code:'media_validation_invalid'});
  assert.deepEqual(stored(f),[]);
 });
});

test('main 来源没有原图证明不能标为原图，有原图证明也不能降格为未知',async t=>{
 for(const quality of ['original','unknown'])await t.test(quality,async t=>{
  const proof=evidence(quality);proof.originalProofDigest=quality==='original'?null:'a'.repeat(64);
  const f=await fixture(t,adapter(quality,proof)),message=f.messages.find(m=>m.kind==='image');
  await assert.rejects(f.media.extract(f.contact,message.id,{requestKey:'mismatched-original-proof',goal:'extract'}),{code:'media_validation_invalid'});
 });
});

test('清除图片时同时清除来源分类依据及文件引用',async t=>{
 const f=await fixture(t,adapter()),message=f.messages.find(m=>m.kind==='image');
 await f.media.extract(f.contact,message.id,{requestKey:'save-quality-before-clear',goal:'extract'});
 assert.ok(stored(f)[0].image_quality_evidence);
 await f.media.clear(f.contact,message.id,'clear-quality-evidence');
 const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'),{readOnly:true});
 try{assert.equal(db.prepare('SELECT count(*) AS n FROM media_file WHERE owner_id=?').get(f.owner).n,0);}finally{db.close();}
});

test('第31版只追加可空依据列，已有原图记录和证明保留且不会伪造新分类',()=>{
 assert.equal(registry.migrations.at(-1).version,31);
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
