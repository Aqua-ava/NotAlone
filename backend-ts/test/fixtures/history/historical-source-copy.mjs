import {randomUUID} from 'node:crypto';

// 只构造合成历史数据，模拟46已存在的撤销绑定和物理出现。当前读者不能由此获得新授权。
export const historicalSourceCopy={name:'fixture.historicalSourceCopy',mode:'write',retryBusy:false,execute(tx,{token,generation=token.source_generation}){
 const {owner_id:owner,contact_id:contact,binding_id:binding,grant_id:grant,verification_id:verification}=token;
 const selection=BigInt(token.selection_generation)+tx.get("SELECT count(*) n FROM conversation_binding WHERE owner_id=? AND contact_id=?",[owner,contact]).n;
 const old={...token,selection_generation:String(selection),binding_id:randomUUID(),grant_id:randomUUID(),verification_id:randomUUID(),source_generation:generation};
 const byId=(table,id)=>tx.get(`SELECT * FROM ${table} WHERE owner_id=? AND id=?`,[owner,id]);
 const insert=(table,row)=>{const fields=Object.keys(row);tx.run(`INSERT INTO ${table}(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`,Object.values(row));};
 tx.run("UPDATE conversation_binding SET state='revoked' WHERE owner_id=? AND id=?",[owner,binding]);
 tx.run('UPDATE contact SET selection_generation=? WHERE owner_id=? AND id=?',[selection,owner,contact]);
 insert('conversation_binding',{...byId('conversation_binding',binding),id:old.binding_id,state:'verified'});
 insert('binding_verification',{...byId('binding_verification',verification),id:old.verification_id,binding_id:old.binding_id});
 insert('read_grant',{...byId('read_grant',grant),id:old.grant_id,binding_id:old.binding_id,verification_id:old.verification_id,selection_generation:selection,revoked_at:Date.now(),reason:'synthetic-old-source'});
 tx.run("UPDATE conversation_binding SET state='revoked' WHERE owner_id=? AND id=?",[owner,old.binding_id]);
 tx.run("UPDATE conversation_binding SET state='verified' WHERE owner_id=? AND id=?",[owner,binding]);
 tx.run('UPDATE contact SET selection_generation=? WHERE owner_id=? AND id=?',[BigInt(token.selection_generation),owner,contact]);
 const goal=tx.get("SELECT * FROM read_goal WHERE owner_id=? AND contact_id=? AND binding_id=? AND kind='history' ORDER BY creation_no DESC LIMIT 1",[owner,contact,binding]);
 const capture=tx.get('SELECT * FROM sync_capture WHERE owner_id=? AND goal_id=? ORDER BY acceptance_no DESC LIMIT 1',[owner,goal.id]);
 const records=tx.all("SELECT * FROM capture_record WHERE owner_id=? AND capture_id=? AND state='normalized' ORDER BY item_no",[owner,capture.id]);
 const target=JSON.parse(goal.target_json),report=JSON.parse(goal.support_json),id=randomUUID(),captureId=randomUUID();
 insert('read_goal',{...goal,id,binding_id:old.binding_id,grant_id:old.grant_id,creation_no:null,handoff_from_goal_id:null,eligibility_json:JSON.stringify(old),target_json:JSON.stringify({...target,sourceGeneration:generation}),support_json:JSON.stringify({...report,sourceGeneration:generation})});
 insert('sync_capture',{...capture,id:captureId,goal_id:id,acceptance_no:null});
 const copies=[];
 for(const record of records){
  const message=byId('message',record.message_id),messageId=randomUUID(),sourceId=randomUUID();
  const key=JSON.parse(record.observed_key),localId=key[3];key[0]=generation;
  const externalKey=JSON.stringify(key),displayNo=tx.get('SELECT max(display_no)+1 n FROM message').n;
  insert('message',{...message,id:messageId,binding_id:old.binding_id,display_no:displayNo,external_key:externalKey});
  insert('message_alias',{owner_id:owner,id:randomUUID(),contact_id:contact,binding_id:old.binding_id,scheme:'local',external_key:externalKey,message_id:messageId});
  insert('capture_record',{...record,id:sourceId,message_id:messageId,capture_id:captureId,observed_key:externalKey});
  copies.push({id:messageId,localId,sourceRecordIds:[sourceId]});
 }
 return copies;
}};
