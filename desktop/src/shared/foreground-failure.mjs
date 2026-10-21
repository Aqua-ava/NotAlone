// 当前帧上下文变化不证明联系人匹配失败；必须由下一轮重新取得完整的已有绑定证据。
const transientContextChanges = new Set([
  'automatic_capture_context_changed',
  'automatic_capture_window_metadata_changed', 'automatic_capture_dimensions_changed',
]);
export function isTransientForegroundContextChange(code) {
  return transientContextChanges.has(code);
}

export function isUnsupportedForegroundConversation(code) {
  return code === 'group_chat_unsupported' || code === 'group_chat_suspected';
}

// 这些原因表示已取得候选但需要用户手动选择/确认，不是技术失败，也不应清空已有资格。
const awaitingSelectionReasons = new Set([
  'ambiguous_requires_selection', 'unmatched_requires_selection',
  'session_candidates_truncated', 'manual_confirmation_required',
]);

export function isAwaitingForegroundSelection(code) {
  return awaitingSelectionReasons.has(code);
}

// 成功码与群聊码不进入失败说明映射，但属于已知协议，不算未知原因。
const knownNonFailureReasons = new Set(['confirmed_active_binding']);

// 固定协议原因的中文说明；不显示原生原文、会话名称或任意reason字符串。
const reasons = Object.freeze({
  foreground_application_unavailable: ['前台检查', '系统未返回前台应用'],
  calibration_wechat_instances_ambiguous: ['前台检查', '微信运行实例不唯一'],
  calibration_wechat_version_unsupported: ['前台检查', '当前微信版本尚未适配'],
  calibration_window_not_visible: ['窗口检查', '微信聊天窗口不可见'],
  calibration_windows_ambiguous: ['窗口检查', '无法确定唯一微信聊天窗口'],
  calibration_window_geometry_invalid: ['窗口检查', '微信窗口尺寸不符合识别条件'],
  calibration_context_unavailable: ['前台检查', '微信前台或窗口上下文未通过'],
  automatic_capture_context_changed: ['窗口采集', '采集期间微信前台或窗口发生变化'],
  automatic_capture_window_metadata_changed: ['窗口采集', '采集时微信窗口信息发生变化'],
  automatic_capture_scale_invalid: ['窗口采集', '窗口像素比例不受支持'],
  automatic_capture_dimensions_changed: ['窗口采集', '采集期间微信窗口尺寸发生变化'],
  automatic_layout_vertical_boundary: ['布局定位', '未能确定会话区域的竖向边界'],
  automatic_layout_header_boundary: ['布局定位', '未能确定顶部名称区域'],
  automatic_layout_selection_ambiguous: ['布局定位', '未能确定唯一选中会话行'],
  automatic_layout_sidebar_boundary: ['布局定位', '未能确定侧栏边界'],
  minimal_region_layout_unverified: ['布局定位', '名称区域布局尚未验证'],
  minimal_region_layout_changed: ['布局定位', '采集前后窗口布局发生变化'],
  screen_capture_permission_missing: ['窗口采集', '缺少屏幕录制权限'],
  minimal_region_capture_failed: ['窗口采集', '原生图像采集未成功'],
  quality_unverified: ['名称识别', '名称识别质量未通过'],
  header_name_unreadable: ['名称识别', '顶部会话名称无法完整识别'],
  row_name_unreadable: ['名称识别', '选中行会话名称无法完整识别'],
  session_names_mismatch: ['名称识别', '同帧两处会话名称不一致'],
  session_name_confidence_low: ['名称识别', '名称识别置信度不足'],
  wechat_not_in_front: ['前台检查', '微信不在前台'],
  sync_disabled: ['前台检查', '同步总开关已关闭'],
  sync_gate_unavailable: ['前台检查', '同步总开关状态暂时不可确认'],
  minimal_region_unavailable: ['窗口采集', '最小名称区域采集不可用'],
  probe_not_found: ['探针启动', '正式探针不可用'],
  probe_timeout: ['探针执行', '正式探针执行超时'],
  probe_output_invalid: ['探针结果', '正式探针返回格式未通过'],
  probe_failed: ['探针执行', '正式探针失败，尚无分项原因'],
  observation_timeout: ['后端观察', '本轮观察超时'],
  observation_unavailable: ['后端观察', '本轮观察传输失败'],
  foreground_observation_busy: ['后端观察', '本轮观察繁忙，等待重新识别'],
  binding_verification_unavailable: ['联系人匹配', '会话绑定校验暂不可用'],
  session_candidates_truncated: ['联系人匹配', '候选会话过多，需要手动选择'],
  contact_unavailable: ['联系人匹配', '当前联系人不可用'],
  ambiguous_requires_selection: ['联系人匹配', '同名或会话不唯一，需要手动选择'],
  unmatched_requires_selection: ['联系人匹配', '未找到当前已确认的唯一绑定'],
  manual_confirmation_required: ['联系人匹配', '识别已恢复，需要在助手内确认本次联系人'],
});

export function isKnownForegroundReason(code) {
  return typeof code === 'string' && (Object.hasOwn(reasons, code)
    || isTransientForegroundContextChange(code) || isUnsupportedForegroundConversation(code)
    || knownNonFailureReasons.has(code));
}

export function foregroundFailureReason(code) {
  if (typeof code !== 'string' || !Object.hasOwn(reasons, code)) return null;
  const [layer, message] = reasons[code];
  return { code, layer, message };
}
