# DSH 与 TypeScript 后台

## 产品桌面宿主（任务03—04）

源码开发入口 `cd desktop && npm run dev` 经官方命名profile启动产品 `host-plugin.ts`，Electron独立。产品使用原配置、PostgreSQL、业务HOME与资料位置，认证HTTP沿用桌面控制器合同。每次DSH HOME/cwd均临时且由宿主回收；临时目录不保存产品凭据或讨论。

03接管owner首用、凭据设置与宿主寿命。原迁移命令仍为结构升级唯一执行方，保留103文件转换钩子；TS只读复核完整账本和必需结构，未知版本停写。04将联系人目录、消息、来源列表、关系概览及手动输入确认交给普通TS模块；其余业务由受控Python子进程独占，经明确路由转交；无请求失败fallback。Python仅为迁移过渡，最终退役在26。03未启用模型请求，不能把02合成范围或模型当作产品配置。

联系人上下文通过具名停收、在途排空和原库锁核验显式移交；回退保留原数据。旧回复的独立概览读取经受限内部HTTP交给TS；旧业务已经持锁的事务只做自身提交资格复核，不能在TS拥有时写联系人概览投影，也不跨进程重入锁。此内部调用随后续旧业务迁移消失，不是永久框架桥。

验证和未完成边界见[04证据](../.scratch/dsh-ts-migration/contact-context/progress.md)和[03证据](../.scratch/dsh-ts-migration/host-lifecycle/progress.md)。日常不打包。

## DSH 后台运行验证（任务02）

这是隔离合成验证入口，不接入 Electron、不连接 PostgreSQL，也不替代现有 Python 产品。HTTP `/semantic`、`/loop`、`/cancel`、`/revoke` 和 `/health` 只用于验证公开行为；它们不是已有产品接口的兼容实现，也未提供产品认证。

## 固定环境与运行

当前验收平台为 macOS arm64、Node `24.19.0`、pnpm `11.25.0`。DSH 固定 `0.2.1-rc.2`，完整消费依赖及 integrity 在 `pnpm-lock.yaml`；源码官方 tag 对应提交 `687f282e8625c6b8d11ff58211a90524be2e4317`。本票显式安装 Loader 与 TypeScript 的 arm64 平台包，不声称其他平台已验证。

```sh
cd backend-ts
pnpm install --frozen-lockfile --ignore-scripts --no-optional
pnpm typecheck
pnpm test
```

安装不执行生命周期脚本；可选的 LibreOffice、语音和图像等平台依赖不安装，完整可选依赖仍锁定。运行树没有这些能力。版本和锁摘要、与官方源码锁的差异见[依赖证据](../.scratch/dsh-ts-migration/runtime-validation/dependencies.json)。消费锁与官方开发工作区锁并非同一个闭包，不能互相替代。

以下运行与生命周期说明专指02隔离验证；03产品宿主的责任、数据库验证及实测结果以文首03证据为准。

## 运行与数据边界

测试宿主为每次启动创建独立临时 `HOME`、`DSH_HOME` 和 cwd，清空代理及个人配置环境，再直接运行官方 `dsh --profile notalone`。`profile/cordis.patch.yml` 的两处占位符由宿主替换为插件路径和本机模型端点；profile 的 bundles 为空，配置层仍完全走官方入口。薄插件装配普通 TS 业务模块；健康入口返回的 PID 与 DSH 后台 PID 相同。

内部服务为 LLM、Session、SystemPrompt、Tools、Agent、SessionProjection 和 AgentLoop；官方 DeepSeek API-key adapter 连接本机 Messages SSE 服务。默认模型只可使用闭包绑定当前范围的只读 `lookup_source`。不加载日志上传、包清单上报、遥测、压缩、JSONL、Shell、文件工具、MCP、子 Agent 或自动发送能力。

结构化结果使用严格 JSON 字段与类型校验，再校验来源归属；单次调用只接受正常 `stop`，循环最多三次模型请求。此处没有“提交输出”工具，也没有调用子 Agent 内部 structured helper。工具参数的官方 DSL 根对象允许额外字段，所以业务 guard 另行拒绝任何多余参数。模型输出、引用或终态不合法均失败，错误响应不回显原正文。

官方 adapter 仍发送随机匿名 ID 头，Agent 调用还发送临时 session ID 头；匿名 ID 文件只在该次临时 home 内，既不含 owner/contact，也不来自真实机器身份。它不是关闭 `DSH_TELEMETRY_DISABLED` 后就会消失的字段，测试单独验证其内容及跨启动变化。

## 生命周期与验收限制

取消和 deadline 使用业务 AbortController；运行结束后等待官方 handle.dispose，验证 Agent/Session 归零。来源撤销使在途结果失败，新运行不能恢复该范围。这里的资料是进程内合成夹具，不是产品数据存储或真实删除实现。

不合作工具可能阻塞单次 dispose；官方 CLI 收到 SIGTERM 后在约五秒边界强制结束整个后台。该路径是共享故障域的强制终止，不是优雅资源释放。测试专用 `stalled-tool.ts` 只在对抗用例额外装配，不进入默认 profile。

测试宿主在正常、失败和强制结束后删除临时 home；这证明验证宿主的清理，不能宣称产品宿主已经具备此行为。任务 03 必须负责每次启动临时 home、退出/异常后的清理和后台监督，不得复用持久 DSH home。SIGKILL 本身不能执行进程内清理。

全部模型输入均为合成材料，未调用真实供应商。真实模型质量、其他供应商协议、产品 PG 持久化、Electron/微信、打包和迁移均不在本票运行证据内。网络观察覆盖 Node TCP 连接及本机实际 HTTP 请求；文件快照覆盖隔离 home/cwd，不能外推成操作系统级恶意原生代码沙箱证明。
