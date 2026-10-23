/** 联系人上下文：身份只来自宿主与原UUID，模型不参与范围决定。 */
import type pg from 'pg';
import { HostStorage, HostStorageError } from './host-storage.ts';

export class ContactContextError extends HostStorageError {
  readonly status: number;
  constructor(code: string, status = 409) { super(code); this.status=status; }
}
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function contactContextRoute(method: string, pathname: string): boolean {
  return method === 'GET' && (pathname === '/api/contacts' || /^\/api\/contacts\/[^/]+\/(messages|sources|relationship-overview)$/.test(pathname))
    || method === 'POST' && /^\/api\/contacts\/[^/]+\/manual-confirmation$/.test(pathname);
}
export function validMessageSource(alias: string): string {
  return `EXISTS(SELECT 1 FROM public.message_source_ref ref WHERE ref.owner_id=${alias}.owner_id AND ref.contact_id=${alias}.contact_id AND ref.message_id=${alias}.id AND (
    EXISTS(SELECT 1 FROM public.source_document s WHERE s.owner_id=ref.owner_id AND s.contact_id=ref.contact_id AND s.id=ref.source_document_id AND s.status='active') OR
    EXISTS(SELECT 1 FROM public.local_wechat_observation o WHERE o.owner_id=ref.owner_id AND o.contact_id=ref.contact_id AND o.id=ref.observation_id)))`;
}
export class ContactContext {
  private readonly storage: HostStorage;
  constructor(storage: HostStorage) { this.storage=storage; }
  async handle(method: string, url: URL, body?: unknown, assertCurrent: () => void = () => {}, internal = false): Promise<unknown> {
    assertCurrent();
    const owner=this.storage.runtimeOwnerId?.toLowerCase();
    if(!owner)throw new ContactContextError('owner_uninitialized',503);
    return this.storage.businessTransaction(async client => {
      if(url.pathname==='/api/contacts') return {contacts:(await client.query(`SELECT c.id AS contact_id,c.display_name,
        json_build_object('message_count',(SELECT count(*) FROM public.message m WHERE m.owner_id=c.owner_id AND m.contact_id=c.id AND ${validMessageSource('m')}),
        'source_count',(SELECT count(*) FROM public.source_document s WHERE s.owner_id=c.owner_id AND s.contact_id=c.id AND s.status='active')+(SELECT count(*) FROM public.local_wechat_observation o WHERE o.owner_id=c.owner_id AND o.contact_id=c.id)) AS data_status
        FROM public.contact c WHERE c.owner_id=$1 ORDER BY c.created_at,c.id`,[owner])).rows};
      const contact=url.pathname.split('/')[3].toLowerCase();
      if(!uuid.test(contact))throw new ContactContextError('contact_not_found',404);
      const before=await scopeRevision(client,owner,contact);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${owner}:${contact}`]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${owner}`]);
      if(before!==await scopeRevision(client,owner,contact))throw new ContactContextError('contact_context_changed');
      let result: unknown;
      if(url.pathname.endsWith('/sources')) result={sources:(await client.query(`SELECT source.id AS source_id,source.file_name,source.record_count,source.status,
        task.id AS task_id,task.status AS task_status,task.current_step AS step,
        COALESCE(task.last_error_code,source.deletion_error_code,CASE WHEN source.status='deleted' AND task.id IS NULL THEN 'legacy_deletion_unverified' END) AS error_code
        FROM public.source_document source LEFT JOIN public.background_task task ON task.owner_id=source.owner_id AND task.contact_id=source.contact_id AND task.source_document_id=source.id AND task.task_type='delete'
        WHERE source.owner_id=$1 AND source.contact_id=$2 ORDER BY source.imported_at DESC,source.id`,[owner,contact])).rows};
      else if(url.pathname.endsWith('/relationship-overview')) {
        const {readContactOverview,OverviewError}=await import('./contact-overview.ts');
        try {result={overview:await readContactOverview(client,owner,contact,internal)};}
        catch(error){if(error instanceof OverviewError)throw new ContactContextError(error.code,error.status);throw error;}
      }
      else if(url.pathname.endsWith('/messages')) result=await readMessages(client,owner,contact,url);
      else if(method==='POST' && url.pathname.endsWith('/manual-confirmation')) {
        if(!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).length)throw new ContactContextError('contact_input_invalid',400);
        await client.query(`INSERT INTO public.manual_contact_confirmation(owner_id,contact_id) VALUES($1,$2)
          ON CONFLICT(owner_id,contact_id) DO UPDATE SET confirmed_at=now()`,[owner,contact]);
        result={confirmed:true};
      }
      else throw new ContactContextError('not_found',404);
      if(before!==await scopeRevision(client,owner,contact))throw new ContactContextError('contact_context_changed');
      assertCurrent();
      return result;
    }).catch(error=>{
      if(error instanceof ContactContextError)throw error;
      const operation=url.pathname.split('/').at(-1);
      const failures: Record<string,[string,number]>={contacts:['contact_list_unavailable',500],messages:['message_stream_unavailable',500],sources:['sources_unavailable',503],'relationship-overview':['overview_unavailable',503],'manual-confirmation':['contact_operation_unavailable',409]};
      const [code,status]=failures[operation??'']??['contact_context_unavailable',503];
      throw new ContactContextError(code,status);
    });
  }
}
async function scopeRevision(client: pg.Client,owner: string,contact: string): Promise<string> {
  const result=await client.query(`SELECT c.xmin::text AS revision,
    (SELECT coalesce(jsonb_agg(jsonb_build_array(b.id,b.xmin::text) ORDER BY b.id),'[]') FROM public.conversation_binding b WHERE b.owner_id=c.owner_id AND b.contact_id=c.id) AS bindings,
    (SELECT coalesce(jsonb_agg(x.xmin::text ORDER BY x.id),'[]') FROM public.owner_channel_identity x WHERE x.owner_id=c.owner_id) AS accounts,
    (SELECT x.xmin::text FROM public.front_sync_state x WHERE x.owner_id=c.owner_id) AS sync_switch,
    (SELECT coalesce(jsonb_agg(x.xmin::text ORDER BY x.channel,x.account_scope),'[]') FROM public.wechat_sync_scope x WHERE x.owner_id=c.owner_id) AS sync_scope,
    (SELECT coalesce(jsonb_agg(x.xmin::text ORDER BY x.channel,x.account_scope),'[]') FROM public.wechat_history_sync_authorization x WHERE x.owner_id=c.owner_id) AS history_grants,
    (SELECT coalesce(jsonb_agg(x.xmin::text ORDER BY x.channel,x.account_scope,x.locator_hash),'[]') FROM public.wechat_sync_exclusion x WHERE x.owner_id=c.owner_id) AS exclusions,
    (SELECT coalesce(jsonb_agg(x.xmin::text ORDER BY x.id),'[]') FROM public.source_document x WHERE x.owner_id=c.owner_id AND x.contact_id=c.id) AS sources
    FROM public.contact c WHERE c.owner_id=$1 AND c.id=$2`,[owner,contact]);
  if(!result.rowCount)throw new ContactContextError('contact_not_found',404);
  return JSON.stringify(result.rows[0]);
}
async function readMessages(client: pg.Client,owner: string,contact: string,url: URL): Promise<unknown> {
  const limitText=url.searchParams.get('limit')??'50', before=url.searchParams.get('before');
  if(!/^\d+$/.test(limitText) || +limitText<1 || +limitText>100 || before!==null && !uuid.test(before))throw new ContactContextError('invalid_message_query',400);
  const limit=+limitText;
  let cursor: {occurred_at: string|null}|undefined;
  if(before!==null) {
    cursor=(await client.query('SELECT occurred_at::text FROM public.message WHERE owner_id=$1 AND contact_id=$2 AND id=$3',[owner,contact,before])).rows[0];
    if(!cursor)throw new ContactContextError('invalid_message_query',400);
  }
  const params: unknown[]=[owner,contact,limit+1];
  let condition='';
  if(cursor) {
    params.push(before);
    if(cursor.occurred_at===null)condition='AND m.occurred_at IS NULL AND m.id<$4::uuid';
    else {params.push(cursor.occurred_at);condition='AND (m.occurred_at IS NULL OR (m.occurred_at,m.id)<($5::timestamptz,$4::uuid))';}
  }
  const rows=(await client.query(`SELECT m.id AS message_id,m.speaker,m.message_type,m.text_content AS text,m.media_placeholder,
    CASE WHEN m.occurred_at IS NULL THEN NULL WHEN extract(microseconds from m.occurred_at)::bigint % 1000000=0 THEN to_char(m.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') ELSE to_char(m.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS occurred_at,
    CASE WHEN q.server_id IS NULL THEN NULL ELSE json_build_object('text',coalesce(q.text,''),'target_message_id',target.id) END AS quoted
    FROM (SELECT m.* FROM public.message m WHERE m.owner_id=$1 AND m.contact_id=$2 AND ${validMessageSource('m')} ${condition}
      ORDER BY m.occurred_at DESC NULLS LAST,m.id DESC LIMIT $3) m
    LEFT JOIN LATERAL(SELECT r.raw_payload->'quote'->>'text' AS text,r.raw_payload->'quote'->'id'->>'server_id_str' AS server_id
      FROM public.message_source_ref r WHERE r.owner_id=m.owner_id AND r.contact_id=m.contact_id AND r.message_id=m.id
      AND (EXISTS(SELECT 1 FROM public.source_document s WHERE s.owner_id=r.owner_id AND s.contact_id=r.contact_id AND s.id=r.source_document_id AND s.status='active') OR EXISTS(SELECT 1 FROM public.local_wechat_observation o WHERE o.owner_id=r.owner_id AND o.contact_id=r.contact_id AND o.id=r.observation_id))
      ORDER BY (r.raw_payload->'quote'->>'text') IS NULL,r.id LIMIT 1) q ON q.server_id IS NOT NULL
    LEFT JOIN public.wechat_message_metadata meta ON meta.owner_id=m.owner_id AND meta.contact_id=m.contact_id AND meta.external_server_id=q.server_id
    LEFT JOIN public.message target ON target.owner_id=meta.owner_id AND target.contact_id=meta.contact_id AND target.id=meta.message_id AND ${validMessageSource('target')}
    ORDER BY m.occurred_at DESC NULLS LAST,m.id DESC,target.id ASC NULLS LAST LIMIT $3`,params)).rows;
  return {messages:rows.slice(0,limit),next_cursor:rows.length>limit?rows[limit-1].message_id:null};
}
