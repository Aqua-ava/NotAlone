# 观察自动记忆：真实模型隔离验收

状态：入口准备与离线预演完成；经用户明确确认后，单条合成消息的真实模型隔离验收通过。

## 本次范围

只创建随机 `_test` 数据库和随机合成 owner/contact；通过正式迁移初始化后，使用已确认的合成绑定记录一条消息：

> 我平时喜欢科幻小说。

观察提交后发布消息通知，由生产 TaskHost／Worker 自动提取、核验并完成任务。
保留默认空维度放行表（测试进程内固定 `NOTALONE_MEMORY_DIMENSION_GATE=1`），
期望候选处于待确认状态，带本次消息来源，并在独立待确认检索轨可见；不得成为已确认记忆。
检查跨 owner/contact 检索为空、重复通知不重开任务或增加出站台账、删除来源后不可检索，
最后通过 HTTP shutdown 检查旧事件不新增模型调用。

这是模型接线与最小语义冒烟，不是准确率评测；一条合成偏好不能证明复杂上下文、
真实微信读取、App UI 或业务库升级可用。并发失败、解绑、锁忙及调用中停机已由
任务 02 的可控模型覆盖，本次不故意让真实供应商失败或挂起。

## 接收方与数据处理

本次本地配置只读检查：凭据、模型名、地址均已配置；HTTPS 主机为
`chat.ecnu.edu.cn`，模型为 `ecnu-max`。生产代码使用 DeepSeek 兼容适配器，
这不证明接收方是 DeepSeek 官方。配置没有被修改，未输出 API key、完整 URL 或其他连接凭据。

本次显式运行时，只发送上述合成消息及随机来源 ID、说话人／时间、正式提取与核验提示词、
结构定义，以及必要的模型候选结果。不会加载聊天导出、微信、桌面画面或业务库资料。
本地正文追踪、候选和台账位于该次随机库，用例收尾删除整个自建库。
删除本地库不代表删除供应商副本；供应商留存和远端删除能力本次未核验，
因此本入口不允许改用私人资料作为测试输入。

## 已准备的入口

先激活 `conda activate NotAlone`，在 `backend/` 运行。普通预演命令：

```bash
NOTALONE_DISABLE_DOTENV=1 NOTALONE_RUN_REAL_OBSERVATION_SMOKE=0 python -m unittest tests.integration.server.test_observation_model_smoke -v
```

预演只在模型工厂边界使用现有脚本模型，生产 TaskHost、运行时适配器、观察存储、
PostgreSQL、HTTP 和检索路径不替换。真实类在创建数据库、加载配置或构造模型前
检查专用开关，只有 API key 不会启动真实调用。

真实验收类的显式命令如下。用户已确认上述接收方、数据与费用范围；本次实际执行在同一进程增加接收方复验和测试库清理检查后，运行该类：

```bash
NOTALONE_DISABLE_DOTENV=0 NOTALONE_RUN_REAL_OBSERVATION_SMOKE=1 python -m unittest tests.integration.server.test_observation_model_smoke.RealObservationModelSmokeTest -v
```

真实模式按现有配置加载供应商参数，数据库连接始终来自用例自建随机库，
不会采用 `.env` 中业务库或 `NOTALONE_TEST_DATABASE_URL`。已配置的进程模型变量
优先于 `.env`，实际执行前应再次核对接收方。显式启用但缺 key 时失败退出，不能把跳过当通过。

只执行一个合成场景，不做整套真实模型测试。沿用生产 SDK 的 60 秒单请求超时、
最多 2 次 SDK 重试和任务 3 次失败预算；应用运行时调用不等于 HTTP 尝试次数。
HTTP 状态轮询最多 360 秒，超时判失败后沿既有宿主停止协议收尾；这不是供应商的
硬取消期限，已发请求可能仍由对方处理，不承诺固定调用次数或费用上限。

正常结束或 Python 用例异常均清理自建库；强制杀进程不能保证 cleanup 执行，
应按该次随机库归属处理，不能使用宽泛前缀批量删库。执行结果只记录状态和统计，
不把供应商错误原文或凭据写入仓库。

## 本次真实验收结果

用户在准备完成后明确回复“可以”，授权本轮 `chat.ecnu.edu.cn` / `ecnu-max`
单条合成消息验收。执行前同一进程核对 HTTPS、接收主机和模型名与授权一致，
禁用 LangSmith／LangChain tracing 外传，仅运行 `RealObservationModelSmokeTest`。
使用 Conda NotAlone、专用开关 1 和现有模型配置，经
`unittest.defaultTestLoader.loadTestsFromTestCase`／`TextTestRunner` 执行，未替换真实模型。

结果：**1 项执行，0 失败，0 错误，0 跳过，耗时 11.589 秒**。

- 新观察提交后自动任务达到 succeeded；明确偏好产生至少一条待确认候选，来源均属于本次消息，未进入已确认记忆集合。
- “科幻小说”检索在本联系人待确认轨可见；错误联系人和错误 owner 范围不可见。
- 重放同一批次不改变任务状态快照，也不新增出站台账。
- 删除该合成观察后，候选不再被检索；HTTP shutdown 后旧事件不新增出站台账。
- 用例清理后，按本次独有数据库名查询 PostgreSQL 管理目录，确认随机测试库已不存在。

