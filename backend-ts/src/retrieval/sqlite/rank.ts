import type {SQLInputValue} from 'node:sqlite';
import type {StorageTransaction,StorageRow} from '../../storage/sqlite/contracts.ts';
import {savedSourceScopeCTE,currentSourcePredicate} from '../../history/sqlite/current-scope.ts';
import {reciprocalRankFusion} from '../hybrid-ranking.ts';
import {buildFtsQuery,searchTokenizerFingerprint} from '../search-tokenizer.ts';
import {RETRIEVAL_MODEL_FINGERPRINT,RETRIEVAL_VECTOR_DIMENSIONS,type ReplyRetrievalRequest,type RetrievalRankResult,type RetrievalStrategy} from './contracts.ts';

interface LegalQuery {cte:string;values:SQLInputValue[]}
function legalQuery(i:ReplyRetrievalRequest):LegalQuery{
 const excluded=JSON.stringify(i.excludeIds??[]);
 const base=`d.owner_id=? AND d.kind=? AND NOT EXISTS(SELECT 1 FROM json_each(?) used WHERE used.value=d.entity_id) AND d.tokenizer_fingerprint=?`;
 if(i.scope.kind==='memory'){
  const anchors=JSON.stringify(i.scope.anchors,(_k,v)=>typeof v==='bigint'?String(v):v);
  return {cte:`frozen AS MATERIALIZED(SELECT json_extract(value,'$.id') id,json_extract(value,'$.versionNo') version_no,json_extract(value,'$.textSeal') seal FROM json_each(?)),
   eligible AS MATERIALIZED(SELECT d.id doc_id,d.entity_id,d.memory_version_no version_no,d.text_seal,d.vector_seal,d.model_fingerprint FROM retrieval_document d
    JOIN frozen f ON f.id=d.entity_id AND f.version_no=CAST(d.memory_version_no AS TEXT) AND (f.seal IS NULL OR f.seal=d.text_seal)
    JOIN memory m ON m.owner_id=d.owner_id AND m.id=d.entity_id AND m.current_version_no=d.memory_version_no
    JOIN memory_version v ON v.owner_id=m.owner_id AND v.memory_id=m.id AND v.version_no=m.current_version_no
    WHERE ${base} AND m.state='active' AND v.content_state='present' AND v.provenance_state='eligible'
     AND ((m.scope_kind='contact' AND m.contact_id=? AND d.contact_id=m.contact_id) OR(m.scope_kind='self' AND m.contact_id IS NULL AND d.contact_id IS NULL)))`,
   values:[anchors,i.ownerId,i.kind,excluded,searchTokenizerFingerprint(),i.contactId]};
 }
 return {cte:`${savedSourceScopeCTE},eligible AS MATERIALIZED(
  SELECT d.id doc_id,d.entity_id,NULL version_no,d.text_seal,d.vector_seal,d.model_fingerprint FROM retrieval_document d
  JOIN message m ON m.owner_id=d.owner_id AND m.contact_id=d.contact_id AND m.id=d.entity_id
  WHERE ${base} AND d.contact_id=? AND m.kind='text' AND m.availability='available' AND m.display_no<=?
   ${i.scope.messageIds===undefined?'':'AND m.id IN(SELECT value FROM json_each(?))'}
   AND EXISTS(SELECT 1 FROM source_proof p WHERE p.owner_id=m.owner_id AND p.contact_id=m.contact_id AND p.state='ok')
   AND NOT EXISTS(SELECT 1 FROM history_message_quarantine q WHERE q.owner_id=m.owner_id AND q.contact_id=m.contact_id AND q.message_id=m.id)
   AND EXISTS(SELECT 1 FROM capture_record r INDEXED BY capture_record_message
    JOIN sync_capture c ON c.owner_id=r.owner_id AND c.contact_id=r.contact_id AND c.id=r.capture_id
    JOIN read_goal g ON g.owner_id=c.owner_id AND g.contact_id=c.contact_id AND g.id=c.goal_id
    WHERE r.owner_id=m.owner_id AND r.contact_id=m.contact_id AND r.message_id=m.id AND m.binding_id=g.binding_id
     AND g.accepted_data_generation<=? AND r.state='normalized' AND r.availability='available' AND ${currentSourcePredicate()}))`,
  values:[i.ownerId,i.contactId,i.contactId,i.ownerId,i.kind,excluded,searchTokenizerFingerprint(),i.contactId,i.scope.displayNo,...(i.scope.messageIds===undefined?[]:[JSON.stringify(i.scope.messageIds)]),i.scope.dataGeneration]};
}

