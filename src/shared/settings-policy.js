/** 右键直发和识别确认使用不同 ID，避免点击后再次猜测菜单意图。 */
export const CONTEXT_MENU_IDS = Object.freeze({
  DIRECT_SEND: "moviepilot-direct-send",
  RECOGNIZE_SEND: "moviepilot-recognize-send"
});

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
 * 生成统一的右键菜单标题，避免把内部识别策略暴露在命令名称中。
 *
 * @param {object} settings 扩展设置对象。
 * @returns {string} 可直接传给 chrome.contextMenus 的菜单标题。
 * @sideEffects 无副作用。
 */
export function getContextMenuTitle(settings) {
  return getContextMenuDefinition(settings).title;
}

/**
 * 生成与当前识别策略绑定的右键菜单定义。
 *
 * 菜单 ID 同时表达点击意图，使直发处理器无需再次读取识别配置，也不会进入弹窗路径。
 *
 * @param {object} settings 扩展设置对象。
 * @returns {{id: string, title: string, requiresConfirmation: boolean}} 菜单 ID、标题和确认模式。
 * @sideEffects 无副作用。
 */
export function getContextMenuDefinition(settings) {
  const requiresConfirmation = isRecognitionConfirmationEnabled(settings);
  return {
    id: requiresConfirmation
      ? CONTEXT_MENU_IDS.RECOGNIZE_SEND
      : CONTEXT_MENU_IDS.DIRECT_SEND,
    title: "发送到 MoviePilot",
    requiresConfirmation
  };
}
