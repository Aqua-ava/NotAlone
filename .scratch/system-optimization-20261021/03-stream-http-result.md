# 03 事件流背压与 HTTP 资源约束结果

State: resolved
Triage: ready-for-agent

## 交付与基线

- 分支：`codex/optimize-stream-http`；工作树为本聊天附属的 `optimize-stream-http/NotAlone`，没有修改共享主仓产品文件。
- 固定基线：`681fcc38eab77c8fe149b76705419971f3750a86`；其产品代码对应合并后的 `abd65e6c54bf15e05de947b09bceb5f228925baa`。
- 产品提交：`98fdea55`（背压、HTTP 资源约束与回归）、`317ec9d5`（有界恢复提示与逐任务权威读取）。后续本地提交仅补本 issue、结果和合成证据。
- 已通过 `create_goal` 建立无预算目标，实施中以 `get_goal` 核验为 active；本 issue 完成后才 complete。

## 实际变更

1. `backend/src/notalone/wechat_cli/adapter.py`：SessionEventStream 最多保留 256 项元数据，生产者等消费者腾出位置；不合并、不静默丢事件。显式停止清空待消费元数据并唤醒生产者，关闭失败仍可重试回收。自然 EOF 要排空队列后才对协调器报告 closed，避免队尾在重连前被丢弃。
2. `backend/src/notalone/server/event_bus.py`：每订阅实时队列最多 256 项，溢出明确关闭并释放积压，不阻塞其他订阅。每 owner 恢复提示最多 256 项，以 contact、事件类型和 task_id 分键，按最后发布顺序恢复；单连接恢复提示与实时队列分别有界。关闭总线清空缓存与订阅。
3. `backend/src/notalone/server/app.py`、`http_limits.py`：先校验长度（保持 400/413 优先级），随后认证，未认证时不读正文。默认头部总预算 5 秒、已认证正文总预算 10 秒、写操作超时 5 秒、并发连接上限 32（含 SSE）。超额连接返回 503；零星字节不能续期总预算。已认证正文超时返回 408，提前 EOF 返回 400，均不分发部分正文。413 保留 0.1 秒有界排空。关闭宿主主动 shutdown 本宿主的活动 socket。
4. SSE 声明 `X-NotAlone-Event-Replay: bounded-hints`。恢复提示不是消息历史、完整任务目录或可靠游标；各任务通过原 `owner_id + contact_id + task_id` 状态接口核对，消息通过原列表重读。桌面现有 task_id 轮询不依赖 SSE 全量状态；消息流 EOF 进入 interrupted/缺口状态，用户重连后核对最近消息。本票没有修改 desktop 或增加自动重连协议。

## 复现与结果

输入完全合成：5000/100000 个会话元数据、10 个固定合成定位标识、同 owner 状态事件、12 个各发 1/100 字节正文的未认证请求。原始 JSON 记录输入配方 SHA-256、Python 版本、基线/候选源码 SHA-256 与版本。两轮按 baseline-a → candidate-a → baseline-b → candidate-b 运行，均持有 `/tmp/notalone-optimization-benchmark.lock`。

| 观察 | 基线 | 候选 |
| --- | ---: | ---: |
| CLI 5000 事件停滞时队列 | 5001（含结束标记） | 256（另 1 项在生产者手中） |
| CLI 100000 事件停滞时队列 | 100001 | 256 |
| CLI 100000 事件 Python 保留堆 | 14.70813 MiB | 0.04389 MiB |
| 慢 SSE 100000 事件积压 | 100000 | 已断连，仅 1 个结束标记 |
| SSE 100000 事件 Python 保留堆 | 26.71976 MiB | 0.00378 MiB |
| 12 个未认证半截正文，在每个 50ms 观察窗内得到响应 | 0 | 12（均 401） |
| 上述观察时请求线程 | 12 | 0 |

两轮队列计数及保留堆数值一致。CLI 每轮全部 5000/100000 项逐条同序核验；SSE 快订阅逐条同序消费且没有积压。未认证请求的超时是删失观察，不能写成响应延迟由 50ms 降为零。tracemalloc 保留堆不是 RSS，也不包含 CLI 子进程、内核管道或完整 App 内存；停滞队列实验不能证明真实用户当前瓶颈。

无 tracemalloc 的计时另做 7 对交错样本，计时包含完整生产与消费，避免拿基线预解析后的 drain 与候选边生产边 drain 比较。p95 使用最近秩，7 点样本中即最大值。

| 本机合成完整操作 | 基线 p50 / p95 | 候选 p50 / p95 |
| --- | ---: | ---: |
| CLI 生产并消费 5000 项 | 20.863 / 22.319 ms | 21.593 / 21.945 ms |
| SSE 发布 5000 项、两个健康订阅逐项读取 | 20.652 / 21.604 ms | 23.409 / 27.118 ms |

代价：CLI p50 增加约 3.5%，健康 SSE p50 增加约 13.3%（每 5000 项约 2.76ms）。保留资源上界优先于这段合成吞吐的微小耗时；不宣称所有路径加速，也不把这些数值当作用户消息延迟。

原始记录：[两轮基线 A](evidence/stream-http-baseline-a.json)、[候选 A](evidence/stream-http-candidate-a.json)、[基线 B](evidence/stream-http-baseline-b.json)、[候选 B](evidence/stream-http-candidate-b.json)、[计时样本](evidence/stream-http-timing.json)、[验证摘要](evidence/verification.json)。

## 验证与复现命令

