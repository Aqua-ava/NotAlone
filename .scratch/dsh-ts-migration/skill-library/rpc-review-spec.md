# 06 RPC／移交规格只读复核（2026-10-24，修复复核）

## Finding 状态：两项均关闭

- **[P2，已关闭] close／deadline后自动重连发送同步请求**。初版`skill_management_remote.py:74-83`的显式connect、取消检查和request之间存在调度窗口：interrupt关闭sock后，HTTPConnection默认自动重连，close返回后真实loopback仍收到同步POST。现`_Request.__init__`明确设置`connection.auto_open=0`(:23)，保留显式connect，取消后的send不能重开连接。新增`test_cancellation_before_send_cannot_reopen_connection`用真实网络及发送前Event屏障同时覆盖close和timer，断言worker结束、固定错误码、服务端零请求；复核通过。
- **[P2，已关闭] chunked trailer绕过响应预算**。初版read(4097)只限制解码正文，getheaders未包含trailer；真实raw loopback的14字节JSON与32,000字节trailer曾被接受。现:93拒绝任何Transfer-Encoding，在正文解析前拒绝chunked；新增`test_chunked_trailers_cannot_bypass_response_budget`使用正确十六进制chunk长度`e`和32KB trailer，复核拒绝。内部服务端必须遵守定长JSON响应合同（可接受关闭定界），不得改成chunked后声称集成兼容。

上述关闭针对原两个具体反例；不是对所有网络层行为、总传输字节或宿主认证装配的泛化认证。

## 已核实行为

- 固定127.0.0.1、端口、UUID owner与内部token；synchronize无URL/owner/token入参；HTTPConnection不读代理、不跟随重定向。
- 错误固定码、单次请求、无本地fallback；拒绝非法revision、重复JSON键、非法UTF-8、额外字段、不符媒体/内容编码和非法framing。
- Timer真实打断等响应头与持续滴流正文；HTTP/1.0清空connection.sock后仍由保留transport引用打断。
- Handoff.stop锁内停止本地新租约；已有同线程嵌套租约可排空；activate要求active=0且只安装一次；远端失败不恢复本地。
- `skill_library._connect`租约包住psycopg连接退出；目录公开同步入口经handoff，prepare转调公开同步；只读check_only不写路径保留。

## 实际复验

- 通过既有`createStorageFixture`创建本轮随机`notalone_ts_host_*_test`，原迁移建结构；明确设置NOTALONE_TEST_DATABASE_URL、NOTALONE_DISABLE_DOTENV=1、PYTHONPATH，不读项目.env；结束DROP本轮库。
- 固定Python `$HOME/miniconda3/envs/NotAlone/bin/python`执行三个unittest模块：`backend.tests.unit.persistence.test_skill_management_remote`、`backend.tests.unit.persistence.test_skill_management_handoff`、`backend.tests.integration.persistence.test_skill_management_handoff`。
- 本轮进程在60秒上限内退出0；**21项通过、真实PG三例执行，无skip**。RPC新增两例含close/timer两个分支，不以初版16项通过代替修复验证。
- PG覆盖：管理停收、目录刷新走远端且库版本不新增；远端失败不发现工作目录待更新；已有真实管理事务排空；15持owner锁的rollback_locked仍可完成。
- PG远端回调是显式测试替身，证明移交路由与本地不写；RPC协议另用真实loopback覆盖。两者组合不等于真实TS宿主业务入口验收。
- 原复核仅通过事件屏障控制HTTPConnection.request调度，未替换底层网络/响应；两个原失败反例与后续修复证据保留于本记录，不再列开放finding。

## 仍需宿主验收的边界

- 服务器/应用入口的RemoteSkillManagement实例、独立内部token生成与校验、stop/activate顺序、固定owner、定长JSON、关闭顺序需主任务实际接线验证；当前未将其记作已完成。
- 内部token必须独立于公开API凭据；客户端只验证配置格式，不证明实际宿主凭据分离。
- 尚未执行真实TS profile HTTP、开发App完整闭环；本复核没有真实模型、App/微信占用或私人资料读取。

本轮只修改此审查记录，未修改产品源码或测试，未执行Git、打包或推送。
