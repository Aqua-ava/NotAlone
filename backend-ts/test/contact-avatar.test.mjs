import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteContactService} from '../src/contacts/sqlite/service.ts';
import {fetchContactAvatar} from '../src/contacts/sqlite/avatar.ts';

const owner='00000000-0000-4000-8000-000000000001';
const evidence={externalKey:'synthetic-account',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-metadata-v1'};
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-avatar-')));
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test'});
 const calls=[];
 const metadata={account:async()=>evidence,sessions:async()=>['friend-a','friend-b'].map(externalKey=>({externalKey,displayName:'同名',kind:'private',identityAssurance:'verified'})),
  avatarUrl:async(_account,key)=>{calls.push(key);return `https://wx.qlogo.cn/synthetic/${key}`;}};
 const service=new SqliteContactService(storage,owner,metadata);
 t.after(async()=>{await service.close();await storage.close();await rm(root,{recursive:true,force:true});});
 await service.initialize();const candidate=await service.detectAccount();await service.confirmAccount(candidate.candidate_token);
 const snapshot=await service.candidates(true);
 await service.confirm(snapshot.snapshot_token,snapshot.sessions.map(row=>({locator:row.username,observed_display_name:row.display_name,expected_selection_generation:row.selection_generation})));
 await service.setReading(true);
 const directory=await service.directory();
 return {service,storage,metadata,calls,directory};
}

test('头像按稳定绑定区分同名联系人，停读和其他 owner 不读取来源',async t=>{
 const {service,storage,metadata,calls,directory}=await fixture(t);
 const loaded=[];const image={mime_type:'image/png',base64:'synthetic'};
 for(const binding of directory.bindings){assert.deepEqual(await service.avatar(binding.contact_id,undefined,async address=>{loaded.push(address);return image;}),image);}
 assert.deepEqual(calls.sort(),['friend-a','friend-b']);assert.equal(new Set(loaded).size,2);
 const foreign=new SqliteContactService(storage,'00000000-0000-4000-8000-000000000002',metadata);
 assert.equal(await foreign.avatar(directory.contacts[0].contact_id),null);
 await service.setReading(false);
 assert.equal(await service.avatar(directory.contacts[0].contact_id),null);
 assert.equal(calls.length,2);
});

test('头像不请求全目录统计，专用范围查询继续复验 owner 与完整读取令牌',async t=>{
 const {service,storage,directory}=await fixture(t);
 const execute=storage.execute.bind(storage),actions=[];
 storage.execute=async(name,input)=>{
  actions.push(name);
  if(name==='identity.directory')throw new Error('头像不得触发全目录消息统计');
  return execute(name,input);
 };
 const binding=directory.bindings[0],image={mime_type:'image/png',base64:'synthetic'};
 assert.deepEqual(await service.avatar(binding.contact_id,undefined,async()=>image),image);
 assert.equal(actions.includes('identity.directory'),false);
 const token=await service.eligibility(binding.contact_id);
 const read=overrides=>storage.execute('identity.avatarScope',{ownerId:owner,token:{...token,...overrides}});
 assert.deepEqual(await read({}),{accountKey:evidence.externalKey,identityScheme:evidence.identityScheme,sourceGeneration:evidence.sourceGeneration,conversationKey:binding.conversation_locator});
 await assert.rejects(storage.execute('identity.avatarScope',{ownerId:'00000000-0000-4000-8000-000000000002',token}),{code:'read_not_authorized'});
 for(const key of ['account_id','conversation_id','binding_id','grant_id','selection_generation','data_generation','scope_revision']){
  await assert.rejects(read({[key]:key.endsWith('_id')?'00000000-0000-4000-8000-000000000099':'999'}),{code:'read_eligibility_stale'});
 }
 await service.setReading(false);
 await assert.rejects(read({}),{code:'read_not_authorized'});
});

test('头像来源变代不发网络请求；下载期间撤销拒绝迟到结果',async t=>{
 const {service,metadata,directory}=await fixture(t);
 const binding=directory.bindings[0];let loaded=0;
 metadata.account=async()=>({...evidence,sourceGeneration:'source-other'});
 assert.equal(await service.avatar(binding.contact_id,undefined,async()=>{loaded++;return null;}),null);assert.equal(loaded,0);
 metadata.account=async()=>evidence;
 let release,started;
 const ready=new Promise(resolve=>{started=resolve;});
 let requestSignal;
 const pending=service.avatar(binding.contact_id,undefined,async(_url,signal)=>{requestSignal=signal;started();return new Promise(resolve=>{release=resolve;});});
 await ready;await service.revoke(binding.contact_id,binding.binding_id,binding.selection_generation);
 assert.equal(requestSignal.aborted,true);release({mime_type:'image/png',base64:'late'});
 assert.equal(await pending,null);
});

test('关闭服务取消头像，等待在途读取结算',async t=>{
 const {service,metadata,directory}=await fixture(t);let started,release,signal;
 const ready=new Promise(resolve=>{started=resolve;});
 metadata.avatarUrl=async(_account,_key,currentSignal)=>{signal=currentSignal;started();return new Promise(resolve=>{release=resolve;});};
 const pending=service.avatar(directory.contacts[0].contact_id);await ready;
 let closed=false;const closing=service.close().then(()=>{closed=true;});
 assert.equal(signal.aborted,true);assert.equal(closed,false);release(null);
 await closing;assert.equal(await pending,null);
});

test('头像下载仅限 HTTPS 微信 CDN，拒绝凭据、重定向、超限和非位图',async()=>{
 const signal=new AbortController().signal;let calls=0;
 const request=async(_url,options)=>{calls++;assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');return new Response('<svg/>');};
 for(const address of ['http://wx.qlogo.cn/a','https://wx.qlogo.cn.attacker.example/a','https://user:password@wx.qlogo.cn/a','https://127.0.0.1/a','https://wx.qlogo.cn:444/a','file:///tmp/avatar'])assert.equal(await fetchContactAvatar(address,signal,request),null);
 assert.equal(calls,0);
 assert.equal(await fetchContactAvatar('https://wx.qlogo.cn/a',signal,request),null);
 assert.equal(await fetchContactAvatar('https://wx.qlogo.cn/a',signal,async()=>new Response(new Uint8Array(262145))),null);
 assert.equal(await fetchContactAvatar('https://wx.qlogo.cn/a',signal,async()=>new Response(null,{status:302,headers:{location:'https://other.example/a'}})),null);
});

test('真实位图解码为无附加元数据的 96 像素 PNG',async()=>{
 const input=await sharp({create:{width:150,height:120,channels:3,background:'#527b8c'}}).jpeg().toBuffer();
 const result=await fetchContactAvatar('https://thirdwx.qlogo.cn/a',new AbortController().signal,async()=>new Response(input));
 assert.equal(result.mime_type,'image/png');
 const info=await sharp(Buffer.from(result.base64,'base64')).metadata();
 assert.equal(info.format,'png');assert.equal(info.width,96);assert.equal(info.height,96);assert.equal(info.exif,undefined);
});
