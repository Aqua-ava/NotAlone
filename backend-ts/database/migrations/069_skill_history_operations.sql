BEGIN;

-- 历史回滚只保存动作身份和结果身份，不保存策略、私人来源或响应副本。
ALTER TABLE public.reply_skill ADD CONSTRAINT reply_skill_id_owner_unique UNIQUE (id, owner_id);
ALTER TABLE public.reply_skill_version ADD CONSTRAINT reply_skill_version_id_skill_unique UNIQUE (id, skill_id);
CREATE TABLE public.skill_history_operation (
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    operation_key uuid NOT NULL,
    skill_id uuid NOT NULL,
    version_id uuid NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    result_revision integer NOT NULL CHECK (result_revision >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, contact_id, operation_key),
    FOREIGN KEY (owner_id, contact_id) REFERENCES public.contact(owner_id, id) ON DELETE CASCADE,
    FOREIGN KEY (skill_id, owner_id) REFERENCES public.reply_skill(id, owner_id) ON DELETE CASCADE,
    FOREIGN KEY (version_id, skill_id) REFERENCES public.reply_skill_version(id, skill_id) ON DELETE CASCADE
);

COMMIT;
