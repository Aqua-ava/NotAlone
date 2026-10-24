# 近期窗口取消独立上限验证

2026-10-24。对应用户决定与 `architecture/current/core-flows.md` 近期消息规则；DSH仍锁定0.2.1-rc.2／官方提交687f282e8625c6b8d11ff58211a90524be2e4317，不改核心或完整请求预算。

- 实际树：`node --test test/reply-context-window.test.mjs`，4/4通过。
- 相关回归：`node --test --test-concurrency=2 test/reply-context-window.test.mjs test/reply-context.test.mjs test/reply-context-overview.test.mjs test/reply-prepared-context.test.mjs test/reply-prepared-codec.test.mjs test/reply-preparation.test.mjs test/reply-service-preparation.test.mjs test/reply-preflight.test.mjs test/reply-preflight-prepared.test.mjs`，35/35通过。
- `pnpm run typecheck`，严格类型检查通过。以上命令在backend-ts目录运行。
- 独立审查在干净476298f2只叠加本次五个已跟踪文件，再依次验证4/4、35/35与strict0，无确认缺陷；未带入另行进行的宿主或Python物理路径增量。
- 50条中文完整保留、显式旧目标加最近49条、超长正文与emoji、隐藏固定ID资格复验、旧v2/r15冻结恢复及继续回复通过。冻结资料不得静默裁剪；来源删除和正文变化仍拒绝。
- 整个请求超限仍由官方service预算守卫在模型HTTP和调用回执创建前拒绝。取消近期独立上限不等于无限模型输入。
- 专用回复tokenizer草案及准备入口均已撤回；HF依赖继续供检索使用，package/lock未因本变更修改，本机缓存未删除。

仅使用随机合成资料和本机PG／模拟模型服务，无真实联系人、真实模型、打包或推送。本次验证不代替模型语义质量、App验收或全迁移切换。