一次验收场景不等于一次模型 HTTP 请求；沿用既有运行时、SDK 与任务重试边界，
本次不声称精确调用次数或费用，也不把合成冒烟称为总体语义准确率验收。
未读取真实微信或业务库、未启动桌面、未升级业务库、未发送外部聊天消息。
仅记录验收事实，无产品代码或 schema 改动；后续真实微信／桌面集成仍需独立限定范围。

## 后续有限桌面验收

用户明确确认“安排长时间”，主 Agent 将本轮时段限定为
2026-10-09 22:58:43–23:58:43（UTC+8），仍只验约定的两项，最多启动两次，完成即收尾。
固定源码为 `032d70f`，使用源码 Electron App、临时 userData 和合成资料；不是最终签名包验收。

前置检查：当前工作树缺少 node_modules，首次 npm test 因 tsc 不存在退出；
按 lockfile 执行 `npm ci --no-audit --no-fund` 后，类型检查及 24 项安全调度回归通过，
`npm run build` 通过，Electron 可执行文件就绪。预约前 App 租约 absent。

实际在 Conda NotAlone 下运行，清除签名包覆盖、模型 key，禁用默认 dotenv 和外部 tracing：

```bash
npm run test:app -- --interactive --coordinator main-agent \
  --from '2026-10-09T14:58:43Z' --until '2026-10-09T15:58:43Z' \
  --max-launches 2 -- tests/windows.spec.ts tests/memory-reading.spec.ts \
  --grep '管理后台和输入小窗可独立|按已选联系人显示真实有效资料' \
  --output artifacts/observation-desktop-20261009
```

结果 **2 passed（9.8 秒）**：

- 关系资料页面在真实 Electron／HTTP／隔离 PostgreSQL 上显示合成联系人资料、本人共享资料和未确认候选（8.0 秒）。
- 管理后台和输入小窗独立打开、隐藏、恢复，公开菜单退出并回收测试 App 进程（1.5 秒）。

夹具收尾与随机库 drop 命令完成且未报错；运行器 exit 0，随后 `npm run test:app:status`
返回 absent。此清理证据来自夹具正常收尾与租约结果；没有额外保留该库名做独立目录核查，
不与上文真实模型场景的精确库不存在核验混同。
本地窗口截图与 `.last-run.json` 位于 `desktop/artifacts/observation-desktop-20261009/`，不提交产物。

本轮仅增加上述两项原生证据，没有运行整套 App、真实微信、系统剪贴板或签名包验收，
没有新增模型外发、读取业务库、迁移业务库或改变同步范围。
真实模型自动观察与这次桌面资料展示是分开通过的两个场景，尚不能称真实微信新增消息
经模型后即时显示于桌面的端到端闭环。完整 CLI／WCDB helper 输入、可信最小定位和最终包
仍沿任务 18／20 的现有范围推进；不因本次通过而关闭完整交付任务。

## 2026-10-10：真实微信验收前置核查与已补齐项

用户要求梳理缺口并先补能直接完成的部分。本轮只做配置路径存在性检查、源码核对、
构建、静态签名校验和纯逻辑测试；没有沿用昨日已结束的原生验收时段启动 App 或读取微信。
构建输入固定于 `4654aec`，没有修改生产代码、用户配置、系统权限或业务库。

### 先分开两个验收目标

ADR-023／025／030 以及 `front_sync/cli_sync.py` 明确：已确认联系人 CLI 后台同步
不以前台 OCR 为门禁。因此可以先验“用户手动确认唯一联系人 → 新增合成消息 →
观察／任务／显示”；前台自动定位需要独立补齐最小区域和质量证据。
上一阶段把完整 helper 与定位前置条件并列为未完成项，不应理解成 CLI 同步必须等待 OCR。

| 前置项 | 本次核验／补齐结果 | 接下来由谁完成 |
| --- | --- | --- |
| 后端观察自动任务与真实模型接线 | 已有 01／02 和单条合成真实模型证据，本轮不重跑模型 | 已具备，可复用 |
| 新桌面本机产物 | `npm run package` 成功，arm64 Electron 包递归严格 ad-hoc 签名通过；尚未运行本次签名包 | 已生成，实机另安排 |
| 仓库原生探针与核心库 | 明确 ad-hoc 构建，两个二进制严格签名校验通过，动态依赖指向同目录核心库 | 已生成；不得冒充成功定位 |
| session 安全退化 | 4 项 XCTest 通过；未知最小布局仍在 OS 采集动作前拒绝 | 已验证纯逻辑；自动定位仍未实现 |
| 微信 CLI 与 WCDB 完整运行时 | 当前 PATH 无 `wechat-cli`；项目 env 无 CLI／probe 路径；默认桌面 `backend-launch.json` 不存在；本次已检查的仓库构建目录无 CLI／WCDB | 用户提供完整绝对目录、版本及来源；Agent 再核对完整性／依赖／签名，不先运行未知 helper |
| 随包集成 | 当前 `desktop/scripts/package.mjs` 只复制 dist 和最小清单，未复制微信 CLI／WCDB，也未提供它们的随包路径 | 拿到可追溯输入后补完整打包与受控运行路径，不能将本轮包称作最终交付 |
| 单联系人与时段 | 尚未指定真实测试的一对一会话；昨日两次启动的预约已结束 | 运行前确认唯一联系人及新有限时段 |
| 数据库与模型范围 | 现有业务库未检查／升级；仓库最新迁移为 047 | 首轮继续随机隔离库，禁用模型与外部 tracing；实际微信资料外发不在前次单条合成模型授权内 |
| 自动前台定位 | 源码没有可追溯布局 profile，`SessionCaptureSafety.failureCode` 固定为 `minimal_region_layout_unverified` | 用户授权有限微信前台布局观察后，按任务18形成最小区域／质量方案并实现验证，不能凭猜测坐标放开采集 |

