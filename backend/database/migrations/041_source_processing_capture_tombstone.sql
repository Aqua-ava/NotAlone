BEGIN;

-- 仅留捕获 UUID 的删除墓碑，阻止已删除的缓存原行另建批次复活。
CREATE TABLE public.source_processing_capture_tombstone (
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    capture_record_id uuid NOT NULL,
    deleted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, contact_id, capture_record_id),
    FOREIGN KEY (owner_id, contact_id)
        REFERENCES public.contact(owner_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE public.source_processing_capture_tombstone IS '无正文的已删除来源捕获标识；重新授权读取取得新捕获 UUID，不恢复旧批次。';

COMMIT;
