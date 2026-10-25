已完成窄修复，待 root 独立复核与实际 App 重验；未创建提交。
起始 pin：a102ae51548039f23a4a148fadb6cbe5a8bb9cc5；冻结 HEAD：d360cec17773e7cfa372f91c96fd60e6bb6c5015。
变更仅 3 文件：backend-ts/src/pure-ts-public-api.ts、backend-ts/test/pure-ts-reply.test.mjs、backend-ts/test/assistant-generation-publication.test.mjs。
根因：公开生成返回内部轮次，缺 session_id，候选嵌在 reply；桌面严格解码在完成复验前拒绝。
修复：公开完成响应投影为原顶层候选与归属 DTO；会话读取仍用原嵌套格式。
继续、替换、中断重试及探索的同类完成响应沿同一投影，保留各自恢复/继续元数据。
准备 202/status、取消、错误及未知结果不改判；没有自动再生成或放宽桌面校验。
RED：red-publication-1.tap、red-publication-2.tap、red-recovery.tap；均保存 completed/3 候选、1 次合成模型，却 generation_failed/unconfirmed。
最小 RED：red-minimal-2.tap（单候选亦复现）；探针 probe-public-dto-2.tap 仅改测试 DTO 即转绿。
原始未缩减复现修后通过：original-loop-green.tap；本轮真实模型调用为 0。
可重复单例：cd backend-ts && node --test --test-reporter=tap --test-name-pattern='纯 TS' test/assistant-generation-publication.test.mjs（通过）。
新增模块：cd backend-ts && node --test --test-reporter=tap test/assistant-generation-publication.test.mjs（5/5）。
覆盖：直接发布、零新增模型保存恢复、丢响应/错会话保持 unconfirmed、切换晚结果、202/status 原身份与 user_cancelled。
后端相关：cd backend-ts && node --test --test-reporter=tap --test-concurrency=2 test/pure-ts-reply.test.mjs test/assistant-generation-lifecycle.test.mjs test/assistant-generation-errors.test.mjs test/assistant-generation-explored.test.mjs（13/13）。
桌面相关：cd desktop && node --test --test-reporter=tap tests/assistant-generation-execution.test.mjs（11/11）。
类型检查：cd backend-ts && npm run typecheck；cd desktop && npm run typecheck（均 exit 0）。
git diff --check -- backend-ts/src/pure-ts-public-api.ts backend-ts/test/pure-ts-reply.test.mjs（exit 0）。
最终验证 Node v24.19.0；最初 node 不在 PATH、证据副本路径改写失败均保留，非产品 RED。
额外实验 green-publication-refined.tap 失败：复用含当前草稿的 ContactSession 构造第二控制器，历史当前候选为空；未据此扩改产品。
正式保存恢复回归使用原控制器显式 readSavedSession，匹配 root 观察接缝；其候选 ID 保持且模型仍为 1。
数据影响：仅公开结果格式；无 schema、历史、真实资料、凭据、模型账本及费用/质量结论变更。
root-observation.json 字节 SHA 与入场一致；原真实 3 候选、编辑 v1、unknown 和 used1/8 不变。
清理：所有本轮测试的宿主 terminate、DROP 自有合成库、rm 临时目录结束钩子通过；无 App/微信/打包/常驻进程。
原始证据已迁至仓库外 0700/0600 私有目录；仓库仅有脱敏副本，raw/public SHA 见 evidence-map.json。
历史 red-source-manifest.json 是路径修正前的记录；当前准确摘要以 freeze-manifest.json 和 evidence-map.json 为准。
未执行读取真实 .env 的全仓公开扫描；本目录与 3 个变更文件执行静态公开格式规则审计。
root 后续：只读恢复原保存结果（零重发），再按原预算新请求复验；桌面仍只 npm run dev，先核复用。
root 负责 index、集成、提交和实际 App 验收；未代签 25/26、真实质量、停止/直接回显或费用结论。
