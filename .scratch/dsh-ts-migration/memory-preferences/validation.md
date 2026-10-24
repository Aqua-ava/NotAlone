# 09 迁移验收记录

## 实现与边界

- 保留原UUID、来源、auto/manual、修订、CAS、操作键及删除墓碑；管理服务按owner/contact原锁序执行，提交前复验取消。
- MemoryService、PreferenceService由官方profile薄宿主装配；独立管理handoff先停收、排空、核验原schema，再切换唯一管理写者。Python提取/裁决等后台未移交，保留人工保护与原锁。
- 05助手、06Skill、09升级/备份删除闭包接真实端口；文件失败不报完成，重试不复活资料。
- HTTP仍为JSON数字；偏好bigint贯穿后端、桌面HTTP、原生IPC及React编辑。安全整数和浮点协议未扩大改变，修订号的浮点/指数形式保持拒绝。

## DSH查证

锁定0.2.1-rc.2，官方687f282e8625c6b8d11ff58211a90524be2e4317。核对profile-boot生命周期、agent setup/cancel/whenIdle/scoped dispose及sdk-minimal插件配置；普通CRUD不依赖模型或DSH直接业务API，不新增插件、工具或修改内核。实际集成测试通过launchDsh启动官方profile，未以假宿主替代。锁定源码依据：`apps/cli/src/profile-boot.ts:276-348`（启动失败与释放）、`packages/core/agent-loop/src/agent.ts:175,237`（cancel/whenIdle）、`packages/bundle/sdk-minimal/README.zh.md:12-51`（显式profile组合与插件边界）。

## 已完成验证

- 合成PG领域回归30/30：记忆service、候选、纠错保护、偏好与文件删除；含旧Python DTO逐字段对照及旧自动写晚到不能覆盖人工决定。
- 初版官方HTTP4/4：认证/隔离/1MiB/BigInt/CAS、在途取消排空、schema失败保持停收。
- 根独立复跑09官方HTTP与04 contact-context：16/16（根证据root-host-verification.md）。
- 桌面相关记忆回归54/54；修复偏好专属夹具108账本后完整偏好目录29/29，0跳过。
- 后端与桌面类型检查通过；共享HTTP原异步准备8/8。
- 双轴独立审查及桌面、宿主追加审查均零finding；分层修复追加Standards/Spec复核也均零finding。

- 最终后端09相关回归37/37，0跳过：`node --test test/memory-*.test.mjs test/preference-*.test.mjs`（13.03秒）；官方profile共5项，含缺失/旧缓存分支。
- Python新增分层handoff及原capture回归7/7；实际事务指纹、旧任务失效/迟到发布拒绝、owner/contact隔离、公开DTO白名单均通过。

## 实际App与Computer Use

只用隔离npm run dev；启动前dev:status stopped、磁盘可用149GiB。合成PG、两个同名合成联系人、CLI/probe不存在路径；无真实聊天/凭据/用户数据库、无外部模型或发送。

Computer Use在实际输入小窗展开偏好，读到9007199254740993，编辑并勾选明确长期保存后显示9007199254740994；删除后目录为空，数据库为deleted、正文null、revision9007199254740995。真实Electron contextBridge/IPC大修订号往返已通过。

记忆纠错正文已实际提交，但提交后的分层读回503，尚不计通过。最小官方profile用例确认旧layered读取被失效的overview缓存None；根已授权内部事务指纹修复，待回归和第二次App复验。公开dependency_ids缺失不是此缺陷，不公开内部字段或恢复旧Python投影写。

首次App已按自有用户目录正常退出；临时数据库、userData和诊断源码副本已清理，dev:status stopped,pids=[]。共享PG未停止，源码冻结已释放。

## 剩余

实际App复验已在下方最终记录完成；仍待05依赖归档、最终本地提交及公开历史检查。未push，未标resolved。

## 第二次App窗口结果

隔离开发实例成功就绪，但Computer Use返回Mac锁定、自动解锁失败，未执行UI。立即正常stop，108迁移账本检查通过，合成PG/userData/session均清理，dev:status为stopped且pids为空；不计为记忆复验通过。需用户解锁后重新协调短窗口。

提交另依赖05尚未归档的reply-assistant-erasure.ts及reply-assistant-erasure-sql.ts。09真实PG删除闭包测试通过，但不以09审查替代05端口审查，暂不提交不完整闭包。

## 最终实际App复验通过，立即释放桌面/冻结

- 正式窗口使用109合成夹具、独立userData和npm run dev；启动前后dev:status均stopped/pids=[]。没有产品源码修改、Git index使用、打包、真实模型或资料。
- CUA纠错后页面明确“资料操作已完成并重新核对。”，原版显示“已失效 · 不再引用”，新版正常展示，503不再发生。
- CUA查看新版依据：明确手动录入、没有模型提取的聊天依据。公开versions接口实际200返回两版，新版active/manual，原版invalidated/manual；DB supersedes_memory_id精确指向原UUID。未声称有独立版本详情UI。
- CUA确认删除合成资料，页面为空目录；DB两版均deleted，原正文均替换为“已删除的资料”占位。诊断断言原以为空/null而失败，核对代码后确认占位是既有合同，不是产品失败，未改代码。
- stop脚本正常退出exit 0，完成109原迁移账本核验和fixture.close；session/stop消失，合成PG/userData清理，最终dev:status stopped/pids=[]，本轮进程已退出。桌面验收已结束。
- 09验收已补齐，仍等待根归档05两个删除端口形成可提交闭包；没有stage或标resolved；当前桌面移交21，全局源码冻结继续，09保持停写。

## 主目标最终整合与签收

此前等待05端口与提交的状态已被更新：2546d21d端口、323b5972记忆、acfcc5e0偏好及0a0e29c7共享宿主均已归档；根隔离19/19、13/13及官方管理5/5（共享总13/13）与类型检查通过，新增两轴复核零待整改。最新实际App在独立已提交源码完成纠错、版本/概览回读和前台歧义门，见../integrated-app-validation.md；资源清理确认。结合本文件既有BigInt及删除实际验收，本票已由根逐项签收resolved，不修改子会话额度或目标。全迁移与真实微信OCR仍未完成。
