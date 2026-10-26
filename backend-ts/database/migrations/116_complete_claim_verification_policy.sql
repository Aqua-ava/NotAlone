BEGIN;

-- 只扩展新任务显式 v2；旧 NULL/v1 保持，不回写历史任务。
ALTER TABLE public.background_task DROP CONSTRAINT background_task_extraction_runtime_config_check;
ALTER TABLE public.background_task ADD CONSTRAINT background_task_extraction_runtime_config_check CHECK (
 extraction_runtime_config IS NULL OR COALESCE(
  jsonb_typeof(extraction_runtime_config)='object' AND (
   (extraction_runtime_config ?& ARRAY['version','mode','rule_set_sha256']
    AND extraction_runtime_config - ARRAY['version','mode','rule_set_sha256']='{}'::jsonb
    AND jsonb_typeof(extraction_runtime_config->'version')='number'
    AND extraction_runtime_config->>'version'='1'
    AND ((extraction_runtime_config->>'mode'='legacy' AND extraction_runtime_config->'rule_set_sha256'='null'::jsonb)
     OR (extraction_runtime_config->>'mode'='bounded-runtime-v1'
      AND jsonb_typeof(extraction_runtime_config->'rule_set_sha256')='string'
      AND extraction_runtime_config->>'rule_set_sha256' ~ '^[a-f0-9]{64}$')))
   OR
   (extraction_runtime_config ?& ARRAY['version','mode','rule_set_sha256','verification_policy','source_stamp']
    AND extraction_runtime_config - ARRAY['version','mode','rule_set_sha256','verification_policy','source_stamp']='{}'::jsonb
    AND extraction_runtime_config->'version'='2'::jsonb
    AND extraction_runtime_config->'mode'='"legacy"'::jsonb
    AND extraction_runtime_config->'rule_set_sha256'='null'::jsonb
    AND extraction_runtime_config->'verification_policy'='"complete-claim-v1"'::jsonb
    AND jsonb_typeof(extraction_runtime_config->'source_stamp')='string'
    AND extraction_runtime_config->>'source_stamp' ~ '^[a-f0-9]{64}$')
  ),false)
);

COMMIT;
