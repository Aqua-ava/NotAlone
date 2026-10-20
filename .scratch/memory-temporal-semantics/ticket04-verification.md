# 票04实现与合成验证

实现分支 `codex/temporal-04`，首提交 `51436ae9`，无冲突合最新用户改动及前三票 `0a6b9019` 后为 `f07e3be6`。所有命令在隔离worktree运行，Python使用 Conda `NotAlone` 环境，`PYTHONPATH=$PWD/backend/src:$PWD/backend`，未读取真实聊天或运行业务迁移。

## 红绿切片

- 公开导入实际裁决输入最初缺新旧原话／日期／版本字段，统一DTO后通过，并精确保留 `+08:00` 原始当地日期。
- 较晚回忆早事的旧UPDATE原先覆盖现状；新增关系证明与确定性发生顺序门禁后保持旧状态、新候选待确认。故意返回supported的错误更早事件UPDATE仍被程序拒绝。
- 公开变化元数据最初缺失；候选、本人／联系人、回复冻结与页面合同贯通后通过。冲突进入旧事实实际生成输入；来源删除使恢复404，旧摘要不再遗漏冲突；历史补充不改变现状。
- 新早日期导入被实际处理、不能替换晚来源；重复同文件不增加模型调用或候选。条件变化不自动撤销原主张。
- 连续两次自动更新的fixture原来引用累计祖先而非当前直接来源；按实际DTO修复，并加强每次新版本确实发布的断言后，联系人／本人连续撤销均通过。
- 双父补充MERGE公开红例发现补取更早来源后窗口未排序；稳定按来源时间重排后，独立合并正文核验、三来源、重启和完整三版本历史通过。明确纠错及无proof合并待确认也通过。

## 已运行结果

- `python -m unittest tests.integration.server.test_memory_timeline tests.integration.server.test_memory_timeline_merge tests.integration.server.test_memory_evolution_reply` 加公开非法ADD/KEEP及无等价proof NOOP两例：19 tests，41.167秒，OK。
- `python -m unittest tests.unit.memory_extraction.test_adoption tests.unit.memory_extraction.test_command tests.unit.memory_extraction.test_automatic_memory tests.unit.memory_extraction.test_merge tests.unit.memory_extraction.test_trace_transport -v`：83 tests，OK。旧假runtime缺关系proof的UPDATE/MERGE断言改为保持旧事实待确认；SDK调用与台账trace断言保留。合法替代的正例由正式HTTP覆盖。
- 相关HTTP整模块初跑74 tests / 200.079秒：69通过，5失败。其中3个通用非法输出不应保留pending的问题已修并单例绿；另2个 changed_window 在集成与真正功能前 `c4c86ac3` 源码／测试／迁移独立导出均复现pending0≠1，保留原断言。
- 仓储merge指定8例通过：联系人重放、本人合并、无proof直接事务拒绝、人工保护、缺来源、父版本变化、故障回滚、删除父来源。合成proof由真实capture及候选／父版本摘要构成，只验证存储合同。
- 子Agent桌面相关47项及类型检查通过；回复单元相关79项与后续11项通过。整套桌面及原生开发App由主Agent统一复验。
- `git diff --check` 与 `node scripts/check_public_history.mjs --ref HEAD --working-tree` 通过。无真实模型质量结论。

- 首次独立关系核验台账断言为4调用仅3条记录而red；分离 `relation_verification` purpose及usage后，16项HTTP/trace/自动维护unit全绿。095仅扩展无正文调用回执purpose枚举；没有修改旧迁移或业务事实。

## 数据与剩余验收

094仅新增兼容可空列及未解决矛盾关联索引；旧记录和旧完成快照保持未知。无存量重解释。原生只允许 `npm run dev`，本票未启动App；主Agent持有合成fixture入口并负责原生与最终双轴评审。两条明确基线失败不改断言、不计为本票新通过。
