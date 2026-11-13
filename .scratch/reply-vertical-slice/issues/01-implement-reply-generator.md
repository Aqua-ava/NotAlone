# 实现正式候选回复纵切

Type: task
State: resolved
Triage: ready-for-agent

## Goal

通过 `ReplyGenerator.generate()` 完成一次已确认联系人、已确认表达方向、可选回复 Skill
和结构化候选的合成纵切，并确保候选不会自动发送。

## Acceptance

1. 测试只跨越确认的 `ReplyGenerator.generate()` public seam。
2. `notalone.skills` 独立于回复运行时和 LangChain。
3. 框架 adapter 使用已锁定的当前接口，且不暴露框架类型。
4. 失败时不返回或持久化未经校验的候选。
5. 完成最小相关验证并创建本地提交，不 push。

## Comments

- 2026-08-16：用户确认唯一 public seam，并确认联系人验证由 Module 内部完成。

## Answer

已完成 `ReplyGenerator.generate()` 正式 seam、独立 Skill Module、LangChain/Deep Agents
adapter 和合成纵切。测试覆盖联系人/证据/旧候选/Skill 目录与版本隔离、最多一个
Skill、恶意能力声明不扩权、引用和持久化返回校验、多轮不继承旧 Skill 正文，以及底层
错误不泄漏。没有注册发送、Shell、写文件、安装或 Subagent Tool。

验证结果：17 个 reply 测试、3 个 Skill 测试、全部 56 个 unit tests、`pip check`、
`compileall` 和 `git diff --check` 均通过；独立复核未发现 P1/P2。
