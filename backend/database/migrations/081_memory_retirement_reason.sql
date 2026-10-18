-- 退役原因仅表达用户明确决定；存量和自动失效保持 unknown，禁止猜测过去事实。
ALTER TABLE public.confirmed_memory
    ADD COLUMN retirement_reason text NOT NULL DEFAULT 'unknown'
        CHECK (retirement_reason IN ('unknown', 'error_correction', 'state_changed')),
    ADD COLUMN retired_at timestamptz;
ALTER TABLE public.owner_memory
    ADD COLUMN retirement_reason text NOT NULL DEFAULT 'unknown'
        CHECK (retirement_reason IN ('unknown', 'error_correction', 'state_changed')),
    ADD COLUMN retired_at timestamptz;
-- retired_at 是修改记录时间，不能替代事实有效期 invalid_at。
COMMENT ON COLUMN public.confirmed_memory.retired_at IS '用户或系统记录旧版退出当前资料的时间，不是事实发生变化的时间';
COMMENT ON COLUMN public.owner_memory.retired_at IS '用户或系统记录旧版退出当前资料的时间，不是事实发生变化的时间';