这里只检查既有配置路径及仓库构建目录，没有扫描用户其他目录；“未找到入口”不代表整台机器没有安装副本。
完整运行时至少包含匹配版本的 `wechat-cli` 和 `libWCDB.dylib` 及其实际依赖、可追溯版本／来源；
不索取数据库密钥，不自动提取密钥或下载来源未知的二进制。ad-hoc 签名只证明本地产物完整性，
不证明稳定权限身份、Developer ID 分发、公证或微信读取权限。

### 已执行和产物

- `NOTALONE_PROBE_SIGNING_IDENTITY=- zsh native/macos/scripts/build_cli.sh`：成功；未查询／选择钥匙串证书。
- `codesign --verify --strict --verbose=2` 分别检查探针与核心库：通过。
- `otool -L native/macos/build/cli/notalone-sync-probe`：核心库为 `@rpath/libNotAloneSyncCore.dylib`；运行时可用性仍需现场验证。
- `swift test --package-path native/macos --filter SessionCaptureSafetyTests`：4 项通过（17 组参数），只运行政策逻辑；构建系统也编译／链接了相关目标，没有启动 App 或执行探针采集。
- 在 desktop 执行 `npm run package`：成功；随后主包 `codesign --verify --deep --strict --verbose=2` 通过。
- 打包器提示未提供可选 `.icon` 格式，现有 ICNS 仍存在，Info.plist 指向 `electron.icns`；该提示不等同图标丢失。
- `npm run test:app:status`：在 desktop 目录执行返回 absent，App 未运行。最初误在根目录调用状态脚本得到 package.json 不存在，改正工作目录后通过，非产品失败。

产物（均为忽略的本地产物，不提交二进制）：

| 路径 | SHA-256 |
| --- | --- |
| `native/macos/build/cli/notalone-sync-probe` | `9a65c457a9c07c81a25344e7b43a8e8a7a1225afb1537a83bc77e1f2245eaf74` |
| `native/macos/build/cli/libNotAloneSyncCore.dylib` | `cf8afdde540e03c8784dbde283cdf5056136c012cded5df4a49093d1a8c1ec80` |
| `desktop/out/NotAlone-darwin-arm64/NotAlone.app/Contents/Resources/app.asar` | `d5071b69d4e723fe784942df665ae1092974ecf37541072e0220df07504252c1` |

App 路径为 `desktop/out/NotAlone-darwin-arm64/NotAlone.app`。最后一行仅是应用资源包 hash，
不是整个签名 App 的单一摘要；完整包另有上述递归签名验证。

### 材料到位后的最小执行顺序

1. 静态检查提供的完整运行时：架构、版本来源、hash、动态依赖和签名，先明确是否可执行；不试运行未知旧探针，不改系统权限。
2. 新建随机隔离库并迁移至 047，独立 env／握手／userData，只配置核验后的绝对 CLI 路径；清空模型 key、禁用外部 tracing，前台探针保持不可用／安全暂停。外置 WCDB 定位需结合该 CLI 版本核验，不能仅凭旧版 `WECHAT_CLI_WCDB_LIB` 约定宣称新版本已可用。
3. 在新认可时段由用户确认一个一对一测试联系人，仅该绑定 active；新 baseline 后由用户亲自发送约定的合成测试文字。后台 session 流可能含其他会话变化元数据，正文仍仅限该绑定；授权说明需包含这个区别。
4. 验证新文字去重入库、来源／游标、观察任务排队、App 消息显示；无模型凭据时任务应 queued 并显示稳定配置原因，不把它当提取成功。
5. 若要连接模型，只在核实本次隔离库输入全部为已授权合成内容并明确外发范围后继续；若出现测试范围外真实聊天，先停读，不外发。
6. 核验关闭停读、取消绑定与旧事件边界，认证停止本轮后端、退出 App、清理本轮随机库并确认租约。保留合成状态证据，不提交联系人身份、聊天正文或凭据。

任务18／20保持原状态和依赖图；本次完成可独立验证的构建准备，不把缺输入的完整运行时、
自动定位、稳定签名权限和最终实机验收标成完成。
