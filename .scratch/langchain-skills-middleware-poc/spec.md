# LangChain + SkillsMiddleware 最小兼容性 POC

Type: prototype
State: resolved
Triage: ready-for-agent
Branch: `codex/skills-middleware-poc`

## 唯一问题

在不引入完整 `create_deep_agent` 的前提下，当前官方版本的 LangChain
`create_agent` 能否组合 Deep Agents `SkillsMiddleware`，并保留 NotAlone 的
联系人隔离、一次最多一个 Skill、结构化候选和手动发送边界？

## 固定版本

- Python 3.12
- `langchain==1.3.15`
- `deepagents==0.7.6`
- `langgraph==1.2.11`
- `pydantic==2.13.4`

这些版本来自 2026-08-16 的官方 PyPI 元数据，并已与当前 API 签名核对。
POC 依赖只安装在本工作树的 `.venv`，不修改产品 `pyproject.toml`。

## 验收

1. `create_agent` 直接组合 `SkillsMiddleware` 和 NotAlone 定制提示词。
2. 目录和 `read_file` 同时绑定 `owner_id + contact_id + skill_library_revision`。
3. 同一轮最多读取一个已启用 Skill，路径遍历、跨联系人和禁用 Skill 被拒绝。
4. 只注册 `read_file` 和结构化输出 Tool；没有发送、写文件、Shell、网络安装或 Subagent。
5. 联系人或目录修订变化时，Agent 缓存键和逻辑 thread namespace 同时变化。

## 数据边界

只使用代码内合成联系人、合成消息和合成 Skill，不读取 `chat_exports/`，不连接真实模型、
数据库、日历、网络搜索或外部聊天应用。

## 结果

结论：**通过，但仅限兼容性 POC。** 锁定版本下，`create_agent` 可以直接组合
`SkillsMiddleware`、NotAlone 的 scope-aware backend、受控 `read_file` 和
`ToolStrategy`。没有调用 `create_deep_agent`，也没有注册发送、写文件、Shell、
网络安装或 Subagent Tool。

实际发现：

1. `SkillsMiddleware` 只替代目录扫描、frontmatter 元数据解析和提示词注入；
   NotAlone 仍需实现 `SkillPort`、scope-bound backend、受控 `read_file`、版本校验和候选校验。
2. middleware 的 backend 在构造时固定，因此 POC 按
   `owner_id + contact_id + skill_library_revision` 编译/缓存 Agent，并把同一组三元组
   加入逻辑 thread namespace。
3. POC 不启用 LangGraph checkpointer。它由应用层为同一窗口只保存“用户请求 + 未发送候选”，
   每轮重新扫描小型 Skill 目录；完整 Skill `ToolMessage` 和 Agent Tool trace 不进入下一轮。
   这是为了避免上一轮 Skill 正文绕过“每轮最多一个 Skill”的限制。
4. scope-aware backend 和 `read_file` 都会再次核验 `SkillPort` 返回记录的 scope/path/status；
   即使未来数据库 adapter 漏写范围条件，也会 fail closed。
5. 同一逻辑 thread 的调用会串行执行，避免并发请求从同一段历史分叉。

实现量：POC 主模块 456 行，合成测试 335 行。这里包含完整的隔离、缓存、多轮和
失败路径示例，不代表正式实现必须原样复制；真正由 Deep Agents 省掉的是目录扫描和
元数据提示词装配，不是 NotAlone 的业务权限代码。

已运行：

```bash
.venv/bin/python -m unittest discover \
  -s .scratch/langchain-skills-middleware-poc/prototype -p 'test_*.py' -v
conda run -n NotAlone python -m unittest discover -s tests/unit -v
.venv/bin/python -m pip check
```

结果分别为 6 个 POC 测试通过、36 个原有单元测试通过、依赖一致性通过。

## 未证明

本 POC 没有连接 PostgreSQL、真实模型供应商、正式 `RetrievalPort`、桌面窗口、日历、
网络搜索、Todo 或上下文压缩，也没有做性能和隐私出站验证。因此它不能作为产品功能
已完成的证据；当前精简线程记录也没有实现长度上限、压缩、进程重启恢复或 durable
checkpoint。下一步正式纵切仍应从 `src/notalone/reply/` 和 `src/notalone/skills/`
的框架无关契约开始。
