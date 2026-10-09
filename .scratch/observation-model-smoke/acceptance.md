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
