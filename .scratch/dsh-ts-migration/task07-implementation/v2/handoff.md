# 07 第二批冻结候选
状态：实现与合成验证交付，待根集成及实际 App 验收，07 仍 claimed。
base：`3e044a046f66dedf65120e664c2d9b1ee04ae112`（根 23 代码锚）
target：`a94a3d76d886227f96125744bc1ef71ec5492245`
补丁：`change.patch`；SHA256 `743cbf71e37e708c795ce3ee48a151252b643570647a344544930a86d9aed211`；33 个路径。
主补丁已包含第一批 07；应对未合入 07 的根 23 基线应用，不能再叠加 v1 补丁。
根 23 已在自有快照合入；保留新 ledger/settings/diagnostics 路由与 wiring。
根 10 未冻结候选的 /internal/extraction 不纳入本版；共享 host-plugin 入口需根后续精确合并。
v1 目录、SHA、原补丁保持不变；本版 before/target 文件及依赖 hash 见清单。
新增公开链覆盖 Skill/NoSkill、澄清、换组、取消排空、联系人隔离、直填和 50 条完整正文。
修复候选 auto/user 来历、兼容 B 完成标记、异常测试夹具资源清理；复审与实际 RED/GREEN 见清单。
正式宿主入口与根 23 组合验证的实际范围、命令和退出码另列清单，不能以服务夹具替代。
证据为逐项追加的阶梯验证；没有声称最终 target 一次跑完全部用例。
数据仅合成、自有 PG/临时目录；原始日志仓外私有，公开证据保留双 SHA 与失败事实。
没有主树/index/UI 修改，没有真实模型、聊天资料、外发、打包或 push。
根后续：按清单验补丁与依赖 → 合入后最小组合验证 → 按 desktop-acceptance.md 复用 npm run dev 验收。
根需将实际源 SHA、正式宿主与 App 进程、模型物理调用与清理结果留证后判断 resolved。
