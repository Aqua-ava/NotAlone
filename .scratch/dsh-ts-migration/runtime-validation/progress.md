# 02 运行验证进度

状态：任务02本地合成验收与双轴审核完成；当前产品仍是 Python。

## 固定候选

- 官方提交：`687f282e8625c6b8d11ff58211a90524be2e4317`。
- `git ls-remote --tags` 确认 `dsh-v0.2.1-rc.2` 指向上述提交。
- npm CLI：`@deepseek-ai/dsh@0.2.1-rc.2`，SHA256 `40e3d025c0240c4316ff42dee9bedc7709c0fb38aea10543b47076ed2af52e1d`。
- tarball SHA512 与官方 registry `dist.integrity` 完全一致。三份 README 和全部86条转换后的生产依赖与候选源码一致。
- **溯源限制（不夸大为可复现构建证明）**：npm 无 gitHead、attestations；tarball 无 source map 或 commit manifest。官方发布链是 tag 验证→构建→pack→同制品 publish，但缺该次执行的可验证证明，不能将工作流定义当作执行事实。
- 官方来源：<https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317>；npm 精确版本 <https://registry.npmjs.org/@deepseek-ai%2fdsh/0.2.1-rc.2>。

## 已核对的公开合同

- `packages/boot/app-boot/src/profile.ts:1`：named profile，空根按 bundle/profile/home/invocation 层合成。
- `apps/cli/src/profile-boot.ts:1`：官方 launcher 提供配置组合、就绪、故障和有界关闭。
- `apps/cli/src/process-shutdown.ts:4`：关闭5秒超时强制进程退出；共享故障域不等于每个任务都能强制杀死。
- `packages/core/agent/README.md:26`：create/setup/followup/whenIdle/dispose。
- `packages/core/agent-loop/src/index.ts:342`：真实循环要求 agents/sessions/llm/tools/systemPrompt/sessionProjections。
- `packages/core/tools/README.md:30`：defineTool、scoped 注册和 guard；身份必须由业务闭包绑定。
- `packages/llm/llm/README.md:47`：单次 stream，业务负责完整终止和结构校验。
- `packages/llm/llm-deepseek-api-key/src/config.ts:14` 与 `llm-deepseek/src/config.ts:300`：公开 baseURL 配置，可指向本机合成 Messages 服务。
- `packages/llm/llm-deepseek/tests/helpers.ts:22`：官方 SSE 合成样例；本票仅替换外部 HTTP 模型边界。

## 边界

专用 profile 不继承 base/sdk-minimal，明确装配公开服务；不启用额外上传、压缩、JSONL、Shell、文件工具、子 Agent 或重试插件。业务试验只处理合成内存数据，不接 PostgreSQL，不代表真实业务迁移或权威存储已实现。测试过程隔离 HOME/DSH_HOME/cwd，避免加载仓库 .env 或个人 profile。

## 实际结果

- `node --test test/runtime.test.mjs`：14/14 通过，约8.17秒，逐项输出见 `tests.txt`。
- `node node_modules/typescript/bin/tsc --noEmit`：通过。
- `pnpm install --frozen-lockfile --ignore-scripts --no-optional --offline`：通过，消费锁不变。全部650个锁条目均含 integrity；平台需要的 Loader addon 与 TypeScript 平台包显式固定。
- 发行包实际启动成功，五个关键公开接口／配置路径与固定源码交叉核对见 `interface-crosscheck.json`。运行测试进一步核验 create/setup/stream/guard/dispose 的发行行为。官方tag＋制品摘要＋接口对应是本票版本证据，不宣称拥有官方构建 attestation。
- 测试先出现缺插件的红灯，再贯通单次请求；随后工具循环、取消、来源撤销先红后绿。伪造身份工具参数用例发现官方 schema 根对象开放，补公开 guard 后通过；没有修改 DSH 核心。
- 默认实际模型工具只有 `lookup_source`；四个范围并发各自只含本范围来源。结构化结果采用严格 JSON 解析与来源校验，不使用输出提交工具，也不引用私有 structured helper。
- 所有用例收尾均检查真实 TCP 目标只为本机 provider，真实 HTTP 路径为 `/anthropic/v1/messages`，无 `dsh_session_log`／`dsh_plugin_packages`。错误、取消、超时、正常和强制退出均有用例。默认工具清单无 Shell/文件/外发，运行树无重试、压缩、标题、OTEL或JSONL插件。
- home 文件快照只有 profile manifest、profile patch、官方空 cordis.yml 和 `.anonymous-user-id`；测试输入／候选未落盘。匿名 UUID 和临时 session UUID 是官方请求头，跨启动更换，无 owner/contact/真实身份；测试宿主退出收尾删除 home 并验证文件不存在。
- 不合作工具实测约5.2秒后由官方CLI强制退出整个后台。单次 dispose 不能强制终止不合作Promise，不能记为优雅清理。异常退出后清理由宿主承担；任务03仍需产品级实现。
- 单次请求／循环均使用真实 DSH 和官方 DeepSeek adapter；仅外部模型HTTP服务为合成替身。没有真实模型调用、凭据读取、私人资料/生产库访问、App/微信操作、打包、push或聊天外发。
- 限制：Node TCP观察和临时目录快照不是操作系统沙箱证明；其他平台、真实供应商、产品PG、桌面和完整迁移不在本票结果内。

## 独立审核与清理

固定点为 `10135184`，首个实现提交 `0564283b`；审核只覆盖本票文件，未捎带独立审计或主会话调度文件。

- Standards：没有硬违规；一项重复SSE/工具夹具建议已提取 `sendEvents/useTool`，复核未解决发现为0。
- Spec：独立复跑14/14通过，未发现阻塞项。后续将空闲SIGKILL改为模型请求已到provider后的在途SIGKILL，独立复核确认；不外推持久业务恢复。
- 最终重跑14/14通过、类型检查通过。多宿主清理用 `Promise.allSettled`，一处断言失败不跳过其他宿主清理。
- 当前没有本票DSH/安装/测试进程；中断验证遗留的两份合成临时目录已核对profile归属后清理。成功测试自行清理home并验证匿名ID文件不存在。
- 初始可用磁盘约149GiB，结束约148GiB；保留当前验收依赖目录约416MiB及可复用pnpm缓存，未创建App、构建staging或打包产物。公开官方源码由多个任务共享，未删除或修改。
- 首次本地提交后的完整可达历史与工作树扫描为0项问题；收尾提交后再次运行同一检查，结果在交付报告公布。
