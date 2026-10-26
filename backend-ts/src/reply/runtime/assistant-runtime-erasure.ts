/** 删除事务递归经过记忆、策略及回复闭包时，保持同一个持久删除操作身份。 */
import {AsyncLocalStorage} from 'node:async_hooks';
import type {Client} from 'pg';
const operation=new AsyncLocalStorage<string>();
export function withAssistantRuntimeErasure<T>(id:string,work:()=>Promise<T>):Promise<T>{return operation.run(id,work);}
export async function captureAssistantRuntimeScope(client:Client,id:string,owner:string,contact:string|null=null,session:string|null=null):Promise<void>{
 await client.query(`INSERT INTO assistant_runtime_deletion_target(operation_id,owner_id,contact_id,session_id)
  SELECT $1,owner_id,contact_id,id FROM assistant_session WHERE owner_id=$2 AND ($3::uuid IS NULL OR contact_id=$3) AND ($4::uuid IS NULL OR id=$4)
  ON CONFLICT DO NOTHING`,[id,owner,contact,session]);
 await client.query(`UPDATE assistant_runtime_session runtime SET state='blocked' FROM assistant_runtime_deletion_target target
  WHERE target.operation_id=$1 AND target.owner_id=runtime.owner_id AND target.contact_id=runtime.contact_id AND target.session_id=runtime.session_id`,[id]);
}
export async function captureAssistantRuntimeDependencies(client:Client,owner:string,turns:string[],requests:string[]=[],inputs:string[]=[]):Promise<void>{
 const id=operation.getStore();if(!id)return;
 const rows=(await client.query(`SELECT DISTINCT contact_id,session_id FROM assistant_session_turn WHERE owner_id=$1 AND (id=ANY($2::uuid[]) OR reply_request_id=ANY($3::uuid[]))
  UNION SELECT contact_id,session_id FROM assistant_session_input WHERE owner_id=$1 AND id=ANY($4::uuid[])`,[owner,turns,requests,inputs])).rows;
 for(const row of rows)await captureAssistantRuntimeScope(client,id,owner,row.contact_id,row.session_id);
}
