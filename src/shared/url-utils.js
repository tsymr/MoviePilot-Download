import { API_PREFIX } from "./constants.js";

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * 规范化 MoviePilot 服务地址，并保留反向代理使用的路径前缀。
 *
 * @param {string} rawUrl 用户填写的 MoviePilot 地址。
 * @returns {string} 不带结尾斜杠和 `/api/v1` 的规范地址。
 * @throws {TypeError} 地址为空、协议不受支持或包含用户名密码时抛出。
 * @sideEffects 无副作用。
 */
export function normalizeBaseUrl(rawUrl) {
  const input = String(rawUrl ?? "").trim();
  if (!input) {
    throw new TypeError("请填写 MoviePilot 地址");
  }

  const value = /^[a-z][a-z\d+.-]*:\/\//i.test(input)
    ? input
    : `http://${input}`;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("MoviePilot 地址格式不正确");
  }

  if (!HTTP_PROTOCOLS.has(parsed.protocol)) {
    throw new TypeError("MoviePilot 地址仅支持 HTTP 或 HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new TypeError("MoviePilot 地址不能包含用户名或密码");
  }

  parsed.search = "";
  parsed.hash = "";
  const pathname = parsed.pathname
    .replace(/\/+$/, "")
    .replace(/\/api\/v1$/i, "");

  return `${parsed.origin}${pathname === "/" ? "" : pathname}`;
}

/**
 * 构造 MoviePilot API URL，避免反向代理路径被 URL 解析规则覆盖。
 *
 * @param {string} baseUrl MoviePilot 服务地址。
 * @param {string} apiPath `/api/v1` 之后的接口路径。
 * @returns {string} 可直接请求的完整 URL。
 * @throws {TypeError} 服务地址无效时抛出。
 * @sideEffects 无副作用。
 */
export function buildApiUrl(baseUrl, apiPath) {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const normalizedPath = `/${String(apiPath ?? "").replace(/^\/+/, "")}`;
  return `${normalizedBase}${API_PREFIX}${normalizedPath}`;
}

/**
 * 将普通 URL 转换为 Chrome 可申请的最小主机权限模式。
 *
 * Chrome 匹配模式省略端口时会匹配全部端口，因此这里始终写入实际端口；
 * URL 未显式填写端口时使用协议默认的 80 或 443，避免扩大授权范围。
 *
 * @param {string} rawUrl HTTP 或 HTTPS URL。
 * @returns {string} Chrome host permission 匹配模式。
 * @throws {TypeError} URL 或协议无效时抛出。
 * @sideEffects 无副作用。
 */
export function toHostPermissionPattern(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new TypeError("无法为无效地址申请访问权限");
  }

  if (!HTTP_PROTOCOLS.has(parsed.protocol)) {
    throw new TypeError("只能为 HTTP 或 HTTPS 地址申请访问权限");
  }
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return `${parsed.protocol}//${parsed.hostname}:${port}/*`;
}

/**
 * 判断链接是否可以交给 MoviePilot 下载接口处理。
 *
 * @param {string} rawUrl 待检查的种子或磁力链接。
 * @returns {boolean} HTTP(S) 或 magnet 链接返回 true。
 * @sideEffects 无副作用，也不会发起网络请求。
 */
export function isSupportedTorrentUrl(rawUrl) {
  const value = String(rawUrl ?? "").trim();
  if (/^magnet:\?/i.test(value)) {
    return true;
  }

  try {
    return HTTP_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * 从详情页或下载链接推导站点名称，用于 MoviePilot 下载记录与通知。
 *
 * @param {string} pageUrl 当前 PT 页面 URL。
 * @param {string} enclosure 种子下载链接。
 * @returns {string} 可识别的主机名；两者均无效时返回“手动发送”。
 * @sideEffects 无副作用。
 */
export function inferSiteName(pageUrl, enclosure) {
  for (const candidate of [pageUrl, enclosure]) {
    try {
      const parsed = new URL(candidate);
      if (HTTP_PROTOCOLS.has(parsed.protocol)) {
        return parsed.hostname;
      }
    } catch {
      // 磁力链接和空值没有站点主机，继续尝试下一个来源。
    }
  }
  return "手动发送";
}
