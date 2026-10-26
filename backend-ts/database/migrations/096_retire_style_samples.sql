BEGIN;

-- 退役主动收藏表达样本：先定位传递派生副本，再删专属表；原消息、记忆、偏好不删。
CREATE TEMP TABLE retired_sample_dependency (owner_id uuid NOT NULL, id uuid NOT NULL,
    PRIMARY KEY(owner_id,id)) ON COMMIT DROP;
INSERT INTO retired_sample_dependency SELECT owner_id,id FROM public.style_sample;

-- 保存快照中的已用样本即使没有 use 行，也必须阻止旧输入恢复。
INSERT INTO retired_sample_dependency
SELECT owner_id,id FROM public.reply_request
WHERE coalesce(context_snapshot->'style_references','[]') NOT IN ('[]','null')
   OR coalesce(context_snapshot->'style_sample_ids','[]') NOT IN ('[]','null')
   OR coalesce(context_snapshot->'assistant_discussion_style_sample_ids','[]') NOT IN ('[]','null')
ON CONFLICT DO NOTHING;
INSERT INTO retired_sample_dependency
SELECT owner_id,id FROM public.assistant_session_turn
WHERE coalesce(prepared_context#>'{context,style_references}','[]') NOT IN ('[]','null')
ON CONFLICT DO NOTHING;
INSERT INTO retired_sample_dependency
SELECT owner_id,id FROM public.assistant_session_input
WHERE input_type='candidate_carry' AND coalesce(content->'style_sample_ids','[]') NOT IN ('[]','null')
ON CONFLICT DO NOTHING;

DO $$
DECLARE added integer;
BEGIN
    LOOP
        WITH edges AS (
            SELECT use.owner_id,use.reply_request_id AS id FROM public.reply_style_sample_use AS use
            UNION ALL
            SELECT r.owner_id,r.id FROM public.reply_request r
            JOIN retired_sample_dependency d ON d.owner_id=r.owner_id
            WHERE r.continued_from_candidate_id=d.id OR r.skill_version_id=d.id
            UNION ALL
            SELECT t.owner_id,t.id FROM public.assistant_session_turn t
            JOIN retired_sample_dependency d ON d.owner_id=t.owner_id
            WHERE t.reply_request_id=d.id OR d.id=ANY(t.dependency_ids)
            UNION ALL
            SELECT t.owner_id,t.reply_request_id FROM public.assistant_session_turn t
            JOIN retired_sample_dependency d ON d.owner_id=t.owner_id AND d.id=t.id
            UNION ALL
            SELECT r.owner_id,r.id FROM public.reply_request r
            JOIN public.assistant_session_turn t ON t.owner_id=r.owner_id AND t.contact_id=r.contact_id
                AND t.idempotency_key=r.idempotency_key
            JOIN retired_sample_dependency d ON d.owner_id=t.owner_id AND d.id=t.id
            UNION ALL
            SELECT t.owner_id,t.id FROM public.assistant_session_turn t
            JOIN public.reply_request r ON r.owner_id=t.owner_id AND r.contact_id=t.contact_id
                AND r.idempotency_key=t.idempotency_key
            JOIN retired_sample_dependency d ON d.owner_id=r.owner_id AND d.id=r.id
            UNION ALL
            SELECT i.owner_id,i.id FROM public.assistant_session_input i
            JOIN retired_sample_dependency d ON d.owner_id=i.owner_id
            WHERE i.turn_id=d.id OR d.id=ANY(i.dependency_ids)
               OR (i.input_type='candidate_carry' AND i.content->>'origin_reply_request_id'=d.id::text)
            UNION ALL
            SELECT i.owner_id,i.turn_id FROM public.assistant_session_input i
            JOIN retired_sample_dependency d ON d.owner_id=i.owner_id AND d.id=i.id
            UNION ALL
            SELECT c.owner_id,c.id FROM public.reply_candidate c
            JOIN retired_sample_dependency d ON d.owner_id=c.owner_id AND d.id=c.reply_request_id
            UNION ALL
            SELECT v.owner_id,v.id FROM public.assistant_candidate_version v
            JOIN retired_sample_dependency d ON d.owner_id=v.owner_id AND d.id=v.candidate_id
            UNION ALL
            SELECT s.owner_id,s.id FROM public.assistant_candidate_selection s
            JOIN retired_sample_dependency d ON d.owner_id=s.owner_id AND d.id=s.candidate_id
            UNION ALL
            SELECT c.owner_id,c.id FROM public.skill_review_comparison c
            JOIN retired_sample_dependency d ON d.owner_id=c.owner_id
            WHERE d.id=c.draft_id OR d.id=ANY(c.dependency_ids)
            UNION ALL
            SELECT draft.owner_id,draft.id FROM public.skill_draft draft
            JOIN retired_sample_dependency d ON d.owner_id=draft.owner_id AND (d.id=ANY(draft.dependency_ids) OR d.id=draft.current_comparison_id)
            UNION ALL
            SELECT p.owner_id,p.version_id FROM public.reply_skill_publication p
            JOIN retired_sample_dependency d ON d.owner_id=p.owner_id
            WHERE p.draft_id=d.id OR d.id=ANY(p.dependency_ids)
        )
        INSERT INTO retired_sample_dependency SELECT owner_id,id FROM edges WHERE id IS NOT NULL
        ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS added=ROW_COUNT;
        EXIT WHEN added=0;
    END LOOP;
END $$;

INSERT INTO public.reply_invalidated_key(owner_id,contact_id,idempotency_key)
SELECT r.owner_id,r.contact_id,r.idempotency_key FROM public.reply_request r
JOIN retired_sample_dependency d ON d.owner_id=r.owner_id AND d.id=r.id
UNION
SELECT t.owner_id,t.contact_id,t.idempotency_key FROM public.assistant_session_turn t
JOIN retired_sample_dependency d ON d.owner_id=t.owner_id AND d.id=t.id
ON CONFLICT DO NOTHING;

UPDATE public.assistant_session_input i SET state='redacted',content=NULL,dependency_ids='{}',updated_at=now()
FROM retired_sample_dependency d WHERE d.owner_id=i.owner_id AND d.id=i.id;
UPDATE public.assistant_session_turn t SET state='redacted',input_payload=NULL,input_digest=NULL,
    reply_request_id=NULL,dependency_ids='{}',prepared_context=NULL,interruption_reason=NULL,updated_at=now()
FROM retired_sample_dependency d WHERE d.owner_id=t.owner_id AND d.id=t.id;

-- 来源于样本的学习产物沿同一依赖闭包清除；独立策略与偏好不受影响。
UPDATE public.skill_library l SET revision=revision+1
WHERE EXISTS (SELECT 1 FROM public.reply_skill_publication p JOIN retired_sample_dependency d
    ON d.owner_id=p.owner_id AND d.id=p.version_id WHERE p.owner_id=l.owner_id AND NOT p.deleted);
UPDATE public.reply_skill s SET description='来源功能已退役',status='disabled',updated_at=now()
WHERE status<>'deleted' AND EXISTS (SELECT 1 FROM public.reply_skill_version v
    JOIN public.reply_skill_publication p ON p.version_id=v.id
    JOIN retired_sample_dependency d ON d.owner_id=p.owner_id AND d.id=p.version_id
    WHERE v.skill_id=s.id AND v.is_current);
UPDATE public.reply_skill_version v SET description='来源功能已退役',content=NULL,content_sha256=NULL,
    source_locator=NULL,validation_warnings='[]',enabled=false,is_current=false,status='deleted',deleted_at=now()
WHERE id IN (SELECT p.version_id FROM public.reply_skill_publication p JOIN retired_sample_dependency d
    ON d.owner_id=p.owner_id AND d.id=p.version_id);
DELETE FROM public.reply_skill_resource WHERE skill_version_id IN
    (SELECT p.version_id FROM public.reply_skill_publication p JOIN retired_sample_dependency d
     ON d.owner_id=p.owner_id AND d.id=p.version_id);
UPDATE public.reply_skill_method SET title=NULL,instruction=NULL WHERE version_id IN
    (SELECT p.version_id FROM public.reply_skill_publication p JOIN retired_sample_dependency d
     ON d.owner_id=p.owner_id AND d.id=p.version_id);
UPDATE public.reply_skill_publication p SET deleted=true,dependency_ids='{}',source_generation='{}',
    scope_kind='owner',scope_contact_id=NULL,scene=NULL
FROM retired_sample_dependency d WHERE d.owner_id=p.owner_id AND d.id=p.version_id;
UPDATE public.skill_review_comparison c SET state='invalidated',input=NULL,confirmed_scope=NULL,
    context_fingerprint=NULL,dependency_ids='{}',source_generation='{}',target_versions='[]',
    result=NULL,run_token=NULL,lease_expires_at=NULL
WHERE EXISTS (SELECT 1 FROM retired_sample_dependency d WHERE d.owner_id=c.owner_id
    AND (d.id=c.draft_id OR d.id=ANY(c.dependency_ids)));
UPDATE public.skill_review_operation o SET request_fingerprint=NULL
FROM retired_sample_dependency d WHERE d.owner_id=o.owner_id AND d.id=o.draft_id;
UPDATE public.skill_draft draft SET status='invalidated',revision=revision+1,strategy=NULL,private_evidence=NULL,
    target_versions='[]',source_generation='{}',dependency_ids='{}',current_comparison_id=NULL,batch_key=draft.id::text
FROM retired_sample_dependency d WHERE d.owner_id=draft.owner_id AND d.id=draft.id;
UPDATE public.skill_learning_batch b SET outcome='invalidated',dependency_ids='{}',batch_key=b.id::text
WHERE EXISTS (SELECT 1 FROM retired_sample_dependency d WHERE d.owner_id=b.owner_id
    AND (d.id=b.draft_id OR d.id=ANY(b.dependency_ids)));
UPDATE public.skill_learning_receipt r SET digest=NULL FROM public.skill_learning_batch b
WHERE b.id=r.batch_id AND b.outcome='invalidated';

UPDATE public.assistant_session s SET current_input_version_id=NULL,updated_at=now()
WHERE EXISTS (SELECT 1 FROM retired_sample_dependency d WHERE d.owner_id=s.owner_id AND d.id=s.current_input_version_id);

DELETE FROM public.reply_request r USING retired_sample_dependency d
WHERE d.owner_id=r.owner_id AND d.id=r.id;

-- 所有旧 prepared_context 都需按新 codec 显式重新准备，不能残留样本文字。
UPDATE public.assistant_session_turn SET prepared_context=NULL WHERE prepared_context IS NOT NULL;
UPDATE public.reply_request SET context_snapshot=context_snapshot
    - 'style_references' - 'style_sample_ids' - 'assistant_discussion_style_sample_ids'
WHERE context_snapshot ?| ARRAY['style_references','style_sample_ids','assistant_discussion_style_sample_ids'];
-- 空依赖旧携入保留原元数据及指纹，由新 codec 的 v1 空依赖兼容分支读取。
DROP TABLE public.style_sample_generation_dependency;
DROP TABLE public.style_sample_expression_preference_use;
DROP TABLE public.reply_style_sample_use;
DROP TABLE public.style_sample;

COMMIT;
