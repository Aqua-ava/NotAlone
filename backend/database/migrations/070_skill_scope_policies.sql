BEGIN;

-- 用户明确的范围决定独立于不可变正文；不保存反馈原话、聊天或候选副本。
CREATE TABLE public.skill_policy_state (
    owner_id uuid PRIMARY KEY REFERENCES public.owner(id) ON DELETE CASCADE,
    revision integer NOT NULL CHECK (revision >= 0)
);
CREATE TABLE public.skill_scope_policy (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES public.owner(id) ON DELETE CASCADE,
    skill_id uuid NOT NULL,
    method_id uuid,
    scope_kind text NOT NULL CHECK (scope_kind IN ('owner','contact','scene')),
    contact_id uuid,
    scene text,
    revision integer NOT NULL CHECK (revision > 0),
    FOREIGN KEY (skill_id,owner_id) REFERENCES public.reply_skill(id,owner_id) ON DELETE CASCADE,
    FOREIGN KEY (owner_id,contact_id) REFERENCES public.contact(owner_id,id) ON DELETE CASCADE,
    CHECK ((scope_kind='owner' AND contact_id IS NULL AND scene IS NULL)
        OR (scope_kind='contact' AND contact_id IS NOT NULL AND scene IS NULL)
        OR (scope_kind='scene' AND scene IS NOT NULL AND scene=btrim(scene) AND length(scene) BETWEEN 1 AND 256))
);
CREATE INDEX skill_scope_policy_owner ON public.skill_scope_policy(owner_id,skill_id);
CREATE TABLE public.skill_policy_operation (
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    operation_key uuid NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    result_revision integer NOT NULL CHECK (result_revision >= 0),
    PRIMARY KEY (owner_id,contact_id,operation_key),
    FOREIGN KEY (owner_id,contact_id) REFERENCES public.contact(owner_id,id) ON DELETE CASCADE
);

COMMIT;
