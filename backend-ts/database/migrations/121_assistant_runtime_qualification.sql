BEGIN;
-- 业务投影落盘凭据与真实生成提交分开；旧档案没有资格清单时不能直接外发。
ALTER TABLE public.assistant_runtime_session
 ADD COLUMN origin text NOT NULL DEFAULT 'generated' CHECK(origin IN ('generated','business_bootstrap','business_rebuild')),
 ADD COLUMN qualification jsonb,
 ADD COLUMN committed_event_sha256 text CHECK(committed_event_sha256 ~ '^[a-f0-9]{64}$');
COMMENT ON COLUMN public.assistant_runtime_session.qualification IS '无正文材料指纹与业务投影凭据；每个出站和保存阶段重新核验。';
COMMIT;
