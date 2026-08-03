/**
 * 判断当前设置是否要求在下载前展示识别确认弹窗。
 *
 * 只有严格的布尔值 true 才开启确认，避免旧版或手工写入的字符串 "false"
 * 被 JavaScript 当作真值，导致用户关闭开关后仍然弹窗。
 *
 * @param {object} settings 扩展设置对象。
 * @returns {boolean} 需要识别确认时返回 true，否则返回 false。
 * @sideEffects 无副作用。
 */
export function isRecognitionConfirmationEnabled(settings) {
  return settings?.recognizeBeforeDownload === true;
}

/**
 * 根据识别确认策略生成与实际点击行为一致的右键菜单标题。
 *
 * @param {object} settings 扩展设置对象。
 * @returns {string} 可直接传给 chrome.contextMenus 的菜单标题。
 * @sideEffects 无副作用。
 */
export function getContextMenuTitle(settings) {
  return isRecognitionConfirmationEnabled(settings)
    ? "识别并发送到 MoviePilot"
    : "直接发送到 MoviePilot";
}
