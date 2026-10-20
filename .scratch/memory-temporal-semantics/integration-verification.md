# 记忆时间语义集成验证

最终评审基线：`dacf658b`（包含统一记忆列表及用户后续界面改动）；早期回归对照基线为 `c4c86ac3`。集成分支：`codex/memory-temporal-semantics`。仅合成资料、隔离 PostgreSQL 和受控模型；未对真实聊天重提取，未连接业务数据库执行迁移，未发送外部消息。

## 已完成的联合检查

- 票02／03集成 `49d0a5e4`：20项后端联合验证、14项桌面日期／条件／时态验证与类型检查通过。具体覆盖和命令见各票 Answer、`test_memory_temporal_combination.py`。
- 原生界面：票01和票02／03均经实际 `npm run dev` + Computer Use 验收；操作、范围、限制和清理回执见 [原生验收记录](native-verification.md)。没有把 HTTP 或无头页面通过当作原生验收。
- 在 `56fa35cc` 执行 `cd desktop && npm test`：类型检查通过，213项安全检查中212通过，1项失败。该命令不启动正式 App；原生验收独立记录。
- 失败是 `tests/development.test.mjs:111`：测试请求根目录 `.env` 并固定期待403。隔离工作树没有 `.env` 时，Vite回退页面返回200。相同测试及开发服务文件与基线逐字一致；将基线 `c4c86ac3` 导出至临时目录，复现同一失败。基线和集成各自临时添加仅注释的合成 `.env` 后，该单例均通过，随后移除该文件。未修改真实配置或把原始全量结果写成全部通过。

复现单例：`cd desktop && node --test --test-name-pattern='开发命令提供受认证的本机 Vite' tests/development.test.mjs`。

## 票04首轮集成检查

- `c177e661`：后端单元测试2357项全部通过（73.663秒）。日志 `/tmp/notalone-temporal-final-unit.log`。
- 相同版本的15个相关持久化／HTTP模块159项中157项通过；两项 `test_memory_event_updates.MemoryEventHistoricalReviewHttpTest.test_{contact,self}_same_claim_with_changed_window_is_not_an_original_claim_replay` 失败。两项均在导出的真实 `c4c86ac3` 源码、测试和迁移上复现，未弱化断言。主测试数据库清理后确认不存在。日志 `/tmp/notalone-temporal-related-backend.log`、`/tmp/notalone-window-fixed-baseline.log`。
- 桌面时间、条件、变化依据、冻结依据及概览相关10模块97项：94通过、1跳过、2失败。其中真实HTTP用例因首次未设置 Conda 环境而失败，补齐项目要求的环境后通过。另一项本人修正测试在导出的 `dacf658b` 单例复现：夹具只模拟 `/api/memories/owner`，旧入口实际读取联系人路径，导致目标事实缺失；未修改或弱化断言。日志 `/tmp/notalone-owner-correct-integration.log`、`/tmp/notalone-owner-correct-baseline.log`。
- 实际 React 条件／变化页面及上述 HTTP 修复环境后的联合检查13项：12通过、1既有跳过、0失败。日志 `/tmp/notalone-temporal-final-desktop-react.log`。该项不代替原生 App 验收。
- 在 `4d470703` 执行隔离后端全量验证达到600秒上限，**没有完整通过结果**。主数据库已删除。另行拆分评估模块93项中90通过、3项有界 worker 夹具清理错误；残留 trace event 和重复删除报错均在 `c4c86ac3` 复现。两个后续诊断数据库按确切身份清理；早期失败夹具未记录各自子数据库名称，无法证明这些合成子数据库均已清理，因此没有按相似名称批量删除。日志 `/tmp/notalone-temporal-pre04-backend.log`、`/tmp/notalone-temporal-evaluation-diagnosis.log`、`/tmp/notalone-bounded-baseline-diagnosis.log`。

## 最终修复与增量验证

- 稳定代码 `b3c50133`，合入集成为 `64a32e08`；验证记录 `71bbaf79` 合入为 `d5451b83`。修复未知关系误采纳、动态冲突投影导致原版本摘要不匹配、本人模型外发来源ID、提前安排被拒、相同条件的新证据被误判变化。附带覆盖无发生日期的取消、更早取消不能覆盖较新计划，以及旧人工资料无聊天来源时任务成功但候选待确认。
- 最终增量：时间线／合并／回复公开模块25项，事件公开测试33项，相关单元及全部迁移安装重放84项，桌面5项与类型检查均通过。命令、阶段红绿及限制见 [票04验证](ticket04-verification.md)。094／095没有重写，未增加不必要的096。
- Standards 独立复评：原三项 P1 均修复，无新增阻断。36项 adoption／trace transport 单元及纯内存门禁／摘要／白名单检查通过。缺裁决器的兼容注入路径未见正式入口可达。剩余非阻断建议是将 `proof: dict`、`stored_evolution: object` 后续类型化。
- Spec 独立复评：原两项 P2 均修复，无新增问题；五项生产函数断言覆盖提前改期、后续取消、旧取消拦截、条件证据更换及真实条件变化仍需核验。
- `64a32e08` 已通过实际 `npm run dev` + Computer Use 时间线验收：旧事实与待确认候选均显示矛盾，各自原话、来源日期与保存时间分开。正常退出，精确自有开发进程均停止，原生夹具数据库确认删除，临时 user-data 清理。详见 [原生验收](native-verification.md)。

最终代码和文档交付于独立集成工作树，本地提交；原工作区及业务数据库没有切换。本次没有 push、PR、打包或外部消息。

受控模型测试证明接口、数据链路和保护条件按测试输入工作，不证明真实模型对各种中文表达的判断质量。
