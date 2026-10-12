# 生成完成回执竞态：实际诊断与修复（2026-10-13）

最终B组合在普通失败／同键恢复之后立即发起新生成时，出现会话拒绝。只保留HTTP状态与固定错误码的诊断复现：生成响应200→504→200，实际候选已显示，后续新生成却在prepare阶段被拒绝。没有把该失败归因为联系人授权，也没有放宽后端租约门禁。

## 修复与实跑

生产Main的同键恢复在实际完成、范围／连接／CURRENT／完成身份核验后，先发布ready，再等待候选版本读取及finally。此时GenerationJobs仍保留此前failed回执，新生成将已完成工作误当在途替换目标。现在沿原receiveReceipt接口在ready前写入核实的completed身份；finally仍负责finish，不提前结束工作，不绕过旧范围和发布保护。

公开合成测试使用生产bridge／JsonClient、真实HTTP与随机PG，只延迟实际候选版本GET返回。旧session.ts下新生成误走replace/prepare，单项RED（Node3.704845秒，driver3.848秒，受控模型2次）。修复后新项及原两项、15项准备身份测试合计18/18 GREEN，12.024632秒；三个HTTP场各受控模型3次，正式001–055／repeat0、自有库0。完整桌面typecheck及diff检查通过。证据位于`desktop/artifacts/goal-reply-completion-race-20261013/`，red.log／green.log／ownership-green.log保留失败与通过，不能代签供应商语义质量或App。

相关ownership三项检查原先2通过、1末断言失败（10.674秒）。独立子Agent仅将session.ts替换为6faaa6ba精确旧blob，其他源与原完整业务test字节不变，单变量基线仍同处失败：1 FAIL、driver4.813234秒、受控模型5次，App与供应商HTTP0。第一次外部副本重复import导致准备失败也保留，未启动夹具。该旧断言要求同拒绝键重读仍为generation_not_running，但[原17票](../assistant-session-context/issues/17-quit-and-interrupted-recovery.md)已要求首次事务拒绝提供not_reserved证明并封禁新键；同键再读严格为request_deleted。

仅校正末段到现行精确契约：原封键重读409/request_deleted及四字段证明；独立新nonce首次409/generation_not_running＋相同四字段证明，再读该nonce409/request_deleted＋证明。原running key、其他输入、会话全快照相等及模型总数5不变。只复跑这一原完整单项，1/1 GREEN、4.976310秒（method4.851003秒），55迁移／repeat0、instance/class清理true／精确库false。未接受任意409、删除原保护或改写模型Gold。独立基线来源与归属清理在仓库外`/private/tmp/notalone-ownership-baseline-20261013-390kq2hf/diagnosis.md`；Root结果为上述目录ownership-proof-plan.json／ownership-proof-green.log。

## 最终C包最小实际回归

官方package入口构建新C，包内Main包含上述修复；构建时HEAD71f9b7e加唯一生产session.ts工作区差异，精确SHA `ceab6b337a1399f059b68cdd2ae96961f926a49b1ffc065c627faba14cf229ca`。后继提交不改变该输入。构建不运行App／模型；计划与输出见`desktop/artifacts/goal-final-package-20261013-c-build/`。C路径`desktop/artifacts/goal-final-package-20261013-c/NotAlone-darwin-arm64/NotAlone.app`。

主Agent实际受限test:app：台北03:19:07.703–03:29:07.703预约、max1／actual1，原rewrite-failure全部断言1/1通过，9.5秒／报告9.8秒、driver10.648688秒、exit0。覆盖超时／同键恢复、普通失败及空候选硬拒绝、不丢编辑。使用真实App／生产Main与HTTP／PG，供应商模型仍为受控合成，不认证真人回复质量、微信或OCR。诊断仅写固定phase/error/reason、状态／自有归属，不写正文、联系人身份或原始视觉帧。

结果`desktop/artifacts/goal-rewrite-failure-replay-20261013-c/`包含场次预注册、280文件before、实际runner／terminal、owned-runtime与有限failure-observations、Root收尾。App／fixture PID及自有userData／fixture目录gone、精确随机库gone、共享租约absent，280文件哈希不变、deep strict静态通过。原既存无连接未知测试库仍单列且未删除，不从命名空间推定本轮归属。C ASAR为`bb68a80b9c5897ce78e128bf43377238f981fc411c1101a0cfb575afa6f1d685`；四helper、十一原生构建输入和9份notice已逐项核原manifest，但WCDB精确源／二进制许可两false不变。最终C整组及现场场次继续，不将B结果转写为C通过。

## 评审、数据边界与后续

两轴已独立审核五个代码／测试路径：Standards硬违规／新增重要Fowler0，Spec问题0；尤其核对strictproof／nonce与原保护未降。本页另做增量证据审核后独立本地提交。无DDL、迁移、联系人数据、默认自动放行、产品发送工具、供应商或秘密变更；受控模型计数与供应商真实HTTP分开。HTTP错误类型映射是独立主题，见[路由修复](goal-reply-error-http-20261013.md)。
