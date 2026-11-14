import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import sharp from 'sharp';
import {DatabaseSync} from 'node:sqlite';
import {MemoryContentRegistry} from '../src/memory/content/registry.ts';
import {textMemoryContent} from '../src/memory/content/text.ts';
import {imageMemoryContent} from '../src/memory/content/image.ts';
import {matchesContentEvidence,sourceImageReference} from '../src/memory/content/evidence.ts';
import {withMemoryContentRegistry} from '../src/memory/sqlite/content.ts';
import {citationFromEvidence,resolveContentCitation} from '../src/memory/sqlite/content-citation.ts';

const tx={};
const scope=(kind,extra={})=>({ownerId:randomUUID(),contactId:randomUUID(),message:{id:randomUUID(),kind,sender_role:'contact',sent_at:null,text_body:null,...extra}});
const digest=text=>createHash('sha256').update(text).digest('hex');
const fileContent={
 id:'synthetic.raw-file',version:'1',kinds:['file'],modelInputCost:()=>({images:0,bytes:0}),
 snapshot:(_tx,{message})=>({text:message.original,sha256:digest(message.original)}),
 evidence:(_tx,{frozen})=>({representation:'text',text:frozen.identity.text}),
 async prepare({message,frozen}){return {message:{message_id:String(message.id),sender:'contact',occurred_at:null,text:String(frozen.identity.text),content_kind:'file'}};},
};

test('第三种内容的真实原文通过同一接口生成引用，正文为空仍可定位并拒绝替换后的来源',()=>{
 const registry=new MemoryContentRegistry();registry.register(fileContent);
 const s=scope('file',{original:'我每周三去合成读书会。'}),frozen=registry.snapshot(tx,s);
 const citation=registry.citation(tx,s,frozen,{message_id:s.message.id,quote:'每周三去合成读书会',description:undefined});
 assert.equal(citation.contentKind,'file');assert.equal(citation.spanStart,null);
 assert.equal(citation.contentRef.frozen.pluginId,fileContent.id);
 const source=registry.source(tx,s,citation);
 assert.equal(source.text,'每周三去合成读书会');assert.equal(source.content_kind,'file');
 assert.equal(matchesContentEvidence({message_id:s.message.id,quote:'合成读书会'},[source]),true);
 assert.equal(matchesContentEvidence({message_id:s.message.id,quote:'从未出现的文字'},[source]),false);
 assert.throws(()=>registry.source(tx,{...s,message:{...s.message,original:'替换后的其他文件。'}},citation),{code:'memory_content_source_stale'});
});

test('文字引用保持旧字符区间，图片描述不能被作为文字引用签证',()=>{
 const registry=new MemoryContentRegistry();registry.register(textMemoryContent);
 const s=scope('text',{text_body:'🙂我每周去读书会。'}),frozen=registry.snapshot(tx,s);
 const citation=registry.citation(tx,s,frozen,{message_id:s.message.id,quote:'我每周去读书会'});
 assert.equal(citation.contentKind,'text');assert.equal(citation.contentRef,null);
 assert.equal(citation.spanStart,1n);assert.equal(citation.spanEnd,8n);
 const source=registry.source(tx,s,citation);assert.equal(source.text,'我每周去读书会');
 assert.equal(matchesContentEvidence({message_id:s.message.id,quote:null,description:'描述这个文字消息'},[source]),false);
 assert.throws(()=>registry.citation(tx,s,frozen,{message_id:randomUUID(),quote:'读书会'}),{code:'memory_source_stale'});
 const duplicate=scope('text',{text_body:'重复，重复'});
 assert.throws(()=>registry.citation(tx,duplicate,registry.snapshot(tx,duplicate),{message_id:duplicate.message.id,quote:'重复'}),{code:'memory_source_stale'});
});

test('图片引用沿用旧形状，视觉来源必须有描述且准备真实图片字节',async()=>{
 const bytes=await sharp({create:{width:2,height:2,channels:3,background:'#33aa66'}}).png().toBuffer();
 const identity={fileId:randomUUID(),sha256:digest(bytes),mediaGeneration:'2',mimeType:'image/png',byteSize:bytes.length};
 const registry=new MemoryContentRegistry();registry.register({...imageMemoryContent,snapshot:()=>identity});
 const s=scope('image'),frozen=registry.snapshot(tx,s),citation=registry.citation(tx,s,frozen,{message_id:s.message.id,quote:null,description:'合成绿色方块。'});
 assert.deepEqual(citation.contentRef,{file_id:identity.fileId,sha256:identity.sha256,mime_type:'image/png',media_generation:'2'});
 const source=registry.source(tx,s,citation);assert.equal(source.text,null);
 assert.deepEqual(sourceImageReference(source),citation.contentRef);
 assert.equal(matchesContentEvidence({message_id:s.message.id,quote:null,description:'图中是绿色。'},[source]),true);
 assert.equal(matchesContentEvidence({message_id:s.message.id,quote:'合成绿色方块。'},[source]),false);
 assert.equal(matchesContentEvidence({message_id:s.message.id,quote:null},[source]),false);
 const prepared=await registry.prepareCitation({...s,frozen,citation,resources:{readImage:async()=>({mimeType:'image/png',dataBase64:bytes.toString('base64')})},signal:new AbortController().signal,requireCurrent:async()=>{}});
 assert.equal(prepared.images[0].sourceSha256,identity.sha256);
 assert.equal(prepared.message.image.file_id,identity.fileId);
 assert.throws(()=>registry.source(tx,s,{...citation,contentRef:{...citation.contentRef,sha256:'0'.repeat(64)}}),{code:'memory_content_source_stale'});
});

