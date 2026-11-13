# 第二次冻结：正式集成拆分基线

日期：2026-10-15（Asia/Taipei）。本轮已确认采用上轮推荐方案并形成正式拆分；S分叉库保留，不迁移、不清理。只写本目录，不合入main、不修改其他会话工作。

## 固定身份与比较

| 标记 | 完整提交 | 含义 |
| --- | --- | --- |
| W2 | `fd0c84820f69aa0b672cb4835813c8846a3a2037` | 本轮文档工作的起点；产品代码仍是原准备树基底 |
| M1 | `0eb10b4c7f46e70a585c0269c8e4c42b914d54ec` | 首轮报告的固定main，历史索引不改写 |
| M2 | `08c4d48e719353492f37620f4fb2aabd8710efc6` | 收尾复核后选定的最新main；正式票的产品基座 |
| S | `54e482a6ccfa8ca1ccc7e9dc34b0bfaf27fb1616` | 原15项工程成果签收点；S后修复继续排除 |
| R | `c30a4051345cccc698f286489d56489d4b14b49b` | 源第15项最终审查候选，范围边界保持原记录 |
| B | `b8938031109edf3305821a0d3419ee8c3d28d5ff` | M2/S共同基线 |

M2/S独有提交为77/137；B→M2为250路径，B→S仍439路径，并集649路径；双侧修改仍40路径/29源文件。M2迁移末号058、S末号067，001–057字节相同。规则六份与原仓库字节相同。以上由[baseline-v2.json](baseline-v2.json)、[提交](commit-index-v2.tsv)、[文件](file-index-v2.tsv)、[双侧路径](shared-paths-v2.tsv)及[迁移](migration-index-v2.tsv)索引固定。

本轮开始观察到main=`1ca63b67cd19adffff67d43bda966d7c3050a7ae`；核验期间先新增独立持续源提交3d8fc0f1，后被等价8407b98a取代并增加08c4d48e验收入口，正式发布前均已只读复核并生成最终M2索引。3d8与8407的tree同为 `14d130e8f90b170047177bdf4a03703b4cbeb24d`，后一次增量仅3个测试文件。中间身份保存在baseline-v2，不混作一次运行；最终冻结后main若继续前进，仅在实施前重新核对，不静默扩展本批。

首轮[报告](report.md)、baseline和无v2后缀索引保留原快照；最新规格与进度以[spec.md](spec.md)、[planning.md](planning.md)为准。实际实施前复核main；如果再次变化，明确选定新基线并审查增量，不能静默改成活动分支内容。

## M1→M2增量

共有 `9d90aa7c`、`1ca63b67`、`8407b98a`、`08c4d48e` 四提交，共16路径、870行增加/48行删除。[main-delta-v2.tsv](main-delta-v2.tsv)逐路径保存两侧blob。其中main装配入口已在原40双侧路径中，其余15路径不在B→S修改集合；没有新增SQL、业务模型/port、HTTP协议或package依赖，不增加U1–U15领域功能前置。ADR-057和macOS权限/错误记录新增持续源隔离说明，已按领域/工程路由读取。

| 内容与M2固定证据 | 集成保留要求 |
| --- | --- |
| `native/macos/Sources/NotAloneSyncCore/HeaderChangeDiagnostics.swift:48–86` | 显式环境开关=1才输出，固定枚举、单调耗时、最多32行且每行120字节；不记原始错误、名称、几何或像素 |
| `HeaderChangeSource.swift:29–49,112–130,195–230`（同目录） | 保留阶段、首帧、停止原因，55秒租期/60秒硬截止；stdout仍为固定changed/paused JSONL，诊断只到stderr |
| 同诊断文件`:60–74`与事件源`:201–207` | 已知公开错误分类适用于didStopWithError，未知域/码退化stream_error；startCapture抛错仍是阶段+operation_failed，不声称所有启动异常已分类 |
| `desktop/src/main/foreground/native-change-source.ts:69–73` | 正常产品仅传固定环境并忽略stderr；不默认开启诊断、不扩大收集。该文件未在本轮修改，但仍是接口边界 |
| `desktop/scripts/prepare-probe.mjs:13–18,55–68`、`native/macos/scripts/build_cli.sh:23–27` | 新诊断源加入完整18源构建快照、摘要及CLI核心库编译清单；不搬回旧17源产物冒充最新构建 |
| `desktop/src/main/backend/bundled-helpers.ts:107–132` | 完整18源清单、HeaderChange三文件成组、未知名拒绝及原完整17源manifest兼容均保留 |
| `native/macos/scripts/build_cli.sh:54–71`、`desktop/scripts/probe-runtime.mjs:88–133`与`prepare-probe-runtime.mjs:47–56` | 新构建必须有正式probe、独立header-change-source及共享dylib，摘要/manifest/搬运对应同一产物；两个固定签名identifier分开，签名identity仍取原显式配置或ad-hoc |
| `desktop/src/main/index.ts:56–58`与`backend/bundled-helpers.ts:29–32,89–103` | 持续源只解析当前有效Resources组，核摘要、执行权限、静态签名及固定identifier；缺项/冒充停用，不查外部probe兄弟路径或回退正式短probe |
| `desktop/tests/helpers/probe.test.mjs:86–129` | 新组缺项、声明/签名不符、短probe冒充helper拒绝；旧两文件组仅保留正式观察、持续源停用。旧运行组兼容不表示新构建可以省helper |

