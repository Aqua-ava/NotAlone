import type {Client} from 'pg';

/** 只由明确的用户写操作调用，读取与任务完成不得续期。 */
export async function recordAssistantUserActivity(client:Client,scope:{owner_id:string;contact_id:string},session:string):Promise<void>{
 await client.query('UPDATE assistant_session SET last_user_activity_at=clock_timestamp() WHERE owner_id=$1 AND contact_id=$2 AND id=$3',[scope.owner_id,scope.contact_id,session]);
}