test('另一视觉来源类型复用图片输入与证据，无需在主流程识别原生类型',()=>{
 const identity={fileId:randomUUID(),sha256:'a'.repeat(64),mediaGeneration:'1',mimeType:'image/png',byteSize:30};
 const registry=new MemoryContentRegistry();registry.register({...imageMemoryContent,id:'synthetic.visual',kinds:['sticker'],snapshot:()=>identity});
 const s=scope('sticker'),frozen=registry.snapshot(tx,s),citation=registry.citation(tx,s,frozen,{message_id:s.message.id,quote:null,description:'合成表情的可见内容。'});
 assert.equal(citation.contentKind,'sticker');assert.equal(citation.contentRef.representation,'image');
 const source=registry.source(tx,s,citation);
 assert.equal(source.content_kind,'sticker');assert.deepEqual(sourceImageReference(source),{file_id:identity.fileId,sha256:identity.sha256,mime_type:'image/png',media_generation:'1'});
 assert.equal(matchesContentEvidence({message_id:s.message.id,quote:null,description:'合成表情的可见内容。'},[source]),true);
 assert.throws(()=>sourceImageReference({message_id:s.message.id,text:null,occurred_at:null}),{code:'memory_source_stale'});
});

test('不支持证据表示的旧插件不能仅凭模型说明生成引用',()=>{
 const registry=new MemoryContentRegistry();const {evidence,...legacy}=fileContent;registry.register(legacy);
 const s=scope('file',{original:'我每周三去合成读书会。'}),frozen=registry.snapshot(tx,s);
 assert.throws(()=>registry.citation(tx,s,frozen,{message_id:s.message.id,quote:'读书会'}),{code:'memory_content_evidence_unavailable'});
});

test('SQLite桥读取真实固定来源，第三类型引用可消费且不能跨联系人复制',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec(`CREATE TABLE message(owner_id TEXT,contact_id TEXT,id TEXT,kind TEXT,text_body TEXT,original TEXT,sender_role TEXT,sent_at INTEGER);
   CREATE TABLE run_content_input(owner_id TEXT,run_id TEXT,input_no INTEGER,plugin_id TEXT,plugin_version TEXT,content_kind TEXT,identity_json TEXT);`);
  const storage={get(sql,values=[]){const statement=db.prepare(sql);statement.setReadBigInts(true);return statement.get(...values);}};
  const registry=new MemoryContentRegistry();registry.register(fileContent);
  const s=scope('file',{original:'我每周三去合成读书会。'}),runId=randomUUID(),frozen=registry.snapshot(storage,s);
  db.prepare('INSERT INTO message VALUES(?,?,?,?,?,?,?,?)').run(s.ownerId,s.contactId,s.message.id,'file',null,s.message.original,'contact',null);
  db.prepare('INSERT INTO run_content_input VALUES(?,?,?,?,?,?,?)').run(s.ownerId,runId,0,fileContent.id,fileContent.version,'file',JSON.stringify(frozen.identity));
  withMemoryContentRegistry(registry,()=>{
   const citation=citationFromEvidence(storage,s.ownerId,{run_id:runId,input_no:0n,source_contact_id:s.contactId,message_id:s.message.id},{message_id:s.message.id,quote:'每周三去合成读书会'});
   const row={source_contact_id:s.contactId,message_id:s.message.id,content_kind:citation.contentKind,content_ref_json:JSON.stringify(citation.contentRef),span_start:citation.spanStart,span_end:citation.spanEnd,explanation:citation.explanation};
   const resolved=resolveContentCitation(storage,s.ownerId,row);
   assert.equal(resolved.source.text,'每周三去合成读书会');assert.deepEqual(resolved.frozen,frozen);
   const other=randomUUID();db.prepare('INSERT INTO message VALUES(?,?,?,?,?,?,?,?)').run(s.ownerId,other,s.message.id,'file',null,s.message.original,'contact',null);
   assert.throws(()=>resolveContentCitation(storage,s.ownerId,{...row,source_contact_id:other}),{code:'memory_content_source_stale'});
   db.prepare('DELETE FROM message WHERE owner_id=? AND contact_id=?').run(s.ownerId,s.contactId);
   assert.throws(()=>resolveContentCitation(storage,s.ownerId,row),{code:'memory_source_stale'});
  });
 }finally{db.close();}
});
