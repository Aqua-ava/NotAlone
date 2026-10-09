# 15：来源删除到不可检索

Type: task
State: claimed
Triage: ready-for-agent
Blocked by: 08, 12, 13
Spec: ../spec.md

## 交付行为

选择导入来源并确认删除，跟踪任务到不可检索，清理相关消息、记忆和候选依据。

覆盖规格用户故事：41。

## 验收条件

- [ ] 使用已有来源删除和后台任务契约，展示请求、执行、失败、重试及最终结果。
- [ ] 只有确定性不可检索验证完成才显示已删除，处理多来源引用，保留其他有效来源支持的资料。
- [ ] 两个窗口废弃相关正文和旧依据；另一联系人不依赖被删来源的资料/回复不受影响，共享本人资料造成的关联依据按既有契约失效；不宣称外部模型副本也已删除。

## 测试与范围

- 沿用规格中用户已确认的实际 App 操作与后端 HTTP 公共接缝；一次推进一个 red -> green 行为，自动验收与实现一起完成。
- 涉及业务数据时只使用合成资料、随机隔离 `_test` 库和独立握手/配置；本任务未涉及的后端、渠道与桌面能力保持后续任务范围。
- 来源 deleted 不是最终成功证明；核验原删除任务 succeeded 与最终 verify_not_retrievable 步骤 succeeded。专用 DELETE 路径不保证 task.progress SSE，需通过既有公开查询追踪真状态并验证两窗口失效，不新增事件假设。
- 按仓库工作流读取相关领域及工程约束，完成最小相关检查、Standards/Spec 两轴评审和只含本任务改动的本地提交。
- 不提交私人资料或凭据，不发送外部聊天消息；远端 Git 操作需另有用户明确同意。

## Comments

- 2026-10-09：开始任务15静态首片准备；核对来源 DELETE、持久删除任务与最终 verify_not_retrievable 双成功门禁。公开页面/真实隔离 HTTP 与 PG 为已批准接缝；当前运行权属于任务19，未启动资源、未产生 red/green。回复内存失效与共享宿主接线由 root 协调，任务保持 claimed、无 Answer。

- 2026-10-08：用户认可二十张任务的粒度和依赖，按 `to-tickets` 发布；尚未开始本任务。
- 2026-10-08：只读证据确认来源清除可影响同 owner 在另一联系人中引用该来源支持的本人资料；明确无关资料保留与相关依据失效的区别，并对齐持久任务最终校验门禁。现有 API 和删除范围不变，尚未开始实现或操作业务库。

- 2026-10-09（普通页面首片）：固定准备登记源 `c587156e640976ea52e220eec550b20846463a27` 受限 source-deletion-basic120秒实际 exit1；选定联系人、真实来源卡成功，删除按钮缺失点击30秒超时，属于公开产品 red。cleanupConfirmed true、单Chrome、quiet49 active/window0、10项 owned身份无存活、两租约 absent；精确库不存在已在夹具查询实际0后释放，但首red未保存库名artifact，不补造额外证据。源 `9441ad74bbff1eb4932f2f0413ac8299adb1226d` 接入具名管理接口/确认UI/原任务查询与有限轮询后，同受限入口实际 green1/1、exit0、cleanupConfirmed true、quiet11 active/window0、11项owned身份无存活、两租约 absent；本轮精确库查询0和准备exit0/后端认证退出证明另存 `15-basic-green-database.json`。两轮日志/资源/身份/收尾核验位于 `/tmp/notalone-app-context.p9MPie/15-{first-red,basic-green}-*`。类型/构建/diff通过，实际只用合成随机库，无App/原生/剪贴板/微信/外部模型。后续原任务失败恢复、多来源/共享本人引用、两窗正文/依据失效及迟到需逐条验证，首片不代表完整闭环；claimed、无Answer、验收未勾选。

- 2026-10-09（两窗来源失效首片）：固定 `46e365807434c51066e2cc9a0cd7d25034c4bd1e` 的 source-deletion-replies180秒实际 red，真实合成生成、编辑和 owner-memory 依据展开成功，删除最终验证完成后旧编辑仍可见。源 `0c25e8bd2016b820d5458bd88494c924c155c52d` 同场实际 green1/1、exit0；删除检查点立即隐藏公开正文/编辑/依据，404清除，200恢复同请求编辑，读取失败安全不可用并提供具名重试，草稿保留。red/green 均 cleanupConfirmed true、单Chrome、quiet15/10 active/window0、owned10/12身份无存活、精确随机库查询0、两leases absent。证据 `/tmp/notalone-app-context.p9MPie/15-replies-first-{red,green}-*`，green 全库数组另存 `15-replies-first-green-databases.json`。类型/构建/diff通过；未运行 App/原生/剪贴板/真实渠道。跨联系人共享本人依据、无关200保留、多来源和迟到仍待逐条验证，保持claimed、无Answer。

- 2026-10-09（跨联系人共享本人来源）：`5de493b` 初尝试定位到目录页按钮，乙生成未执行，安排失败不计产品red；gate自动释放并精确正常收尾。修正公开资料联系人选择器后 `b6d16a44b682bd6b3efc65afbc18955fc4a9a375` 实际red：乙已生成并展开甲来源支持的owner依据，甲原任务succeeded且乙依据404，但旧正文仍可见。`ab43003a426c82cab4f700aba5e39fe3d6c76e9f` 将已确认真实DELETE/有界原task跟踪与UI scope分离后，同场实际green1/1、exit0、cleanuptrue、单Chrome、quiet9 active/window0、owned10身份无存活、精确1库remaining0、双leasesabsent；证据 `/tmp/notalone-app-context.p9MPie/15-cross-{first-red,red-retry,green}-*`。类型/构建/diff通过，未运行原生App或外部模型；无关200保留及依据读取失败重试新场景仅静态准备，未登记、未运行。运行权在正常检查点返root，任务仍claimed、无Answer。
