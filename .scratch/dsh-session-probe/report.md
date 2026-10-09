# DSH 与现有运行时：持续会话小验证

日期：2026-10-09。结论：**仅为当前持续会话需求，优先在现有 LangChain 运行时上补会话存储，暂不迁移 DSH。** 这是隔离实验的选型建议，不是产品已经实现持续会话的声明。

## 实测结果

两边运行真实框架，模型由同一个本机合成服务模拟：根据收到的历史返回标记和轮数。LangChain 使用 OpenAI 协议，DSH 使用 Messages 协议。没有调用真实模型，没有评价回复质量或工具推理能力。

| 场景 | LangChain + SQLite checkpointer | DSH sdk-minimal |
|---|---|---|
| 同一会话第二轮携带首轮内容 | 通过 | 通过 |
| 两个联系人使用不同会话标识 | 通过 | 通过 |
| 同一联系人新开会话为空 | 通过 | 通过 |
| 退出运行时后，用相同标识恢复讨论 | 通过 | 失败：`session "probe-contact-a-chat-1" already exists` |
| 一个会话等待时，另一个会话生成 | 通过 | 本次未测 |
| 取消旧生成，再生成新答案 | 通过，旧答案未写入状态 | SDK 此版本没有单会话取消方法，未运行此项 |

DSH 的失败限定于 npm `0.2.0-rc.2` 的 `sdk-minimal` JSON-RPC 入口。已安装的 `dsh-sdk-jsonrpc-server/lib/index.js` 中，`handleRequest` 仅接收 `initialize`、`session/prompt`、`shutdown`；`createSession` 调用 agents.create。不能由此推断 DSH 内核或其他协议不能恢复、取消。

DSH 会产生包含用户消息、模型回复、轮次和事件序号的轨迹。它对追踪运行过程有价值，但用户选择哪个候选、怎样编辑、删除如何关联，仍然需要 NotAlone 自己记录。LangChain 的 checkpoint 也不能直接替代这套产品记录。两者都不能靠换一个 session/thread ID 就完成联系人授权隔离。

## 接入含义

当前产品每次构建 Agent 且没有接持久 checkpointer。实验说明已安装框架可以补上持续上下文，不需要先更换底座。生产实现仍需把会话归属、最新指令、候选版本、旧结果失效和删除规则接到产品服务；本实验没有修改这些正式代码。

DSH 提供运行事件和插件组合，但当前最小发布入口仍有恢复障碍和取消接口缺口；Python 后端还需管理 Node 子进程与 RPC。安装 CLI 本次新增 540 个 npm 包，这只是安装观测，不代表全部模块都会运行。为会话续接付出这些额外适配成本，当前尚未看到足够收益。

## 环境与边界

- 已安装版本：langchain 1.3.15、langgraph 1.2.11、langgraph-checkpoint 4.2.0；实验新增 langgraph-checkpoint-sqlite 3.0.3、aiosqlite 0.21.0、sqlite-vec 0.1.6，仅安装到临时目录。
- DSH：`@deepseek-ai/dsh@0.2.0-rc.2`；npm 使用 `--ignore-scripts`。查询 PyPI 未找到可安装的 `deepseek-harness-sdk`，因此直接使用已发布运行时的 stdio 协议。
- 独立 `DSH_HOME`、工作目录和 SQLite 文件；不读取仓库 `.env`、联系人资料、业务数据库或个人 DSH 会话。模型地址仅为 localhost，凭据是固定假值。
- 禁用了 persistent-bash、persistent-pwsh、session-log-deepseek、plugin-package-inventory-deepseek；模型模拟服务拒绝包含工具的请求。未启用压缩。
- 未运行桌面 App、真实微信集成或真实模型；不证明超长上下文质量、生产并发、崩溃恢复、来源删除或多租户授权。
- 取消验证针对主动取消协程和随后状态，不包括进程突然崩溃以及 UI 迟到事件；正式产品仍需 generation ID 防止旧结果覆盖。

## 复跑

在仓库根目录，使用新的临时目录；每个输出目录必须不存在。第一次 npm 安装可能需要数分钟。

```sh
source /Users/local-user/miniconda3/etc/profile.d/conda.sh
conda activate NotAlone
probe_dir=$(mktemp -d /tmp/notalone-session-probe.XXXXXX)
python -m pip install --index-url https://pypi.org/simple --target "$probe_dir/python" --no-deps langgraph-checkpoint-sqlite==3.0.3 aiosqlite==0.21.0 sqlite-vec==0.1.6
npm install --prefix "$probe_dir" --ignore-scripts --no-audit --no-fund @deepseek-ai/dsh@0.2.0-rc.2
PYTHONPATH="$probe_dir/python" python .scratch/dsh-session-probe/probe.py --root "$probe_dir/langchain"
python .scratch/dsh-session-probe/dsh_probe.py --binary "$probe_dir/node_modules/.bin/dsh" --root "$probe_dir/dsh"
```

DSH 当前预期退出码为 1，并把恢复错误写入 `dsh-result.json`；LangChain 六项通过退出码为 0。每次复跑依赖树的传递版本可能变化，需核对结果中的版本。仓库保留 `results.json` 摘要；合成请求与完整事件在运行命令指定的临时输出目录。

## 一手依据

- [LangChain 短期记忆与 checkpointer](https://docs.langchain.com/oss/python/langchain/short-term-memory)
- [LangGraph 持久化记忆](https://docs.langchain.com/oss/python/langgraph/add-memory)
- [DSH Python SDK 文档](https://deepseek-harness.github.io/deepseek-harness/en/guide/python-sdk)
- [DSH 官方源码](https://github.com/deepseek-ai/deepseek-harness)：线上 master 与 npm 发布版本存在差异，本次结论以已安装源码和实测为准。

Context7 当前不可用，已改用官方文档和安装源码核对。暂不扩展自进化或经验提取，也不替代现有 ADR 与会话草图。
