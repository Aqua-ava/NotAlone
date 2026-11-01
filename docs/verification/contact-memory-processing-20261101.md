# 联系人记忆处理状态验收（2026-11-01）

状态：实现、相关自动检查和实际热更新 App 验证已完成。

## 问题与范围

记忆页原来读取全局最近一轮与全局队列，切换联系人后仍显示同一份 0/8。现在按 [ADR-145](../../architecture/adr/145-contact-scoped-memory-processing-view.md)使用当前联系人的稳定身份读取独立状态，主卡在「对方／我」分类下都跟随顶部联系人。

认证只读入口 `GET /api/memory-processing/contacts/:contactId/current` 在同一 SQLite 事务中返回对应联系人、轮次和队列。旧多联系人轮次分别投影目标、任务、调用、候选及后续阶段，不计入本人任务或其他联系人的失败。没有对应记录返回空轮次；未选联系人不请求全局状态。来源撤销、未知回执、删除围栏和文档完整发布资格继续复验。

## 自动检查

- 后端五个相关文件共 50 项通过：`node --test test/sqlite-memory-http.test.mjs test/sqlite-memory-control.test.mjs test/sqlite-memory-documents-independent.test.mjs test/sqlite-memory-documents-schedule.test.mjs test/sqlite-memory-l1-scheduler.test.mjs`。覆盖同轮 A 失败／B 成功、各自最近轮次、无记录、跨 owner 拒绝、调用与后续队列隔离，以及完成后来源撤销。读取不增加模型调用。
- 桌面控制器 13 项、实际 React 页面 11 项、模式入口集成 6 项通过，使用 `node --test tests/fixed-memory-processing.test.mjs tests/fixed-memory-processing-view.test.mjs tests/memory-processing-entry.test.mjs`。最终分别复用已通过的控制器／入口结果，并完整重跑页面文件。覆盖范围校验、A→B 迟到响应、无选择提示、当前失败原因、旧错误不能覆盖撤销状态、模式切换与只读行为。
- 首条后端／控制器／页面隔离用例均先复现失败再修复。独立复核发现旧错误覆盖当前失效原因和残留全局队列文案，修复并补回归。组合桌面检查曾有一项仍期待旧文案；更新该断言后，页面文件 11 项完整通过。
- 后端和桌面 `pnpm run typecheck` 通过；`git diff --check` 通过。
- 本次新增的 7 处文档链接均有效。整份文档扫描另发现 `domain-data.md` 中一处既有 Python 路径缺失，已核对 HEAD 中原本存在，本轮未改动该链接。

## 实际 App

复用现有 `pnpm run dev` 热更新监督器与默认业务库，没有启动第二份或打包。Computer Use 实际打开记忆页并切换三个联系人，分别核对：0/8 来源核验失败、1/1 本轮已完成且未产生新记忆、暂无处理记录。返回原联系人后恢复其自己的进度；未选择联系人时显示选择提示。「对方／我」切换不把主卡改成全局本人任务。检查实际布局，文案和卡片显示正常。

本轮仅为核对状态而读取必要的联系人展示名、任务元数据和队列，没有读取聊天正文、修改业务资料、主动触发模型、恢复失败任务或发送外部消息。私人身份与截图没有写入仓库。测试临时目录由既有夹具回收；开发实例继续保留供用户使用，没有新增常驻服务。

## 限制

本轮修复处理状态的联系人归属，不改变来源核验失败本身，也不证明模型语义质量。历史手动初始化的独立页面入口仍待补齐；当前主卡保持只读，没有把整轮控制接口误用为单联系人动作。
