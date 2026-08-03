import {
  DEFAULT_SETTINGS,
  PENDING_DRAFT_KEY,
  SETTINGS_KEY
} from "./constants.js";
import { normalizeBaseUrl } from "./url-utils.js";

/**
 * 读取扩展设置。
 *
 * @returns {Promise<object>} 合并默认值后的设置对象。
 * @throws {Error} Chrome 本地存储不可用时 Promise 会拒绝。
 * @sideEffects 读取 chrome.storage.local，不修改任何数据。
 */
export async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const saved = stored[SETTINGS_KEY] ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    includeCookiesByDefault: saved.includeCookiesByDefault === undefined
      ? DEFAULT_SETTINGS.includeCookiesByDefault
      : saved.includeCookiesByDefault === true,
    recognizeBeforeDownload: saved.recognizeBeforeDownload === true
  };
}

/**
 * 校验并保存扩展设置。
 *
 * API Token 刻意使用 local 区域而不是 sync 区域，降低受信集成凭据在设备间扩散的风险。
 *
 * @param {object} input 表单提交的原始设置。
 * @returns {Promise<object>} 已规范化并完成保存的设置。
 * @throws {TypeError} 地址无效或 API Token 缺失时抛出。
 * @throws {Error} Chrome 本地存储写入失败时 Promise 会拒绝。
 * @sideEffects 覆盖 chrome.storage.local 中的扩展设置。
 */
export async function saveSettings(input) {
  const apiToken = String(input?.apiToken ?? "").trim();
  if (!apiToken) {
    throw new TypeError("请填写 MoviePilot API Token");
  }
  if (apiToken.length < 16) {
    throw new TypeError("MoviePilot API Token 至少需要 16 个字符");
  }

  const settings = {
    baseUrl: normalizeBaseUrl(input?.baseUrl),
    apiToken,
    includeCookiesByDefault: input?.includeCookiesByDefault === true,
    recognizeBeforeDownload: input?.recognizeBeforeDownload === true,
    defaultDownloader: String(input?.defaultDownloader ?? "").trim(),
    defaultSavePath: String(input?.defaultSavePath ?? "").trim()
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

/**
 * 单独保存“发送前识别并确认”开关，使该开关无需等待整张设置表单提交即可生效。
 *
 * @param {boolean} enabled 是否开启识别确认，仅严格的 true 会开启。
 * @returns {Promise<object>} 更新后的完整设置对象。
 * @throws {Error} Chrome 本地存储读取或写入失败时 Promise 会拒绝。
 * @sideEffects 覆盖 chrome.storage.local 中的扩展设置，并触发后台重建右键菜单。
 */
export async function saveRecognitionPreference(enabled) {
  const settings = {
    ...await getSettings(),
    recognizeBeforeDownload: enabled === true
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

/**
 * 在当前浏览器会话中暂存右键菜单生成的种子草稿。
 *
 * @param {object} draft 不包含 Cookie 和 API Token 的页面提取结果。
 * @returns {Promise<void>} 保存完成后解决。
 * @throws {Error} 会话存储写入失败时 Promise 会拒绝。
 * @sideEffects 写入 chrome.storage.session；浏览器关闭后自动丢弃。
 */
export async function setPendingDraft(draft) {
  await chrome.storage.session.set({ [PENDING_DRAFT_KEY]: draft });
}

/**
 * 读取并消费右键菜单生成的种子草稿。
 *
 * @returns {Promise<object|null>} 草稿不存在时返回 null。
 * @throws {Error} 会话存储访问失败时 Promise 会拒绝。
 * @sideEffects 成功读取后删除 chrome.storage.session 中的草稿，防止误发旧链接。
 */
export async function takePendingDraft() {
  const stored = await chrome.storage.session.get(PENDING_DRAFT_KEY);
  const draft = stored[PENDING_DRAFT_KEY] ?? null;
  if (draft) {
    await chrome.storage.session.remove(PENDING_DRAFT_KEY);
  }
  return draft;
}
