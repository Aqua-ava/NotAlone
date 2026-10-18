// 当前仓库限定热更新开发。没有环境变量、命令参数或 Agent 可填写的确认口令。
// 后续只有用户明确提出发布任务，才可在该任务中审查并调整此门禁。
export function requireReleaseWorkflow() {
  throw new Error('当前仓库仅允许热更新开发：请使用 npm run dev。打包入口已锁定；需要用户明确发起发布任务后另行调整发布流程。不得为测试、权限排查或验收自行解除。');
}
