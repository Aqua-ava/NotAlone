BEGIN;

ALTER TABLE public.reply_skill_version
    ADD COLUMN method_manifest_path text,
    ADD COLUMN method_manifest_sha256 text CHECK (
        method_manifest_sha256 IS NULL OR method_manifest_sha256 ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT reply_skill_method_manifest_locator_check CHECK (
        (method_manifest_path IS NULL) = (method_manifest_sha256 IS NULL));

COMMENT ON COLUMN public.reply_skill_version.method_manifest_path IS
    '受控不可变版本根内的方法正文清单；数据库仅保存定位和哈希，运行时不从方法表读取正文。';
COMMENT ON COLUMN public.reply_skill_method.title IS
    '仅供旧版方法正文迁移；落盘核验后清空，不供运行时加载。';
COMMENT ON COLUMN public.reply_skill_method.instruction IS
    '仅供旧版方法正文迁移；落盘核验后清空，不供运行时加载。';

COMMIT;
