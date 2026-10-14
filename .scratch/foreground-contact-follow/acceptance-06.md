# 06 组合验收记录与待实机范围

日期：2026-10-14。产品基线 `8b4709e9`，04已完成；本文件不表示06通过。真实App启动次数0，微信操作0，外部模型调用0，外部消息发送0。

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

新增 `desktop/tests/continuous-contact-follow-acceptance.spec.ts`，只接受明确正式包和两位不同测试会话名称；由 `test:app` 核验有限时段和单实例租约。使用独立用户数据与随机PG，真实原生探针读取名称，CLI会话元数据和正文输入由合成夹具提供，不访问真实聊天数据库。不启动模型，不点击生成，不发送消息，不保存截图、视频、trace或原生名称输出。

协调阶段：原位A → 移动窗口A → 缩放窗口A → 同窗切B → 返回A → 其他App前台 → 助手获焦并输入合成草稿 → 返回微信A → 正常退出。操作者核对实际微信和目标会话后，才向本轮私有协调目录写入各阶段触发文件；触发文件不包含坐标或名称。结果仅保存阶段、匹配布尔、触发到展示耗时和正常退出状态。实际操作的阶段证据须由主Agent另记，不用触发文件本身证明动作发生。

入口参数准备为：

```sh
npm run test:app -- --interactive --coordinator contact-follow-06 \
  --from <用户确认的开始时间> --until <用户确认的截止时间> \
  --max-launches 1 tests/continuous-contact-follow-acceptance.spec.ts \
  --output artifacts/contact-follow-06
```

执行前在本机私有环境设置 `NOTALONE_CONTINUOUS_APP_ACCEPTANCE=1`、`NOTALONE_TEST_APP_EXECUTABLE`、`NOTALONE_FOLLOW_TEST_NAME_A/B`、`NOTALONE_AUTOMATIC_CONTROL_DIRECTORY`；真实名称和本机路径不写入仓库或日志。本命令尚未执行；场景只通过类型/安全发现检查。

## 尚未满足的验收条件

- 未取得用户本轮有限时间、两个测试联系人及窗口操作范围，不能启动真实App或操作微信。
- 新版正式App的真实匹配、原位/移动/缩放、暂停恢复与正常/失败退出均未运行。
- 原生实际帧数、同帧两处名称、前台以外零图像、原生/后端/展示分段耗时、有效/失败/超时计数、CPU/内存开销仍缺实测。当前受限场景明确把运行时帧数及原生/后端分段测量记为未验证，不能以静态单帧代码或触发到展示耗时代替；这些项目还需补齐测量证据后才能关闭06。
- 正式App中多联系人任务与重开恢复仍须在同一次已认可集成时段中补验；公开HTTP结果不能替代真实App生命周期。
- 旧 `real-foreground-locator-acceptance.spec.ts` 保留历史profile及固定单次观察假设，本轮不采用，也不得据其旧结果宣称连续版本通过。原生自动定位场景补齐 `--single-frame` 参数，仍不能单独代替正式App匹配验收。

06保持claimed，Triage为needs-info。后续只在实际结果满足对应条件时勾选，不沿用历史预约或历史联系人授权。
