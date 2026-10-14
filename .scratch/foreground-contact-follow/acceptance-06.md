# 06 组合验收记录与待实机范围

日期：2026-10-14。产品基线 `8b4709e9`，04已完成；本文件不表示06通过。准备阶段未启动真实App；本轮实机尝试结果见下方记录。

## 已有自动证据

| 范围 | 本轮结果 | 限制 |
| --- | --- | --- |
| 生产公开控制器→认证HTTP→隔离PG的组合 | 80个不同用例最终均有通过记录；首次79通过、单帧文件因UI语法未编译，修正后针对性1/1通过 | 非真实窗口和权限证据 |
| 连续跟随及后台生成组合 | 最终2/2通过，包含停止重启/解绑/删除竞争；两次显式生成合计2次合成模型调用 | 非自然语言质量验收 |
| 前台同步单元 | 75/75通过 | 合成外部边界 |
| 原生测试 | `swift test --package-path native/macos`：67项，65通过，2项有限Vision实验按默认条件跳过，0失败 | 未启动探针或观察微信 |
| 桌面安全 | `npm test`：类型及44项安全调度测试通过 | 不运行App，不能替代实机 |
| 资源清理 | HTTP夹具报告自有后端正常停读/退出、随机测试库删除；预算夹具迁移001–058、重复0、数据库剩余0 | 不查询或终止其他工作进程 |

自动回归命令详见[04 Answer](issues/04-continuous-contact-follow.md#answer)。同一产品版本覆盖了内容恢复、固定上下文、后台作业、晚事件/退出归属和新消息提示；实际OS移动/缩放、焦点、重启与持续资源开销仍未验证。

## 正式包准备

构建命令：在 `desktop/` 执行 `npm run package -- --with-probe --output-directory <本轮新输出目录> --electron-zip-directory <本机已缓存44.7.0目录>`。使用已有离线Electron归档，未下载、安装或运行App。包为arm64、Electron44.7.0，包含仓库探针和核心库；不包含真实微信CLI。

随后 `codesign --verify --deep --strict <NotAlone.app>` 成功。静态SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `Contents/Resources/app.asar` | `d2a41ab2a65780aeba4aaa1603c00ca7a42258b3cafd1874e1ca7063a6de1c15` |
| `notalone-probe/notalone-sync-probe` | `7f97388b86f493b4712ca03a46e13085c345a5236897400a2eaaaacc4fa3c902` |
| `notalone-probe/libNotAloneSyncCore.dylib` | `57732d34ece90fc331a563dcbde768a1d905c5447f0fd0ceda062db73d45a093` |

签名只证明本机构建完整性，不证明权限、分发签名或定位成功。`npm run test:app:status` 返回 `absent`，没有占用真实App验收租约。

## 本轮受限场景

新增 `desktop/tests/continuous-contact-follow-acceptance.spec.ts`，接受明确正式包和一位测试会话名称；第二位名称可选且不得重复；由 `test:app` 核验有限时段和单实例租约。使用独立用户数据与随机PG，真实原生探针读取名称，CLI会话元数据和正文输入由合成夹具提供，不访问真实聊天数据库。不启动模型，不点击生成，不发送消息，不保存截图、视频、trace或原生名称输出。

协调阶段：原位A → 移动窗口A → 缩放窗口A → 可选同窗切B并返回A → 其他App前台 → 助手获焦并输入合成草稿 → 返回微信A → 正常退出。操作者核对实际微信和目标会话后，才向本轮私有协调目录写入各阶段触发文件；触发文件不包含坐标或名称。结果仅保存阶段、匹配布尔、触发到展示耗时和正常退出状态。实际操作的阶段证据须由主Agent另记，不用触发文件本身证明动作发生。

入口参数准备为：

```sh
npm run test:app -- --interactive --coordinator contact-follow-06 \
  --from <用户确认的开始时间> --until <用户确认的截止时间> \
  --max-launches 1 tests/continuous-contact-follow-acceptance.spec.ts \
  --output artifacts/contact-follow-06
```

执行前在本机私有环境设置 `NOTALONE_CONTINUOUS_APP_ACCEPTANCE=1`、`NOTALONE_TEST_APP_EXECUTABLE`、`NOTALONE_FOLLOW_TEST_NAME_A/B`、`NOTALONE_AUTOMATIC_CONTROL_DIRECTORY`；真实名称和本机路径不写入仓库或日志。本轮以仅设置名称A的单联系人模式执行；B未设置，不进入双联系人阶段。

## 尚未满足的验收条件

- 用户已确认单联系人识别、移动/缩放和暂停恢复，取消双联系人实机验收要求；双联系人仅保留合成回归证据。当前一次启动额度已使用，继续实机需新的明确启动额度及有限时段。
- 正式App已启动，但基线协调超时；真实匹配、移动/缩放、暂停恢复、菜单正常退出均未验收。失败清理已验证。
- 原生实际帧数、同帧两处名称、前台以外零图像、原生/后端/展示分段耗时、有效/失败/超时计数、CPU/内存开销仍缺实测。当前受限场景明确把运行时帧数及原生/后端分段测量记为未验证，不能以静态单帧代码或触发到展示耗时代替；这些项目还需补齐测量证据后才能关闭06。
- 双联系人真实切换和多联系人实机任务从当前验收范围移除；单联系人App任务及重开恢复仍未实测，公开HTTP结果不能替代真实App生命周期。
- 旧 `real-foreground-locator-acceptance.spec.ts` 保留历史profile及固定单次观察假设，本轮不采用，也不得据其旧结果宣称连续版本通过。原生自动定位场景补齐 `--single-frame` 参数，仍不能单独代替正式App匹配验收。

06保持claimed，Triage为needs-info。后续只在实际结果满足对应条件时勾选，不沿用历史预约或历史联系人授权。

## 单联系人实机尝试结果

本轮获准20分钟内最多启动一次App，允许移动/缩放微信和切换已授权测试会话。已用Computer Use搜索并核对唯一测试会话；身份不入库内文档。产品代码及正式包沿用上述基线，仅调整验收入口允许A必填、B可选。

实际执行上述受限命令，`--max-launches 1`；1次App启动，1个用例失败。失败发生于等待 `baseline.trigger` 的120秒协调超时：主Agent未及时发出信号，尚未进入匹配断言。匿名结果为 `reports: []`、`normalQuit: false`；不能由此认定产品识别失败，也不能认定任何实机场景通过。未执行窗口移动、缩放、暂停恢复或双联系人切换。

失败后夹具通过认证HTTP停读，自有后端exit 0、随机数据库已删除、未确认资源为空；自有App和后端PID均不存在，独立用户目录已删除，`npm run test:app:status`返回absent。未再次启动App。外部模型调用0、发送0；真实CLI正文未读取，CLI使用合成数据。Computer Use核对会话时画面包含微信可见内容，未将私人内容、截图或联系人身份提交仓库；测试未录制trace/视频/截图。运行日志与错误上下文仅保留在本地忽略产物中。

后续实机先准备协调监控，启动后及时处理阶段信号，不在等待信号期间转去处理其他任务；只有实际动作确认后才触发阶段，不预先写入信号掩盖缺失操作。本轮未扩大启动额度。06仍claimed/needs-info，未完成项目保持未勾选。

本次入口改动验证：`npm --prefix desktop test`通过类型检查及44项安全测试，未因此再次启动App；`git diff --check`通过。Standards与Spec双轴增量评审均0项发现。以上不补足实机缺失证据。
