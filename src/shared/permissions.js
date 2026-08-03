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
 * 请求当前配置所需的 MoviePilot 主机与 Cookie 权限。
 *
 * MoviePilot 主机始终需要授权。PT 页面主机由用户点击扩展时产生的 activeTab 临时
 * 权限覆盖，因此这里只按配置申请 cookies 权限，避免扩展获得长期的 PT 站访问权。
 * 配置关闭 Cookie 时会撤销此前授予的 cookies 权限，但发送逻辑仍会再次检查配置，
 * 不会因为浏览器权限残留而读取 Cookie。
 *
 * @param {string} baseUrl MoviePilot 服务地址。
 * @param {boolean} includeCookies 配置是否要求附带当前 PT 站 Cookie。
 * @returns {Promise<boolean>} 全部权限获准时返回 true。
 * @throws {TypeError} MoviePilot 地址无效时抛出。
 * @throws {Error} Chrome 权限 API 调用失败时 Promise 会拒绝。
 * @sideEffects 可能弹出 Chrome 权限确认框；配置关闭时可能撤销 cookies 权限。
 */
export async function requestSendPermissions(baseUrl, includeCookies) {
  const request = {
    origins: [toHostPermissionPattern(normalizeBaseUrl(baseUrl))]
  };
  if (includeCookies) {
    request.permissions = ["cookies"];
  }

  const granted = await chrome.permissions.request(request);
  if (granted && !includeCookies) {
    // 主动撤销旧权限，使浏览器权限面板也与用户当前配置保持一致。
    await chrome.permissions.remove({ permissions: ["cookies"] });
  }
  return granted;
}
