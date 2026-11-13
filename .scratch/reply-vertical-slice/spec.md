# 正式候选回复纵切

Type: task
State: resolved
Triage: ready-for-agent
Branch: `codex/reply-vertical-slice`

## Public seam

```python
ReplyGenerator.generate(GenerateReply) -> ReplyOutcome
```

调用者只声明目标联系人、会话、输入内容和已确认表达方向。联系人验证、上下文、
Skill、Agent Loop、输出校验和持久化都隐藏在该 Module 内；公开类型不包含 LangChain、
LangGraph 或 Deep Agents 类型，也不存在发送消息方法。

## 本纵切范围

1. 建立框架无关的回复 Interface、确定性外壳和稳定错误。
2. 建立独立 `notalone.skills` Module 与 `SkillPort`。
3. 使用真实 `create_agent + SkillsMiddleware` adapter 和 scripted fake model 完成合成生成。
4. 验证 scope fail-closed、依据引用、最多一个 Skill、恶意 Skill 不扩权和精简线程记录。
5. 候选只有在持久化 adapter 成功后才返回。

## 不在本纵切

- PostgreSQL 回复/Skill schema 与生产 adapter。
- 真实模型供应商、出站台账或私密资料。
- 正式检索 Tool、方向建议、Todo、上下文压缩、日历、网络搜索和 UI。
- LangGraph checkpoint、暂停恢复或完整 Deep Agents harness。

## 验证

全部测试只使用匿名合成文本、scripted fake model 和内存持久化 adapter，不读取
`chat_exports/`。完成后记录实际测试数量、依赖版本和剩余风险。

## Answer

已实现框架无关的 `ReplyGenerator.generate()`、独立 `notalone.skills` Module 和真实
`create_agent + SkillsMiddleware` adapter。合成纵切会从绑定到
`owner_id + contact_id + skill_library_revision` 的目录发现 Skill，以受控 `read_file`
读取至多一个不可变版本，并返回已由 Store 持久化的结构化候选。

确定性外壳会再次核验请求、每条证据、上一轮未发送候选、Skill 目录/版本、引用和
持久化返回；跨联系人正文或目录元数据会在模型/目录发现前失败。上一轮只通过
`PreviousUnsentCandidate` 精简快照进入新请求，不保存 LangGraph checkpoint、Skill Tool
结果或完整正文。底层 Store、模型和框架异常统一转换为不含私密正文的公开错误。

直接依赖锁定为 `deepagents==0.7.6`、`langchain==1.3.15`、
`langchain-core==1.5.5` 和 `langgraph==1.2.11`。验证使用合成数据；真实模型、PostgreSQL
回复/Skill adapter、检索 Tool、Todo/上下文压缩和 UI 仍不在本纵切中。

最终验证：17 个 reply 测试、3 个独立 Skill 测试和全部 56 个 unit tests 通过；
`pip check`、`compileall` 与 `git diff --check` 通过。独立复核未发现 P1/P2。
