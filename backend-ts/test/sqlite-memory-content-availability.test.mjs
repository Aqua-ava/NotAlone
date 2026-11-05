import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mainImageQuality} from './fixtures/media/main-image-quality.mjs';
import {join} from 'node:path';
import {fixture as mediaFixture} from './media-support.mjs';
import {createBuiltinMemoryContentRegistry} from '../src/memory/content/builtins.ts';
import {MemoryContentRegistry} from '../src/memory/content/registry.ts';
import {textMemoryContent} from '../src/memory/content/text.ts';
import {currentContentAvailability,withMemoryContentRegistry} from '../src/memory/sqlite/content.ts';

function database(t){
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE message(owner_id TEXT,contact_id TEXT,id TEXT,kind TEXT,text_body TEXT,PRIMARY KEY(owner_id,contact_id,id))');
 t.after(()=>db.close());
 const queries=[];
 const statement=(sql,values=[])=>{queries.push(sql);const s=db.prepare(sql);s.setReadBigInts(true);return [s,values];};
 const tx={all(sql,values){const [s,v]=statement(sql,values);return s.all(...v);},get(sql,values){const [s,v]=statement(sql,values);return s.get(...v);},run(sql,values){db.prepare(sql).run(...(values??[]));}};
 return {db,tx,queries};
}
function insert(tx,id,text,ownerId='owner',contactId='contact',kind='text'){tx.run('INSERT INTO message VALUES(?,?,?,?,?)',[ownerId,contactId,id,kind,text]);return {owner_id:ownerId,contact_id:contactId,id,kind};}

test('调度批量文字可用性与ECMAScript trim语义一致，候选不携带正文',t=>{
 const {tx,queries}=database(t),registry=new MemoryContentRegistry();registry.register(textMemoryContent);
 const whitespace='\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
 const values=[null,'',whitespace,'合成文字',whitespace+'正文'+whitespace,'\0',whitespace+'\0'+whitespace,'\u0085','\u180e'];
 const messages=values.map((value,i)=>insert(tx,String(i),value));
 messages.push(insert(tx,'foreign','不可跨联系人','owner','other-contact'));
 messages.push(insert(tx,'foreign-owner','不可跨用户','other-owner','contact'));
 messages.push({id:'missing',kind:'text'});
 const expected=['3','4','5','6','7','8'];
 assert.deepEqual([...withMemoryContentRegistry(registry,()=>currentContentAvailability(tx,'owner','contact',messages))],expected);
 assert.equal(queries.length,1,'内置文字应一次查询返回可用ID');
 assert.ok(queries.every(sql=>!sql.includes('SELECT *')));
});

test('自定义插件未提供批量方法时仍以完整同范围消息执行原snapshot',t=>{
 const {tx}=database(t),registry=new MemoryContentRegistry();
 registry.register({id:'synthetic.file',version:'1',kinds:['file'],modelInputCost:()=>({images:0,bytes:0}),
  snapshot:(_tx,{message})=>message.text_body==='可用合成文件'&&message.marker==='candidate-only'?{revision:'1'}:null,
  prepare:async()=>{throw new Error('调度不得准备模型输入');}});
 const messages=[insert(tx,'accepted','可用合成文件','owner','contact','file'),insert(tx,'empty','','owner','contact','file'),insert(tx,'foreign','可用合成文件','owner','other-contact','file')].map(message=>({...message,marker:'candidate-only'}));
 assert.deepEqual([...registry.availability(tx,{ownerId:'owner',contactId:'contact',messages})],['accepted']);
});


test('图片批量可用性保留最新文件及逐条来源资格，混合失效不淘汰合法图片',async t=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
 const adapter={version:'synthetic-content-availability-v1',supports:kind=>kind==='image',async execute(context){
  await context.save({role:'image_display',bytes:(async function*(){yield png;})(),expectedBytes:png.length,expectedSha256:createHash('sha256').update(png).digest('hex'),
   validate:async()=>({format:'png',mimeType:'image/png',containerValid:true,viewable:true,playable:false,...mainImageQuality(png)})});
  return {association:{protocol:'media-association-v1',profileId:'synthetic-content-availability-v1',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-image'}};
 }};
 const f=await mediaFixture(t,adapter);
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:Array.from({length:6},(_,i)=>({partition:'a',table:'one',localId:String(10+i),serverId:'0',sender:'contact',kind:'image',text:null,originalType:'image',sentAt:null,timePrecision:null,orderScheme:null,orderKey:null,stateAssurance:'verified'})),completedPartitions:['a'],exhausted:true});
 await f.history.synchronize(f.contact);
 const images=(await f.history.read(f.contact)).messages.filter(message=>message.kind==='image'&&!f.messages.some(original=>original.id===message.id));
 for(const [i,message]of images.entries())if(i<5)await f.media.extract(f.contact,message.id,{requestKey:`availability-${i}`,goal:'extract'});
 await f.media.extract(f.contact,images[0].id,{requestKey:'availability-replacement',goal:'extract'});
 const otherContact=f.saved[1].contact_id;await f.history.synchronize(otherContact);
 const foreign=(await f.history.read(otherContact)).messages.find(message=>message.kind==='image');
 const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'));t.after(()=>db.close());
 db.prepare("UPDATE message_media SET state='cleared' WHERE owner_id=? AND message_id=?").run(f.owner,images[1].id);
 db.prepare("UPDATE capture_record SET availability='deleting' WHERE owner_id=? AND id=(SELECT a.record_id FROM media_file f JOIN media_extraction_attempt a ON a.owner_id=f.owner_id AND a.id=f.produced_attempt_id WHERE f.owner_id=? AND f.message_id=? AND f.publish_state='current')").run(f.owner,f.owner,images[2].id);
 db.prepare("UPDATE media_file SET mime_type='application/octet-stream' WHERE owner_id=? AND message_id=? AND publish_state='current'").run(f.owner,images[3].id);
 db.prepare("UPDATE media_file SET byte_size=? WHERE owner_id=? AND message_id=? AND publish_state='current'").run(9007199254740993n,f.owner,images[4].id);
 const queries=[],statement=(sql,values=[])=>{queries.push(sql);const s=db.prepare(sql);s.setReadBigInts(true);return [s,values];};
 const tx={get(sql,values){const [s,v]=statement(sql,values);return s.get(...v);},all(sql,values){const [s,v]=statement(sql,values);return s.all(...v);},run(){throw new Error('只读资格检查不得写入');}};
 const messages=[...images,foreign].map(message=>({id:message.id,kind:message.kind})),registry=createBuiltinMemoryContentRegistry();
 assert.deepEqual([...registry.availability(tx,{ownerId:f.owner,contactId:f.contact,messages})],[images[0].id]);
 assert.ok(queries.length<=4,`图片批量判定不得逐图查表或来源：执行了${queries.length}次SQL`);
 const snapshots=messages.filter(message=>registry.snapshot(tx,{ownerId:f.owner,contactId:f.contact,message})!==null).map(message=>message.id);
 assert.deepEqual(snapshots,[images[0].id]);
});
