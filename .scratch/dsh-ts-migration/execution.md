# 全迁移执行交接
2026-10-23授权全部任务持续执行、目标模式及独立会话并行；2026-10-24用户重申必须并行：依赖满足、文件及运行资源不冲突者直接并行推进，不逐次询问，后续交接沿用；依赖未满足者继续等待。
主目标：完成02—26的实现、逐票验收、兼容切换与退役；01已在 `10135184` 验收。2026-10-24用户明确废除ECNU，不再要求兼容，其余条件不变；先备妥实例再提最少验收配合，见provider-scope-update.md。
入口：[规格](spec.md)、[依赖索引](planning.md)、[01基线](baseline/README.md)。

## 当前执行责任

| 会话 | 职责与独占写入范围 | 当前阶段 |
| --- | --- | --- |
| 主会话 | 总目标、依赖调度、planning及整合验收；不重复实现子会话模块 | 持续协调02—26 |
| 05回复与模型会话 | reply/retrieval/model模块及测试、05证据 | claimed；cc263095宿主与恢复接线已验，真实回复质量/最终切换待验 |
| 06Skill会话 | skill模块及测试、06证据 | 票resolved；根完成宿主、来源C、官方profile与实际App签收，原受限子目标不恢复 |
| 09记忆偏好会话 | memory/preference及共用managed-update-backups，限定04时间/版本scope参数化 | 票resolved；根完成闭包、官方宿主与实际App签收 |

18已签收b4276969/9a5f6cf0，108为db1d9cbd；58TS/22Python/32UI、双轴及两轮合成App通过，工具准备原任务保持open。
04已在f4acc05d/2dd9ad4a验收；05、06、09合同审计已归档，18独立审计已归档于wechat-scope/contract-audit.md；05/06/09/18已分别派发目标实现会话。
子会话只提交自己任务文件，不夹带主调度或他人文件；独立审计交主会话收录。Git索引操作串行，避免交叉提交。
共享合成PG /tmp/notalone-dsh-migration-pg-20261024仍运行，主会话最终清理；官方源码恢复及资源见runtime-validation/recovery-20261024.md。

## 后续调度

02—04、09、18已验收；05/06独占各自领域，09既有成果已由根整合；19增量同步与21前台定位已开独立目标会话并核验active，各先查锁定官方源码。
09分层503修复已过37后端/7Python及双轴；21已接线并短占host/app，根09+21官方HTTP联合8/8。恢复后09/21/19已串行完成合成实际App验收，根分别核验stopped/pids空；证据见app-resumption-20261024.md。
06独立交接/RPC已提交f56bd0be；根在05端口提交后整合既有09/21成果：memory323b5972（19/19）、preferenceacfcc5e0（13/13）、21领域ee2b0a33（串行20/20），各隔离tsc/双轴/scan通过。109删除抑制及19组件已归档，整票仍待宿主最终验证。
主目标与05现active且无已知额度阻碍；05三依赖端口2546d21d已归档（隔离9/9、双轴0、扫描0）。06/09仍usageLimited，19/21仍blocked，其会话不执行；主目标继续整合已交接成果，不改子目标或重建。05完整验收后才解锁23。
24等待17、20、21、22、23，25等待24，26等待25；不把预先写空壳当依赖完成。
自动删除抑制窄前置已开独立目标会话，票auto-read-deletion/issues/01-durable-guard.md，109/Python已在7f4a1729提交，TS独立模块998ec226、Python移交cb0b17b0已归档；窄票d2698519已resolved且goal complete；109归此修复，05未落盘台账顺延110，取代此前预留。根持久恢复单例1/1与移交端口15/15已记录。
共享8覆盖的verify-integrated-host.py最终官方13/13、隔离tsc0及Python36/36。Spec已知回执误suspend已修并实测；合成CLI首次exec超250ms用有界准备修复，产品预算不改。见integrated-host-validation.md；实际App复核通过并清理，见integrated-app-validation.md；09票已resolved，子目标未改，05台账/装配仍待验。 19时间边界a268f206：29/29+官方焦点1/1+tsc；真实单私聊新消息验收已做开关/退出/同库重启并清理，暂无新消息；21真实OCR与纯合成均卡ANE编译，保持未签收；历史提示缓存回执c9cc31cb已修：专项2/2、相关16例与真实开发App合成CUA通过并清理。见real-wechat-acceptance-20261024.md。

## 不可丢失的执行约束

先查锁定DSH官方文档、源码与示例；01候选为`687f282e8625c6b8d11ff58211a90524be2e4317`，02须证明实际制品对应并锁全闭包。
必须实际运行官方profile与裁剪后的有效插件树；假provider只替换外部模型，不能自己造假Harness。
普通TS业务与DSH共后台，Electron独立；不保留永久Python桥，不擅改DSH核心。
无额外会话上传、包清单上传、长期JSONL、压缩摘要或无关Shell工具；用实际请求及文件观察验证。
原PG身份、资料、用户修改/删除和来源保持；测试只用合成独立库；真实业务迁移不在无明确数据范围下执行。
日常只`npm run dev`，先检查复用实例；禁止打包/打包版、push/PR及未经指定的外部聊天发送。
真实模型在本地确定性验证后安排：先固定材料、供应商与累计预算，不使用私人聊天或绕过计数；大批预算不得由“全部任务”推断成无上限。
真实App/微信验收按工程规则主动执行，操作占用由一个负责人协调，合成/模型/原生证据分开报告。
只在真实架构冲突或需要未授权高风险动作时返回决策，其他可执行工作继续。

