/** 每条查询只解析一次当前固定目标；出现键用前缀范围匹配，保留来源索引。 */
function sourceScopeCTE(saved:boolean):string{return `history_scope_request AS MATERIALIZED (
 SELECT ? owner_id,? contact_scope,? contact_id
), current_history_ranked AS MATERIALIZED (
 SELECT h.owner_id,h.contact_id,h.binding_id,h.target_json,row_number() OVER(PARTITION BY h.owner_id,h.contact_id ORDER BY h.creation_no DESC) position
 FROM read_goal h JOIN history_scope_request q ON q.owner_id=h.owner_id AND q.contact_scope IS NOT NULL AND h.contact_id=q.contact_id
 WHERE h.kind='history' AND h.creation_no IS NOT NULL AND EXISTS(SELECT 1 FROM conversation_binding live WHERE live.owner_id=h.owner_id AND live.id=h.binding_id AND ${saved?"live.state<>'revoked'":"live.state='verified'"}) AND NOT EXISTS(SELECT 1 FROM history_source_recertification cert WHERE cert.owner_id=h.owner_id AND cert.new_binding_id=h.binding_id AND cert.state<>'completed')
 UNION ALL
 SELECT h.owner_id,h.contact_id,h.binding_id,h.target_json,row_number() OVER(PARTITION BY h.owner_id,h.contact_id ORDER BY h.creation_no DESC) position
 FROM read_goal h JOIN history_scope_request q ON q.owner_id=h.owner_id AND q.contact_scope IS NULL
 WHERE h.kind='history' AND h.creation_no IS NOT NULL AND EXISTS(SELECT 1 FROM conversation_binding live WHERE live.owner_id=h.owner_id AND live.id=h.binding_id AND ${saved?"live.state<>'revoked'":"live.state='verified'"}) AND NOT EXISTS(SELECT 1 FROM history_source_recertification cert WHERE cert.owner_id=h.owner_id AND cert.new_binding_id=h.binding_id AND cert.state<>'completed')
), current_history_scope AS MATERIALIZED (
 SELECT owner_id,contact_id,binding_id,target_json FROM current_history_ranked WHERE position=1
 UNION ALL
 SELECT c.owner_id,c.contact_id,b.id,json_object('sourceGeneration',c.source_generation,'partitions',json_extract(c.tables_json,'$.partitions'),'tables',json((
  SELECT json_group_array(json_object('partition',json_extract(t.value,'$[0]'),'instance',json_extract(t.value,'$[1]'))) FROM json_each(c.tables_json,'$.tables') t)))
 FROM history_continuity_scope c JOIN history_scope_request q ON q.owner_id=c.owner_id
 JOIN conversation_binding b ON b.owner_id=c.owner_id AND b.contact_id=c.contact_id AND b.conversation_id=c.conversation_id AND ${saved?"b.state<>'revoked'":"b.state='verified'"}
 WHERE (q.contact_scope IS NULL OR c.contact_id=q.contact_id) AND NOT EXISTS(SELECT 1 FROM history_source_recertification cert WHERE cert.owner_id=b.owner_id AND cert.new_binding_id=b.id AND cert.state<>'completed') AND c.tables_json<>'' AND json_valid(c.tables_json)
 AND NOT EXISTS (SELECT 1 FROM current_history_ranked h WHERE h.owner_id=c.owner_id AND h.contact_id=c.contact_id)
), current_source_members AS MATERIALIZED (
 SELECT h.owner_id,h.contact_id,h.binding_id,json_extract(h.target_json,'$.sourceGeneration') generation,
 json_extract(t.value,'$.partition') partition,json_extract(t.value,'$.instance') instance,
 json_array(json_extract(h.target_json,'$.sourceGeneration'),json_extract(t.value,'$.partition'),json_extract(t.value,'$.instance')) closed_prefix
 FROM current_history_scope h JOIN json_each(h.target_json,'$.tables') t
), current_source_ranges AS MATERIALIZED (
 SELECT *,substr(closed_prefix,1,length(closed_prefix)-1)||',' prefix FROM current_source_members
)`;}
export const currentSourceScopeCTE=sourceScopeCTE(false);
/** 本机资料沿已持久接纳范围，不要求当前读取绑定重新获证；撤销仍不可用。 */
export const savedSourceScopeCTE=sourceScopeCTE(true);

/** 别名参数由领域代码提供，不能来自请求；范围包含绑定、代次和精确分片／表实例。 */
export function currentSourcePredicate(record='r',goal='g'):string{return `EXISTS (SELECT 1 FROM current_source_ranges scope
 WHERE scope.owner_id=${record}.owner_id AND scope.contact_id=${record}.contact_id AND scope.binding_id=${goal}.binding_id
 AND ${record}.observed_scheme='source-table-local-v1' AND ${record}.observed_key>=scope.prefix AND ${record}.observed_key<scope.prefix||'~')`;}

/** 无精确键的本次观察仍阻挡覆盖；只有旧目标范围的审计才退出当前缺口。 */
export function currentCapturePredicate(record='r',goal='g'):string{return `(${currentSourcePredicate(record,goal)} OR (${record}.observed_key IS NULL AND EXISTS (
 SELECT 1 FROM current_source_ranges scope JOIN json_each(${goal}.target_json,'$.tables') prior
 WHERE scope.owner_id=${record}.owner_id AND scope.contact_id=${record}.contact_id AND scope.binding_id=${goal}.binding_id
 AND json_extract(${goal}.target_json,'$.sourceGeneration')=scope.generation
 AND json_extract(prior.value,'$.partition')=scope.partition AND json_extract(prior.value,'$.instance')=scope.instance)))`;}

/** 旧目标没有明确先后时，只从已核验的当前范围选择覆盖证据。 */
export function currentGoalPredicate(goal='g'):string{return `EXISTS (SELECT 1 FROM current_history_scope scope
 WHERE scope.owner_id=${goal}.owner_id AND scope.contact_id=${goal}.contact_id AND scope.binding_id=${goal}.binding_id
 AND json_extract(scope.target_json,'$.sourceGeneration')=json_extract(${goal}.target_json,'$.sourceGeneration')
 AND NOT EXISTS (SELECT value FROM json_each(scope.target_json,'$.partitions') EXCEPT SELECT value FROM json_each(${goal}.target_json,'$.partitions'))
 AND NOT EXISTS (SELECT value FROM json_each(${goal}.target_json,'$.partitions') EXCEPT SELECT value FROM json_each(scope.target_json,'$.partitions'))
 AND NOT EXISTS (SELECT json_extract(value,'$.partition'),json_extract(value,'$.instance') FROM json_each(scope.target_json,'$.tables') EXCEPT SELECT json_extract(value,'$.partition'),json_extract(value,'$.instance') FROM json_each(${goal}.target_json,'$.tables'))
 AND NOT EXISTS (SELECT json_extract(value,'$.partition'),json_extract(value,'$.instance') FROM json_each(${goal}.target_json,'$.tables') EXCEPT SELECT json_extract(value,'$.partition'),json_extract(value,'$.instance') FROM json_each(scope.target_json,'$.tables')))`;}
