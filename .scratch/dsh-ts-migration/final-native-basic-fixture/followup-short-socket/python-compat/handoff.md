# 当前夹具入口：保留 26 前兼容路径

- 当前工具源码是祖目录 `fixture.mjs`；本目录 manifest 固定最新 SHA。上一级短 socket / 构建 / watch 记录及最初 E5D / 700 文件记录均保留原件，属于各自阶段历史。
- `prepare({pythonExecutable: absoluteExistingPythonPath})` 接受显式兼容路径；未传时按工程约定定位本人已安装的 Conda NotAlone Python。只做 realpath、文件与执行权限核验，不读原 backend-launch/.env，不执行 Python，不查询版本。
- 该路径只写入私有 session 和 backend-launch 的兼容字段；全部 runtime 仍显式 typescript。Node 不能作为 Python 路径，负例在创建资源前拒绝。
- 必要性来自当前 `desktop/src/main/backend/host.ts:239` 的非空字段检查；字段尚未退役，不以 TS 配置推断最终 0Py。旧 noPythonInvocations 与本目录 pythonInvocationsByThisTool 仅描述测试工具，产品进程是否执行 Python 留给 root 实测。
- 此版继续保留短自有 TMPDIR、必要 desktop 根模块/配置与空 Python watch 根。新快照 704 文件，见 staging-source.sha256；与旧 E5D 700 pin 分开。
- 有限检查：Node 24+ 执行本目录 verify.mjs。已通过显式路径与拒绝 Node、跨进程 inspect/close、88 字节 socket 获取/复用/释放/重获、三个真实 watch 根开关、main/preload/renderer 仅构建，以及自有库/目录清理。
- 不运行旧 self-check.mjs 或上级 lease-regression.mjs 覆盖已冻结的历史 verification。新检查的结果只写本目录；原始路径与配置只在临时私有目录。
- 未启动 Electron、DSH、微信、模型；未操作 root 当前实例、临时目录或原资料，未改产品/index。root 当前私有修补实例仍由 root 收尾。
- root 的最终实际 App 验收应另行新 prepare，核对本目录 manifest 与新生成源码清单后，以 npm run dev + CUA 执行。构建通过不等于实际 GUI 或最终 0Py 通过。
