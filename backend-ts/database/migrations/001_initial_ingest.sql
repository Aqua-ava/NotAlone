BEGIN;

CREATE TABLE public.owner (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.contact (
    owner_id uuid NOT NULL REFERENCES public.owner(id) ON DELETE CASCADE,
    id text NOT NULL CHECK (length(btrim(id)) > 0),
    display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, id)
);

CREATE TABLE public.source_document (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL,
    contact_id text NOT NULL,
    source_type text NOT NULL CHECK (source_type IN ('wechat_jsonl')),
    file_name text NOT NULL CHECK (length(btrim(file_name)) > 0),
    content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    record_count integer NOT NULL CHECK (record_count >= 0),
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'deleting', 'deleted', 'failed')),
    imported_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    FOREIGN KEY (owner_id, contact_id)
        REFERENCES public.contact(owner_id, id) ON DELETE CASCADE,
    UNIQUE (owner_id, contact_id, content_sha256),
    UNIQUE (owner_id, contact_id, id)
);

CREATE TABLE public.message (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL,
    contact_id text NOT NULL,
    source_document_id uuid NOT NULL,
    external_local_id bigint NOT NULL,
    external_server_id text NOT NULL,
    external_talker text NOT NULL,
    speaker text NOT NULL CHECK (speaker IN ('user', 'contact', 'system')),
    message_type text NOT NULL
        CHECK (message_type IN ('text', 'quote', 'image', 'sticker', 'transfer', 'system')),
    text_content text NOT NULL DEFAULT '',
    occurred_at timestamptz,
    source_create_time bigint NOT NULL,
    raw_payload jsonb NOT NULL CHECK (jsonb_typeof(raw_payload) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (owner_id, contact_id)
        REFERENCES public.contact(owner_id, id) ON DELETE CASCADE,
    FOREIGN KEY (owner_id, contact_id, source_document_id)
        REFERENCES public.source_document(owner_id, contact_id, id) ON DELETE CASCADE,
    UNIQUE (source_document_id, external_local_id)
);

CREATE INDEX message_contact_time_idx
    ON public.message (owner_id, contact_id, occurred_at DESC, id);

CREATE INDEX message_source_idx
    ON public.message (source_document_id);

COMMENT ON TABLE public.owner IS
    'NotAlone 用户；用于隔离不同用户的联系人和关系资料。';
COMMENT ON COLUMN public.owner.id IS
    'NotAlone 内部生成的用户 UUID，不来自聊天导出文件。';
COMMENT ON COLUMN public.owner.display_name IS 'NotAlone 用户的展示名称。';
COMMENT ON COLUMN public.owner.created_at IS '该用户记录写入数据库的时间。';
COMMENT ON COLUMN public.owner.updated_at IS '该用户记录最后修改的时间。';

COMMENT ON TABLE public.contact IS '某位 NotAlone 用户名下的联系人。';
COMMENT ON COLUMN public.contact.owner_id IS
    '联系人所属的 NotAlone 用户 UUID，不来自聊天导出文件。';
COMMENT ON COLUMN public.contact.id IS
    '联系人稳定 ID；微信 JSONL 导入时取对方的 sender_wxid。';
COMMENT ON COLUMN public.contact.display_name IS
    '联系人展示名称；微信 JSONL 导入时取对方的 sender。';
COMMENT ON COLUMN public.contact.created_at IS '联系人记录写入数据库的时间。';
COMMENT ON COLUMN public.contact.updated_at IS
    '联系人记录最后修改的时间，例如展示名称更新。';

COMMENT ON TABLE public.source_document IS
    '一次单联系人原始文件导入的来源记录，不保存文件正文。';
COMMENT ON COLUMN public.source_document.id IS 'NotAlone 内部生成的来源 UUID。';
COMMENT ON COLUMN public.source_document.owner_id IS '该来源所属的 NotAlone 用户 UUID。';
COMMENT ON COLUMN public.source_document.contact_id IS '该来源唯一归属的联系人 ID。';
COMMENT ON COLUMN public.source_document.source_type IS
    '原始来源格式；首版仅支持 wechat_jsonl。';
COMMENT ON COLUMN public.source_document.file_name IS
    '用户选择的原始文件名，不含文件正文。';
COMMENT ON COLUMN public.source_document.content_sha256 IS
    '原始文件 SHA-256，用于识别同一联系人下的重复导入。';
COMMENT ON COLUMN public.source_document.record_count IS
    '原始文件通过完整校验后的记录总数。';
COMMENT ON COLUMN public.source_document.status IS
    '来源状态：active、deleting、deleted 或 failed。';
COMMENT ON COLUMN public.source_document.imported_at IS '来源成功写入数据库的时间。';
COMMENT ON COLUMN public.source_document.deleted_at IS
    '来源被标记删除的时间；未删除时为空。';

COMMENT ON TABLE public.message IS
    '规范化聊天消息；保存常用查询字段及未经删减的原始单行 JSON。';
COMMENT ON COLUMN public.message.id IS 'NotAlone 内部生成的消息 UUID。';
COMMENT ON COLUMN public.message.owner_id IS
    '消息所属的 NotAlone 用户 UUID，不来自聊天导出文件。';
COMMENT ON COLUMN public.message.contact_id IS
    '消息所属联系人 ID；微信 JSONL 导入时为对方 sender_wxid。';
COMMENT ON COLUMN public.message.source_document_id IS
    '产生该消息的原始文件来源 UUID。';
COMMENT ON COLUMN public.message.external_local_id IS '原始 JSON 的 id.local_id。';
COMMENT ON COLUMN public.message.external_server_id IS
    '原始 JSON 的 id.server_id_str。';
COMMENT ON COLUMN public.message.external_talker IS '原始 JSON 的 id.talker。';
COMMENT ON COLUMN public.message.speaker IS
    '规范化说话人：user、contact 或 system。';
COMMENT ON COLUMN public.message.message_type IS '消息类型，对应原始 JSON 的 kind。';
COMMENT ON COLUMN public.message.text_content IS '消息文字内容，对应原始 JSON 的 text。';
COMMENT ON COLUMN public.message.occurred_at IS
    '解析后的消息发生时间，优先来自原始 JSON 的 time_iso。';
COMMENT ON COLUMN public.message.source_create_time IS
    '原始 JSON 的 create_time 数值，用于来源复核。';
COMMENT ON COLUMN public.message.raw_payload IS
    '未经删减的原始单行 JSON 对象，包含 images、quote 或 transfer 等可选结构。';
COMMENT ON COLUMN public.message.created_at IS
    '该消息记录写入 NotAlone 数据库的时间。';

COMMIT;