Python 使用 `NotAlone` Conda 环境的解释器，以下以 `$HOME/miniconda3/envs/NotAlone/bin/python` 表示。editable 安装原先指向共享主仓，发现后所有候选验证均显式设置工作树 PYTHONPATH，并核对实际导入位置。最初失败反馈为：上游已耗尽而非背压、慢订阅没有 closed、未认证半截正文读响应超时；随后逐切片修复。

从本工作树的 `backend/` 运行：

```bash
PYTHONPATH=src "$HOME/miniconda3/envs/NotAlone/bin/python" -m unittest discover -s tests/unit/wechat_cli -t . -v
PYTHONPATH=src "$HOME/miniconda3/envs/NotAlone/bin/python" -m unittest discover -s tests/unit/front_sync -t . -v
PYTHONPATH=src "$HOME/miniconda3/envs/NotAlone/bin/python" -m unittest discover -s tests/unit/server -t . -v
PYTHONPATH=src "$HOME/miniconda3/envs/NotAlone/bin/python" -m unittest tests.integration.server.test_events tests.integration.server.test_http_resource_limits -v
```

分别 **115、229、79、22 项，合计 445 项通过**。原始输出为 `evidence/{wechat,sync,server,http}-tests.log`。

从工作树根复现性能（先将固定基线 `backend/src` 用 git archive 解至临时目录）：

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/tmp/notalone-stream-http-baseline/backend/src "$HOME/miniconda3/envs/NotAlone/bin/python" .scratch/system-optimization-20261021/evidence/stream_http_measure.py /tmp/stream-http-baseline.json --source-revision 681fcc38eab77c8fe149b76705419971f3750a86
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend/src "$HOME/miniconda3/envs/NotAlone/bin/python" .scratch/system-optimization-20261021/evidence/stream_http_measure.py /tmp/stream-http-candidate.json --source-revision 317ec9d5ac316ea63a386eb22e5c9af1d697e3e3
"$HOME/miniconda3/envs/NotAlone/bin/python" .scratch/system-optimization-20261021/evidence/stream_http_timing.py /tmp/notalone-stream-http-baseline . /tmp/stream-http-timing.json
```

标准库接口核对：[RawIOBase/BufferedReader](https://docs.python.org/3.12/library/io.html)、[ThreadingMixIn 生命周期](https://docs.python.org/3.12/library/socketserver.html)、[BaseHTTPRequestHandler 输入流](https://docs.python.org/3.12/library/http.server.html)。实现用 Python 3.12 实际回环连接验证。

## 已覆盖与限制

- 满 CLI 队列的停止、reader join、回收重试、错误交付、EOF 排空、全量事件顺序；真实 SessionEventStream 接到 CliBackgroundSync 后，8 轮消费 1000 项，重连 cursor 为 1000，联系人正文游标仍为已写入的 local_id:10，未绑定会话不读正文。
- 原同步模块回归覆盖关闭/重新开启补齐、可靠水位回退、写失败不推进游标、重连退避、无授权不读、规范化重复消息保留给写侧去重。未改正文写入及数据库去重协议；本票没有重跑真实 PostgreSQL 的持久化去重端到端，05 集成应补相应合成库验证。
- SSE owner 隔离、实时同序、不同 task_id 与失败状态、超过 256 项恢复提示的有界性、300 个任务逐项 HTTP 权威读取、实际 HTTP SSE EOF、头部预算不缩短 SSE 寿命、关闭唤醒。
- HTTP 缺失/错误 token、两种认证头、400/413 优先级、已认证零星正文、未完成零星头部、提前 EOF、连接超额及额度恢复、实际 SSE 和 shutdown。关闭回归使用 10 秒输入预算，排除依靠短超时自然结束的假阳性。
- 默认 32 连接包括 SSE；达到上限时新请求（包括控制请求）先收到 503，需等已有连接释放。没有为控制请求在认证前另开无界线程。
- 这不是服务吞吐或完整 App RSS 基准。没有启动真实 App/微信、调用外部模型、读取私人资料或连接业务库；没有修改默认 desktop 测试清单。05 负责统一默认入口、全量与 dev App/必要微信验收。

## Standards

独立审查先发现任务快照会无限累积的资源风险，已在 `317ec9d5` 消除。复核确认每 owner 缓存与连接队列分别有界；没有遗留文档标准违反或需整改的代码异味。审查仅静态读取，没有重跑测试或启动 App。

## Spec

独立复核确认 `issues/03-stream-http.md:17` 的范围：有限提示不代替全部任务状态，权威读取保留 owner/contact/task_id，CLI 水位与关闭规则、HTTP 分段截止及认证兼容均符合。没有遗留规格遗漏、扩张或实现错误。审查仅静态读取。

两轴遗留发现数：Standards 0，Spec 0。

## 数据影响与清理

仅调整进程内元数据与 HTTP 资源管理；未增加持久化、模型出站、读取授权、聊天发送、迁移或私人夹具。停止可丢弃尚未消费的触发元数据，但不推进可靠正文游标，恢复仍从原授权范围可靠位置补齐。SSE 溢出通过 EOF 显式暴露缺口，权威记录不由通知队列删除。

隔离回环服务、合成 reader 和计时子进程全部结束；基线源码临时副本约 6 MiB 在证据固定后删除，保留约 128 KiB 的合成日志/JSON/脚本。没有创建浏览器页、第二个 App 或常驻服务；本聊天未启动或停止既有 App；起初共享主仓 dev:status 为 development，收尾为 stopped，本工作树始终未启动 App，05 需按协作规则核对热更新现场。最终提交后执行 `node scripts/check_public_history.mjs --ref HEAD --working-tree`，合成证据中的源码路径已归一化，检查结果随最终交付报告；没有 push、远端分支、PR 或发布。
