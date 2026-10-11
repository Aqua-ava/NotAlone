# 17 自动后端实现记录

本阶段仅完成后端退出协议、恢复投影、竞态裁定及正式 054 迁移。任务仍为 claimed；桌面真正退出的调用接线、受控宿主事件及公开页面组合链路尚待主会话继续。人工部分未执行，不勾选原任务验收项，不将 HTTP 或合成事件描述为真实 App 停止、重开已经通过。

## 接口与保存边界

- 新增 `POST /api/contacts/{contact_id}/assistant-sessions/{session_id}/interrupt`，JSON 严格只接受 `request_key`、`input_version_id`。返回实际五个生成身份字段及可空的 `interruption_reason`，不接收正文。
- 沿用 14 已提交的唯一普通／替换 prepare、共享 `AssistantGenerationReceipt` 和 A/C 原生成链。退出复用原 owner 事务、失效键和 C request/attempt writer；没有第二个模型入口、候选 writer 或恢复副本。
- 未完成请求持久化为 `failed` + `app_quit`，重读保留原用户输入、没有候选；同旧键 prepare/generate 明确拒绝，用户新键显式重试才可生成。读取不自动续跑。
- 退出复验实际 input ↔ turn ↔ request key、owner/contact/session、原绑定及未删除来源。只有 `app_quit` 终止可处理已经不再是 CURRENT 的旧 pending 请求；默认 `generation_replaced` 继续要求 CURRENT。退出不更新 CURRENT，不影响后来的独立输入或请求。
- C 已实际可靠保存的 `completed` 结果优先。唯一 A 完成关联复验同范围、实际旧绑定/key 和权威保存结果，并继续核验来源；后继 CURRENT 不会使它丢失，也不会被恢复回旧指针。
- GET turn 新增可空的 `interruption_reason`：只在 failed 中投影 app_quit；来源擦除仍返回无正文 redacted 占位，不显示中断正文。
- 真实 `054_assistant_generation_interruption.sql` 只给 turn 增加无正文分类列及约束，允许 app_quit 与 failed/redacted，保持既有状态集合。055 不属于本阶段快照或提交。

## 实际自动验证

预先确认的接缝为公开 HTTP → 正式应用／存储 → 隔离 PostgreSQL，只替换外部模型和实际保存后交付结果的有限等待。所有联系人、来源、消息和候选均为合成数据。

真实 red → green 记录：未启动 prepare 凭证退出原为 404（1F/0.924s）→ 1G/1.066s；C 已保存且 CURRENT 前进原为 409/input_version_stale（1F/1.040s）→ 1G/1.535s；已接受中断的网络重放遇新 CURRENT 原为 409（1F/1.080s）→ 1G/0.596s；实际旧 pending 已非 CURRENT 原为 409（1F/1.034s）→ 1G/1.039s。

8 个公开 HTTP 场景覆盖准备后退出、可靠保存先赢、运行中断和迟到响应、新键重试及重开零额外模型调用、已有中断重放、新后继输入、strict scope/身份/JSON、实际故障回滚，以及正式来源删除 Worker 与会话删除。回滚场景在实际 running C request/attempt/tomb 已写后令 A 退出分类写入失败，公开返回 503，所有失效写入回滚，原请求仍能完成。来源删除清理中断派生内容，保留无关独立输入；删除会话后 GET 与 interrupt 为 404，旧键不能恢复。

冻结源 `/private/tmp/notalone-a17-reviewed-candidate-lh5l83ic/source` 以正式 `9bef2c67e74e14d8db9bdca5dbcbf26fa6a0d2b0` 加 ONLY17 构建。执行：

```sh
source /Users/local-user/miniconda3/etc/profile.d/conda.sh
conda activate NotAlone
PGPORT=55441 python /private/tmp/notalone-coordinator-isolated-tests.py /private/tmp/notalone-a17-reviewed-candidate-lh5l83ic/source tests.integration.server.test_assistant_generation_lifecycle tests.integration.persistence.test_assistant_generation_lifecycle tests.integration.server.test_assistant_generation_prepare tests.integration.server.test_assistant_generation_replacement tests.integration.persistence.test_assistant_generation_replacement
```

结果为 **51G / 67.893s**：本阶段 8 HTTP + 3 迁移，原 14 的 16 prepare HTTP + 10 replace HTTP + 14 persistence。实际生产迁移 CLI 按真实 001–054 执行，账本逐项匹配 54、重复 applied=[]，外层随机测试库与三个升级／回滚场景自有内库均清理剩余 0。迁移场景验证新装、真实 053 升级保留旧记录、分类约束，以及账本写入失败时 DDL 一起回滚并重试真实 054。

5 个改动服务／存储模块 `mypy --follow-imports=skip` 通过；8 个相关 Python 文件 compileall 通过。HTTP 状态类型收尾后重复最小 8 HTTP 场景为 **8G / 10.781s**；最终局部状态变量改名后最小退出恢复及 strict scope 回归为 **2G / 1.659s**，两轮均真实 54/repeat0/自有库剩余0。完整 follow-imports 的 app 类型基线为 78 个既有错误：新接口最初增加 1 个 status 参数错误，改为 HTTPStatus 后曾因复用 status 局部变量增加 2 个赋值推断错误；最终使用专用 interruption_status/interruption_payload 后为 **78 → 78，新增0**，没有宣称整体类型检查绿色。

迟到响应的原 C lease 已失效，原生成器会记录稳定的无正文租约失败 traceback；测试验证此路径不会复活候选或覆盖新请求，未将它误报为有效完成。

## 剩余项

主会话正在修订的 14 actual C completed/B CURRENT metadata 反例不被本阶段补丁覆盖，使用独立修复提交交付。桌面 A16 job registry 的实际退出调用、B 已确认方向重新确认、新请求桥接、公开页面组合恢复及受控宿主退出尚未由本阶段验收。

用户本轮明确排除真实 App、微信、OCR、私人聊天资料与 19，因此真实 App 停止／重开和全部人工验收记录为未执行。无外部模型调用、外部聊天发送、push、发布或部署；未改变 ADR-044 的独立主动保存表达样本留存规则。

## 主会话复核与双轴审查

主会话在相同冻结源码重复本阶段 HTTP 与迁移两模块：**11G / 10.162s**，真实 001–054 账本匹配 54、重复 applied=[]、自有测试库剩余0；5 个相关服务／存储模块的局部类型检查通过。没有运行真实 App 或页面，不据此填充桌面受控生命周期验收。

### Standards

新鲜审查硬性违例 0。保留一项 P3 判断：生命周期和替换适配器存在绑定与来源校验形状重复；本切片保留明确边界校验，不为局部退出协议扩大重构范围。

### Spec

新鲜审查实现错误 0、范围外改动 0。桌面 A16 凭证注册与真正退出调用、B 重新确认、新请求桥接和页面组合恢复仍属未完成自动项；真实 App 停止／重开及人工部分本轮未执行。
