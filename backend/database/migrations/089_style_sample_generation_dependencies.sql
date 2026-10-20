BEGIN;

-- 一行表示依赖已完整捕获；空数组是明确无事实依赖，缺行仍是未知而非空集。
CREATE TABLE public.style_sample_generation_dependency (
    sample_id uuid PRIMARY KEY,
    owner_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    dependency_ids uuid[] NOT NULL,
    captured_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (sample_id,owner_id,contact_id)
        REFERENCES public.style_sample(id,owner_id,contact_id) ON DELETE CASCADE
);
CREATE INDEX style_sample_generation_dependency_scope_idx
    ON public.style_sample_generation_dependency(owner_id,contact_id);

-- 独立手写与消息样本没有候选事实链；候选旧样本沿唯一运行时选择器受控回填。
INSERT INTO public.style_sample_generation_dependency(sample_id,owner_id,contact_id,dependency_ids)
SELECT id,owner_id,contact_id,'{}'::uuid[] FROM public.style_sample
WHERE status='active' AND origin_kind IN ('manual','message') AND cardinality(dependency_sample_ids)=0;

COMMENT ON TABLE public.style_sample_generation_dependency IS '主动样本完整的非正文生成依赖快照，独立于候选和会话留存；缺行不得推断为空。';
COMMENT ON COLUMN public.style_sample_generation_dependency.sample_id IS '主动保存的样本身份，样本物理删除时级联清理。';
COMMENT ON COLUMN public.style_sample_generation_dependency.owner_id IS '样本所属用户隔离键。';
COMMENT ON COLUMN public.style_sample_generation_dependency.contact_id IS '样本所属已确认联系人隔离键。';
COMMENT ON COLUMN public.style_sample_generation_dependency.dependency_ids IS '保存时实际使用的事实、派生版本及样本等非正文身份；不冒充原始来源。';
COMMENT ON COLUMN public.style_sample_generation_dependency.captured_at IS '完整依赖捕获时间；旧样本仅在原候选链仍可核验时回填。';

COMMIT;
