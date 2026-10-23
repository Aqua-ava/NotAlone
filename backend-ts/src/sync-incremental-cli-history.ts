/** 缺表只触发固定单会话计数查询；不接纳警告、部分结果或缓存证据。 */
const parse=(stdout:string):any=>{try{return JSON.parse(stdout);}catch{return null;}};
// Python 真值兼容：CLI 的空 warnings 数组和空 details 对象不代表失败。
const truthy=(value:unknown):boolean=>Array.isArray(value)?value.length>0:typeof value==='object'&&value!==null?Object.keys(value).length>0:Boolean(value);
export function exactMissingTable(stdout:string):boolean {
  const value=parse(stdout),error=value?.error;
  return value?.ok===false&&!truthy(value.warnings)&&value.data==null&&error?.code==='tool_error'&&!truthy(error.warnings)&&!truthy(error.details)&&typeof error.message==='string'&&/^table \S+ not found in [1-9]\d* message shards$/.test(error.message);
}
export function commandErrorCode(stdout:string):string {
  const value=parse(stdout),error=value?.ok===false?value.error:null;
  if(error?.code==='invalid_argument')return 'cli_invalid_argument';
  if(error?.code==='tool_error'&&typeof error.message==='string'){
    if(error.message.toLowerCase().includes('automatic key refresh is disabled')&&error.message.toLowerCase().includes('enc_key'))return 'cli_key_refresh_required';
    if(/^table \S+ not found in (?:\d+|opened) message shards$/.test(error.message))return 'cli_message_table_missing';
  }
  return 'cli_command_failed';
}
export function localHistorySql(talker:string):string {
  const literal="'"+talker.replaceAll("'","''")+"'";
  return 'SELECT '+`(SELECT COUNT(*) FROM SessionDeleteTable WHERE username = ${literal}) AS deleted_count, `+`(SELECT COUNT(*) FROM SessionTable WHERE username = ${literal}) AS session_count, `+'(SELECT COUNT(*) FROM SessionTable '+`WHERE username = ${literal} AND last_msg_locald_id = 0 `+"AND last_timestamp = 0 AND COALESCE(summary, '') = '') AS empty_session_count";
}
export function localHistoryState(stdout:string):'deleted'|'empty'|null {
  const value=parse(stdout),data=value?.data;
  if(value?.ok!==true||truthy(value.warnings)||truthy(value.error)||!data||truthy(data.warnings)||truthy(data.error))return null;
  if(data.freshness?.message_source!=='live_selected_db_read_only'||data.query?.has_more!==false||data.query?.returned!==1||!Array.isArray(data.rows)||data.rows.length!==1)return null;
  const row=data.rows[0];if(!row||Object.keys(row).sort().join(',')!=='deleted_count,empty_session_count,session_count')return null;
  if(Object.values(row).some(v=>v!==0&&v!==1)||row.empty_session_count!==row.session_count)return null;
  return row.deleted_count===1?'deleted':row.session_count===1?'empty':null;
}
