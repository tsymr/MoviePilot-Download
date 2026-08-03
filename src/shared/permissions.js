import { normalizeBaseUrl, toHostPermissionPattern } from "./url-utils.js";

/**
 * 检查扩展是否已获得目标 MoviePilot 主机的访问权限。
 *
 * @param {string} baseUrl MoviePilot 服务地址。
 * @returns {Promise<boolean>} 已授权时返回 true。
 * @throws {TypeError} 地址无效时抛出。
 * @sideEffects 读取 Chrome 权限状态，不弹窗、不修改权限。
 */
export async function hasMoviePilotPermission(baseUrl) {
  const pattern = toHostPermissionPattern(normalizeBaseUrl(baseUrl));
  return chrome.permissions.contains({ origins: [pattern] });
}

/**
 * 请求访问 MoviePilot 主机。
 *
 * 必须由用户点击事件直接调用，否则 Chrome 会拒绝弹出权限确认。
 *
 * @param {string} baseUrl MoviePilot 服务地址。
 * @returns {Promise<boolean>} 用户授予权限时返回 true。
 * @throws {TypeError} 地址无效时抛出。
 * @throws {Error} Chrome 权限 API 调用失败时 Promise 会拒绝。
 * @sideEffects 可能弹出 Chrome 主机权限确认框并修改扩展权限。
 */
export async function requestMoviePilotPermission(baseUrl) {
  const pattern = toHostPermissionPattern(normalizeBaseUrl(baseUrl));
  return chrome.permissions.request({ origins: [pattern] });
}

/**
 * 请求发送种子所需的最小主机与 Cookie 权限。
 *
 * MoviePilot 主机始终需要授权；仅当用户启用 Cookie 且种子是 HTTP(S) 链接时，
 * 才请求实际下载主机和 cookies 权限。每个主机模式均固定实际端口，不扩展到同一
 * 主机的其他端口。
 *
 * @param {string} baseUrl MoviePilot 服务地址。
 * @param {object} draft 种子草稿，包含 enclosure 下载链接。
 * @param {boolean} includeCookies 本次是否读取 PT Cookie。
 * @returns {Promise<boolean>} 全部权限获准时返回 true。
 * @throws {TypeError} MoviePilot 地址无效时抛出。
 * @throws {Error} Chrome 权限 API 调用失败时 Promise 会拒绝。
 * @sideEffects 可能弹出 Chrome 权限确认框并修改扩展权限。
 */
export async function requestSendPermissions(baseUrl, draft, includeCookies) {
  const origins = new Set([
    toHostPermissionPattern(normalizeBaseUrl(baseUrl))
  ]);
  const permissions = [];

  if (includeCookies) {
    try {
      origins.add(toHostPermissionPattern(draft?.enclosure));
      permissions.push("cookies");
    } catch {
      // magnet 链接没有可读取的 Cookie 主机，不应请求无意义的 Cookie 权限。
    }
  }

  const request = { origins: [...origins] };
  if (permissions.length) {
    request.permissions = permissions;
  }
  return chrome.permissions.request(request);
}