/** 只返回稳定身份；正文物化、各层预算和最终来源冻结继续由回复Module负责。 */
export function rankReplyRetrieval(tx:StorageTransaction,i:ReplyRetrievalRequest):RetrievalRankResult{
 tx.flushDerived?.();
 const vector=!!i.queryVector&&i.queryVector.length===RETRIEVAL_VECTOR_DIMENSIONS&&i.queryVector.every(Number.isFinite)&&i.queryVector.some(v=>v!==0);
 const emptyStrategy:RetrievalStrategy=vector?'hybrid':'bm25';
 if(i.kind!==i.scope.kind||!Number.isSafeInteger(i.limit)||i.limit<=0||i.limit>512||!tx.get("SELECT 1 FROM owner WHERE owner_id=? AND state='active'",[i.ownerId])
  ||!tx.get("SELECT 1 FROM contact WHERE owner_id=? AND id=? AND state='active'",[i.ownerId,i.contactId])
  ||tx.get("SELECT 1 FROM deletion_operation WHERE owner_identity=? AND state<>'completed'",[i.ownerId]))return {hits:[],strategy:emptyStrategy,indexIncomplete:false};
 const excluded=new Set(i.excludeIds??[]),qualification=new Map<string,boolean>();
 for(;;){
  i.check?.();
  const legal=legalQuery({...i,excludeIds:[...excluded]}),model=i.modelFingerprint??RETRIEVAL_MODEL_FINGERPRINT,k=Math.min(2048,Math.max(i.limit,i.limit*4));
  const fts=buildFtsQuery(i.query);
  const ctes:string[]=[],lanes:string[]=[],bindings:SQLInputValue[]=[...legal.values];
  if(fts){
   // 一次MATCH扫描后做合法ID集合准入；一元+防止FTS把IN逐ID重跑MATCH。
   ctes.push(`bm25_hits AS MATERIALIZED(SELECT retrieval_fts.rowid doc_id,bm25(retrieval_fts) lane_score,d.entity_id FROM retrieval_fts
    CROSS JOIN retrieval_document d ON d.id=retrieval_fts.rowid
    WHERE retrieval_fts MATCH ? AND +retrieval_fts.rowid IN(SELECT doc_id FROM eligible)
    ORDER BY lane_score,d.entity_id LIMIT ?)`);
   bindings.push(fts,k);lanes.push("SELECT 'bm25' lane,d.entity_id,d.memory_version_no version_no,h.lane_score FROM bm25_hits h JOIN retrieval_document d ON d.id=h.doc_id");
  }
  if(vector){
   // doc_id IN在vec0内部下推；物化KNN避免优化器为每条合法记录重复调用。
   ctes.push(`knn AS MATERIALIZED(SELECT v.doc_id,v.distance FROM retrieval_vec v WHERE v.embedding MATCH ? AND v.k=?
    AND v.doc_id IN(SELECT doc_id FROM eligible WHERE vector_seal=text_seal AND model_fingerprint=?))`);
   bindings.push(new Uint8Array(new Float32Array(i.queryVector!).buffer),k,model);
   lanes.push("SELECT 'vector' lane,d.entity_id,d.memory_version_no version_no,v.distance lane_score FROM knn v JOIN retrieval_document d ON d.id=v.doc_id");
   ctes.push('vector_missing AS MATERIALIZED(SELECT 1 FROM eligible WHERE vector_seal IS NOT text_seal OR model_fingerprint IS NOT ? LIMIT 1)');bindings.push(model);
   lanes.push("SELECT 'pending' lane,NULL entity_id,NULL version_no,0 lane_score FROM vector_missing");
  }
  // 两路与覆盖检查共享同一个合法身份集合；正文始终未进入此查询。
  const recalled=lanes.length?tx.all(`WITH ${legal.cte},${ctes.join(',')} ${lanes.join(' UNION ALL ')} ORDER BY 1,4,2`,bindings):[];
  const lexical:StorageRow[]=recalled.filter(row=>row.lane==='bm25'),dense:StorageRow[]=recalled.filter(row=>row.lane==='vector');
  // 资格规则由领域Module提供；两路前K中的无效项先排除，再重新召回，不能以固定倍数丢掉合法尾部。
  if(i.qualify){
   const rejected=new Set<string>();
   for(const row of [...lexical,...dense]){
    i.check?.();const id=String(row.entity_id),versionNo=typeof row.version_no==='bigint'?row.version_no:undefined,key=JSON.stringify([id,versionNo?.toString()]);
    if(!qualification.has(key))qualification.set(key,i.qualify({id,versionNo}));
    if(!qualification.get(key))rejected.add(id);
   }
   if(rejected.size){for(const id of rejected)excluded.add(id);continue;}
  }
  i.check?.();
  const strategy:RetrievalStrategy=lexical.length&&dense.length?'hybrid':dense.length?'vector':'bm25';
  const ranked=lexical.length&&dense.length?reciprocalRankFusion([lexical,dense],row=>String(row.entity_id),i.limit)
   :(dense.length?dense:lexical).slice(0,i.limit).map((item,index)=>({item,score:1/(60+index+1)}));
  const scoped=i.kind==='history'?' AND contact_id=?':' AND (contact_id=? OR contact_id IS NULL)';
  const textPending=!!tx.get(`SELECT 1 FROM retrieval_text_pending WHERE owner_id=? AND kind=?${scoped}
   UNION ALL SELECT 1 FROM retrieval_document WHERE owner_id=? AND kind=?${scoped} AND tokenizer_fingerprint<>? LIMIT 1`,[i.ownerId,i.kind,i.contactId,i.ownerId,i.kind,i.contactId,searchTokenizerFingerprint()]);
  const vectorPending=recalled.some(row=>row.lane==='pending');
  return {strategy,indexIncomplete:textPending||(vector&&vectorPending),hits:ranked.map(({item,score})=>({id:String(item.entity_id),
   ...(typeof item.version_no==='bigint'?{versionNo:item.version_no}:{}),score,strategy}))};
 }
}
