import type {ErasurePorts} from '../../preferences/preference-erasure.ts';
import type {Client} from 'pg';
import {randomUUID} from 'node:crypto';
import {captureSnapshot,sha} from '../overview/contact-overview-evidence.ts';
import {mutateMemoryCandidate} from './memory-mutations-candidate.ts';
import {MemoryError} from './memory-errors.ts';
import type {MemoryScope,MemoryRow} from './memory-read.ts';
export function manualEntry(body:unknown):{text:string;category:string;topic:string} {
  if(!body||typeof body!=='object'||Array.isArray(body))throw new MemoryError();
  const row=body as MemoryRow;
  if(typeof row.text!=='string'||!row.text.trim()||!['common_fact','preference','taboo','recent_state','relationship_note'].includes(row.category)
    ||!['health','work','family','travel','finance','study','emotion','other'].includes(row.topic??'other'))throw new MemoryError();
  return {text:row.text,category:row.category,topic:row.topic??'other'};
}
/** 手录来源和候选保留原结构；不额外产生模型请求。 */
export async function createManualMemory(client:Client,owner:string,scope:MemoryScope,body:unknown,erasurePorts?:Partial<ErasurePorts>):Promise<MemoryRow> {
  const entry=manualEntry(body),id=randomUUID();
  if(scope.level==='owner'&&!scope.contactId) {
    return (await client.query(`INSERT INTO public.owner_memory(id,owner_id,text_content,category,topic,source_ids,adoption_method)
      VALUES($1,$2,$3,$4,$5,$6,'manual') RETURNING to_jsonb(owner_memory) AS value`,[id,owner,entry.text,entry.category,entry.topic,[owner]])).rows[0].value;
  }
  const contact=scope.contactId!;
  const digest=sha(entry.text);
  let source=(await client.query(`INSERT INTO public.source_document(owner_id,contact_id,source_type,file_name,content_sha256,record_count)
    VALUES($1,$2,'manual',$3,$4,1) ON CONFLICT(owner_id,contact_id,content_sha256) DO NOTHING RETURNING id`,[owner,contact,`manual-${id}.jsonl`,digest])).rows[0];
  source??=(await client.query('SELECT id FROM public.source_document WHERE owner_id=$1 AND contact_id=$2 AND content_sha256=$3',[owner,contact,digest])).rows[0];
  if(!source)throw new MemoryError('memory_operation_failed',500);
  const evidence={...await captureSnapshot(client,owner,[],[source.id],contact),direct_message_ids:[],manual_entry:true};
  await client.query(`INSERT INTO public.memory_candidate(id,owner_id,contact_id,text_content,category,topic,subject,source_ids,correction_evidence)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,owner,contact,entry.text,entry.category,entry.topic,scope.level==='owner'?'self':'contact',[source.id],evidence]);
  return mutateMemoryCandidate(client,owner,contact,'confirm',id,{},{erasurePorts});
}
