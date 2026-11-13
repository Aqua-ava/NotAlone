# 说话人身份修复验收

日期：2026-10-21。基点 `9389d0f8`；主修复提交 `9440fcbb`，后续补齐历史工具顺序。

## 根因与实现

规范消息和检索结果保留了作者，但转成 `ContextEvidence` 时丢失，最终模型正文无法区别本人和联系人。仅交换两者身份，旧链路模型输入不变；这是确定性信息丢失，不能靠追加一句提示词解决。

- `speaker_role` 贯穿生成、工具证据、快照保存、读取、恢复、继续调整。
- `expression_actor=owner`、`recipient_role=contact` 明确候选方向；不把模型 API 的 user/assistant 当私聊作者。
- 已选消息统一按已知时间升序排列，未知时间置后，同时间不保证先后；保留原引用和入选集合。
- prepared schema 升至 14，旧准备要求重新准备；旧完成结果可查看，缺失身份保持 unknown，继续生成重新读取当前来源。
- 角色变化使上下文复验失败；最终保存事务对已声明角色再次核验并加锁到提交。

## 自动回归

新增行为逐项先失败再通过，包括仅交换作者、作者变更使旧上下文失效、工具保留作者、旧准备失效、连续本人发言、unknown/system 及工具返回顺序。

- 在 Conda NotAlone 环境、`backend/` 中运行 `python -m unittest tests.unit.reply.test_message_speaker_contract`：7 项通过。
- `python -m unittest discover -s tests/unit/reply -t .`：443 项通过。
- 隔离随机 `_test` PostgreSQL 库：`test_postgres_reply_store` 18 项、`test_postgres_reply_flow` 8 项、`AssistantContinuationHttpTest` 4 项、`AssistantGenerationPrepareHttpTest` 4 项，共 34 项通过；包含旧保存结果继续生成、准备后中断恢复、旧 schema 13 重新准备。库均已清理。
- `git diff --check` 通过；`node scripts/check_public_history.mjs --ref HEAD --working-tree` 检查无问题。

## 实际 App

复用 `npm run dev` 开发实例，通过 Computer Use 操作实际窗口，临时连接独立合成数据库和生产 HTTP 服务；只替换外部模型。未打包、未发微信消息。合成输入依次为：联系人质疑方案复杂；本人说先跑通最小流程；本人说能验证核心步骤即可。

1. 在联系人甲点击“帮我想想”，显示三条候选。捕获真实模型边界：角色依次 contact/owner/owner，主体 owner、接收者 contact，时间正序。
2. 隐藏并重新打开输入小窗，恢复原候选；模型调用数仍为 1。
3. “第一条简短一点”完成继续修改；调用数为 2，原消息身份不变。
4. 重启同一合成数据库上的后端，App 重新连接、重新确认联系人后恢复已保存候选；调用数仍为 2。
5. 恢复后“第二条简短一点”再次成功；调用数为 3，消息身份和候选主体仍完整。
6. 通过设置恢复原配置文件、握手、CLI 和探针路径，界面确认“已连接”。夹具退出码 0，清理回执 instance_ok/class_ok 均 true，database_remaining=false。

以上验证工程链路。脚本候选本身不作为模型语义质量证据。没有修改业务数据库中的原始聊天，也没有测试本任务未修改的微信读取、同步和去重。

## 真实模型合成语义验收

另使用生产 `build_deepseek_model` 和 `LangChainReplyRuntime` 调用官方 DeepSeek `deepseek-flash`。A 为上述三句角色，B 仅交换三个 speaker_role；实际出站请求差异核对确认其余字段完全一致。

- 2 次真实 HTTP 请求，均 200；供应商响应确认模型。max_retries=0，持久化单轮预算 2/2 已关闭，问题预算使用 2/8，不追加请求。
- A 候选延续本人立场，例如“我的想法是先砍到最小流程”；B 身份交换后才出现“那就按你说的来”。
- 独立 Agent 逐条审阅 6 条候选，本批均通过说话人和立场归属标准；不是用户人工验收。
- 无旧运行时真实模型对照，问题账 outcome=unknown；这只能证明定向小样本通过，不能宣称整体语义质量已量化改善或永不反转。

原始请求、候选、预算回执和逐项审阅保留在本机私有临时证据目录，未包含凭据、私人聊天，不提交原始运行载荷。

## 独立代码审查

- Standards：未发现硬性违例或实质设计异味。
- Spec：发现工具返回倒序与全局时间规则冲突的 P2；已补回归并修复，独立复审关闭。未发现其他确定性缺陷或范围扩张。

## 一手依据

- [LangChain messages](https://docs.langchain.com/oss/python/langchain/messages)：API 消息角色的语义边界。
- [OpenAI prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering)：明确指令、上下文和结构边界。
- [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create)：user/assistant 对话角色与内容契约。

外部文档支持表示和接口设计；本仓库根因由输入探针、代码和回归证明。