## 当前生产宿主与离线对照进度（2026-10-24）

cc263095已整合唯一模型宿主、原SDK物理许可、已知终态ACK未知保护和正常DSH入口的跨模式恢复门禁；根最小1→相关42、strict0及SDK/profile/公开链14/14，实际npm run dev默认无模型正常导航/退出与隔离资源清理完成。默认仍Python，不等于最终TS切换。原材料上下文28×3×2=168/168通过且独立核原UUID/全文/来源/作者/微秒。

当前接收6路径离线来源/完整输出报告及计时修复：根最小4/4→相关97/97→strict0，独立0finding；来源缺失/多attempt/时序未知保留未定，两认证始终false。详见comparison-root-integration/validation.md。实际paired collector跨臂累计预算、配置等价、真实供应商固定材料/预算与完整输出盲评仍待，05保持claimed。06既有模块整合审计并行进行，不恢复受限子目标。

## 06 根签收（2026-10-24）

既有普通 Skill 模块与移交门经最终 12 路径装配完成：单一 TS 管理、原来源 C、官方逐轮只读 scope，默认 Python 回复不变。根固定基线 RED→最小 1/1→相关 41/41、Python 21/21、provider／PG 端口 14/14、strict 0；双轴和五项覆盖核对无阻碍。实际 npm run dev 经原 API 操作、CUA 核对 v1／正文／启停／删除，正常退出并清理合成资源。原 artifact 两文件碰撞单列；详见 skill-host-root-acceptance/validation.md。06 resolved，07 仍等 05；不签其他票或最终切换，不恢复受限子目标。

## 显式 TS 未配置管理能力（2026-10-24）

根组合 Core＋TaskHost＋已签 Skill，26 路径；缺 key／owner 时保留真实共享 ModelHost、恢复和管理接口，生成明确 unconfigured，删除五步继续，模型动作写前拒绝。根最小 profile1→相关38／Python16→已配置 profile1／strict0；独立 core／TaskHost 0 finding。实际 App 两态及合成本人初始化的原完整重启通过并清理；一度 fixture 禁读刚保存配置的失败保留原证据，经单变量红绿及实际复验仅修 fixture。详见 ts-controlplane-root-acceptance/validation.md。默认 Python、schema111及其余依赖票不变，不把此切片算 05／22／24 完成。

## 05 离线盲评工具组件（2026-10-24）

冻结5个正式路径f0983fe6在基线43ae208f应用，根最小1/1→相关26/26；实际CLI实产2项、0700/0600、拒绝覆盖且原文件不变、缺参提示和临时清理通过。来源与完整语义保留，身份仅私有绑定；外模/DB/App/微信0。详见reply-blind-root-acceptance/validation.md，manifest 2dafb60854794789ba59cceb106b07fb189d16edb50f4252920c8a47465aefa2。仅组件通过，当前只支持本机假供应商采集，语义评审0、真实质量/切换false，05保持claimed。

## 19 根最终签收（2026-10-24）

原26原子矩阵24项已有具名分级证据，补齐官方profile下D5自然code7退避重开与D6带数据launcher父丢失同库恢复。独立原始/归档/当前源及清理核对0产品问题/0新增阻塞；原始RED保留，不改产品。根核运行源无漂移及最终制品/review摘要，复用既有真实微信正向，不再发消息、不重跑已绿矩阵。selected/new-only直接补证与既有all_private/非空排除/109组合，不能扩大为真实Electron崩溃或20追赶。详见incremental-root-final-acceptance/validation.md。19 resolved，原blocked子目标未改；20仍等10，21及最终切换未签。

## 19 永久回归：带数据父丢失（2026-10-24）

只新增parent-loss测试及专属helper，冻结patch ebf33403；根主树最小1/1、0skip、10.04秒，原同库/路径自然恢复与UUID/来源/receipt保持，全部自有资源清理、模型0。独立审查本对无阻碍，reconnect夹具失败清理P2由独立角色修，不夹带接收。详见incremental-parent-loss-root-acceptance/validation.md；不扩大19原签收或20/App崩溃范围。

## 19 永久回归：自然重连及失败清理（2026-10-24）

根精确接收两个reconnect专属测试路径；先完整fixture纯seam6/6，再主树真实官方profile/Legacy/PG两case2/2、0skip。自然code7后5122ms重连、metadata cursor接续、消息2/复用4、关闭停读和正常退出均通过；真实active=1原断言/缓存错误保留且清理完成。原两轮清理P2保留、最后独立delta0，未知退出不强删活库；该极端启动失败仅纯seam覆盖，不冒称真实自然复现。自有库/目录/宿主清理0、无应急；模型/App/微信0，详见incremental-reconnect-root-acceptance/validation.md。19状态与parent-loss既有证据不改。
