# 增量首次读取的秒级授权边界

范围：19 的无 cursor 增量起点；修改 TS 存储读取下界与时间转换，不改历史授权、已有 baseline、position token、cursor、存储结构、DSH 核心或 CLI 参数集合。

## 查证与取舍

- DSH 固定 0.2.1-rc.2／687f282e8625c6b8d11ff58211a90524be2e4317。已核对官方 apps/cli/src/profile-boot.ts 的 appReady 及 process-shutdown.ts 的退出预算；本次仍为普通业务模块，不新增模型、Tool 或独立 Harness。
- CLI 固定来源为 [wechat-sources.lock.json](../../../desktop/wechat-sources.lock.json) 的 2.0.1-rc.5／795071fa0591da5fc2c6ab94a70f22ccd93ef06c；构建合同还锁定仓库的只读补丁。版本与 commit 本身不能单独证明现有二进制的补丁身份。
- [锁定官方 main.go](https://github.com/r266-tech/wx-cli/blob/795071fa0591da5fc2c6ab94a70f22ccd93ef06c/cmd/wechat-cli/main.go#L7347) 的 parseTS 返回整数秒；日期最终调用 Unix()，仅有三种本地时间布局，没有 RFC3339／显式偏移布局。main.go:942–948 使用 create_time >= 秒值。追加小数秒不能保留比较精度。
- [锁定 cli.go](https://github.com/r266-tech/wx-cli/blob/795071fa0591da5fc2c6ab94a70f22ccd93ef06c/cmd/wechat-cli/cli.go#L1378) 会把纯数字 flag 转成整数；本次保留既有本地字符串合同，不猜测另一种参数形式。
- BindingService:96、136 在绑定事务保存毫秒级时间；Python 建联与 store 自建 baseline 的 now() 还可保留 PG 微秒。原 TS engine:23–26 和旧 Python cli_sync.py:1974–1978 都截到秒；即便 JS 内 ceil，PG 的 .000001 经过 Date 后也会先丢失微秒。规范化与保存层不能靠读取后过滤满足最小读取范围。
- [PostgreSQL 16 的 date_trunc](https://www.postgresql.org/docs/16/functions-datetime.html#FUNCTIONS-DATETIME-TRUNC) 支持显式时区。readPosition 在 PG 内用 UTC date_trunc、精确 timestamp 比较与 interval 计算整秒上界，不经过浮点 epoch。

readPosition 新增 query_since_at，代表按原始 PG 微秒精确向上取整的正文读取下界；baseline_at 的既有毫秒投影仅保留原合同，engine 不再从它计算权限边界。原始 baseline 不改写，整秒不移动。engine 保留毫秒 ceil 及本机时区转换保护；无法往返表达同一时刻的本地歧义时间失败关闭，不猜测回拨前的同名时刻。

## 红绿与隔离验证

第一条真实合成 PG 回归通过 BindingService 创建含 .750 秒的 baseline，直接运行 SyncIncrementalEngine 和合成 CLI 子进程。旧代码实际 argv 为 09:00:00，预期 09:00:01，先红；修复后同秒内早于 baseline 的消息不入库，原 baseline 不变，下一轮使用原 cursor。

第二条先红反例覆盖纽约回拨后的重复小时：仅 ceil 仍会把无偏移本地字符串解析到更早时刻；往返检查后正文 tail 不执行，消息数为零。

第三条先红反例通过现有 Python PostgresConversationBindingRepository.create_cli_bindings_batch 真正在合成 PG 保存 .000001 起点，直接在 PG 比较实际 CLI argv 与原值，原 JS ceil 路径返回 false；SQL 下界修复后返回 true，实际参数为下一整秒，重复 readPosition 也不改变 token 或创建 cursor。

新增 7 项：毫秒边界及 cursor 接续、Python 微秒边界、整秒 UTC、台湾跨年、普通负偏移时区、非法读取下界、回拨歧义时间。未修改测试库 baseline；非法值只在存储返回端口注入，因为 PG 本身不能保存非法 timestamp。

实际命令：

    node --test backend-ts/test/sync-incremental-new-only-boundary.test.mjs
    python .scratch/dsh-ts-migration/incremental-sync/new-only-boundary-verify.py

先跑微秒单例 1/1，再跑专用模块 7/7。隔离脚本固定基线 f270f348f7ee7be1d1762ae374df82a3adf79e80，仅覆盖 store、engine 与新增测试三个文件，真实合成 PG 的新增 7 项、既有 engine 11 项和 store 11 项共 29/29、0 skip，通过全隔离树 tsc --noEmit；测试耗时 26.68 秒。脚本核对源文件前后摘要并清理隔离树，各夹具关闭子进程、连接及自有随机 _test 库。微秒红绿与最终日志分别在 /tmp/notalone-new-only-boundary-microsecond-{red,green,isolated}.log。

验证摘要：

- engine SHA256：c3211411a341cf63959f28733fb5b462b0d1d5734d2f50e51a84ae577dc8749b
- store SHA256：b5128f91d0fad05f117745e9aa407f7ea30809a1c2f4d00bf80ea495f1331258
- 新测试 SHA256：266eab1dad5a524df2650b1c5483896f455ea141f4bc3d52ac9ba7a11c82238a

## 数据影响与实际验收边界

CLI 只有秒级时间，无法辨别授权所在秒内的先后，因此保守跳过该秒剩余不足一秒的新消息；不通过读入该秒正文再过滤弥补。已有 cursor、整秒起点及已授权历史路径不改变。

本地回拨后重复小时的无 cursor 起点无法无歧义表达时保持失败关闭；不会自动移动已存 baseline 或恢复历史授权。新增读取下界在进入 JS 之前已完成精确整秒取整，覆盖 Python 微秒起点与 now() 自建起点的同一读取路径。

真实新消息验收须默认 selected、只有已确认目标绑定、没有旧 cursor 或已有历史授权，并在绑定后再产生待验证消息。BindingService.confirm 的 historyAuthorized=false 只是不新增历史授权，不能撤销已有授权或推进旧 baseline。TS engine 的全局 follow 只接收元数据，不能用这项局部修复宣称全账号正文获准读取。

同步核心没有模型调用，但正式 App 提交后的事件会唤醒既有派生任务；无模型验收还需独立保证测试运行配置和队列不触发模型。这里没有操作真实 App／微信、读取真实配置或资料、调用模型、发送消息、打包或操作 Git 索引；真实渠道验收继续由主执行者完成。