这些要求纳入正式15的main保护回归及对应共享装配变更，不新增领域迁移票。路径与签名identifier隔离不等于证书/签名identity或TCC责任归属认证。ADR中的三次独立路径对照是main来源记录，不能移作本集成候选包的同路径实机验收。诊断也不证明稳定事件覆盖、联系人身份或微信同步闭环。

## 正式依赖的补充事实

正式票采用传递约简，业务、接口与结构边分别说明，详见planning。

- 正式09学习需要04历史接口：S `persistence/skill_learning.py:373–398`使用 `historical=True`，M2原依赖验证只收当前active/有效期资料。不能通过删参数来丢失合法历史编辑。
- 正式09不能整体搬运最终S来历管理：S `persistence/skill_version_lineage.py:29–36`查询审核阶段才新增的review_origin及发布表。09先支持已安装本地包/草稿来历，11扩展审核来历，12–13扩展历史/政策，避免查询未建表或反向依赖。
- 正式02的最终S擦除实现另有后置升级hook（S `persistence/memory_correction.py:800–801`）；02先保留自身完整擦除，10再把升级工作接入原删除事务，不能为导入后续模块增加02→10反向边。
- 正式10升级的应用/持久化/世代/追踪在源7af7e083及S未见07导航或后续审核政策的直接调用；可以在09之后、11审核之前完整集成。共享最终装配逐块适配，不能为整文件复制制造假前置。
- 08不需要07作为产品前置；11审核也不必为最终S的可选navigation字段强加07前置。两者负责当前字段的严格合同，导航完整依赖由07提供、15验组合。
- 01建立显式新版本/修订识别和旧回执生命周期，后续票随新增字段扩展。不能一直标同一版本却静默补未知字段；运行中或终态未知任务先按原归属处理。

以上persistence缩写路径位于 `backend/src/notalone/`。本轮只读核验，没有运行这些分支。

## 新增验证说明

M2 `desktop/scripts/test-safe.mjs:3–4`调用 `desktop/tests/helpers/probe.test.mjs`；在macOS会实际swiftc/codesign自有源码快照而不执行产物。因此npm test应描述为类型、安全/调度及探针构建搬运验证，不能写成纯静态或无编译。旧17源兼容断言（probe组:150–155）是修改当前manifest的合成测试，不能据此认证旧二进制构建来历；新18源摘要、manifest及三文件运行组须属于同一实际产物。

未来相关入口包括原生HeaderChangeDiagnosticsTests合成组、探针18源/旧17源manifest及三文件/旧两文件解析组。旧显式诊断App用例仅注入NOTALONE_SYNC_PROBE/syncProbePath包装器，在独立helper后不能再据此控制或启用持续源；其空绑定/退出覆盖可保留，实际持续源路径与受控诊断捕获须在正式15另行核验，本轮不实现新钩子。用例默认跳过，未运行/skipped不算通过，identityCertified和streamCoverageCertified仍为false。本轮没有运行这些命令或启动App。

08c4d48e还新增正式单帧观察与真实CLI同步独立性的测试入口：`desktop/tests/real-sync-quit-fixture.ts:22–35,83–100`要求显式开关、当前包、私有范围文件、新审计基线及有限时段，拒绝旧前台凭据；旧入口仍默认unavailable probe。新增 `.test.mjs`不在test-safe显式清单，最后一方法启动受控合成Python，未来执行须激活NotAlone，但不执行server/CLI/probe/App。实际 `.spec.ts:49–51`默认skip，另行明确真实范围才可运行；只涵盖微信/助手/Finder三个阶段的正式单帧观察与已确认单联系人CLI独立性及退出停读，不认证辅助持续流、持续外部焦点、联系人身份、新消息到达或双联系人连续性。本轮只保留入口和范围，不运行。

## 决策落实与执行边界

用户已确认推荐方案：D1保留main历史，D2旧回执核终态后明确重新准备，D3使用版本化Grounded及事件适配。D4明确改为保留S分叉库，当前没有分叉转换/清理任务。这里记录已作出的选择，不再要求重复确认。

本轮完成标准为：固定M2事实可复算、正式spec和15张独立任务、真实阻塞图、字段/链接检查、独立只读审查及本地文档提交。票全部open，无领取/代码/数据库/模型/桌面/迁移/远端动作；源15项仍保持S签收状态。
