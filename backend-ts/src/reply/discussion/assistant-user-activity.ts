import type {Client} from 'pg';

/** 内部领域时钟；正常运行由同一数据库连接给出权威时间。 */
export type AssistantClock=()=>Promise<string>;
export async function assistantNow(client:Client,clock?:AssistantClock):Promise<string>{
 return clock?clock():(await client.query('SELECT clock_timestamp()::text AS value')).rows[0].value;
}
/** 只由明确的用户写操作调用，读取与任务完成不得续期。 */
export async function recordAssistantUserActivity(client:Client,scope:{owner_id:string;contact_id:string},session:string,clock?:AssistantClock):Promise<void>{
 await client.query('UPDATE assistant_session SET last_user_activity_at=$4::timestamptz WHERE owner_id=$1 AND contact_id=$2 AND id=$3',[scope.owner_id,scope.contact_id,session,await assistantNow(client,clock)]);
}
