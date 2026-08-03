/** M-Team 动态下载草稿使用的稳定适配器标识。 */
export const MTEAM_DOWNLOAD_ADAPTER = "mteam-dynamic-download";

/**
 * 判断草稿是否需要通过 M-Team 页面登录态生成临时下载地址。
 *
 * 同时校验详情页主机、路径和种子 ID，防止伪造草稿借用 M-Team 适配器在无关页面
 * 执行主环境脚本。
 *
 * @param {object} draft 待发送的种子草稿。
 * @returns {boolean} 草稿属于受支持的 M-Team 详情页时返回 true。
 * @sideEffects 无副作用，不读取页面存储或发起网络请求。
 */
export function isMTeamDynamicDraft(draft) {
  if (draft?.downloadAdapter !== MTEAM_DOWNLOAD_ADAPTER) {
    return false;
  }

  const torrentId = String(draft?.torrentId ?? "").trim();
  if (!/^\d+$/.test(torrentId)) {
    return false;
  }

  try {
    const pageUrl = new URL(draft?.pageUrl);
    return pageUrl.hostname === "kp.m-team.cc"
      && new RegExp(`^/detail/${torrentId}/?$`).test(pageUrl.pathname);
  } catch {
    return false;
  }
}

/**
 * 在 M-Team 页面主环境中生成当前种子的临时下载地址。
 *
 * 此函数会被 `chrome.scripting.executeScript` 序列化后在 MAIN world 中执行，因此必须
 * 保持完全自包含。M-Team 下载按钮并不存在静态 href，而是使用页面本地登录态调用
 * `/torrent/genDlToken`；这里复现其公开 Web 客户端协议，并只把最终临时 URL 返回扩展。
 * 页面中的 authorization、did 和 visitorId 不会跨越脚本执行结果，也不会写入扩展存储。
 *
 * @param {string|number} torrentId M-Team 详情页中的数字种子 ID。
 * @returns {Promise<string>} 可由 MoviePilot 立即下载的 HTTP(S) 临时地址。
 * @throws {Error} 页面不匹配、登录态缺失、签名失败、接口失败或返回地址不安全时抛出。
 * @sideEffects 读取当前 M-Team 页面的必要登录态，并向受限的 M-Team API 主机发起一次
 * POST 请求；服务端会生成一个短期下载令牌，但函数本身不会触发浏览器下载。
 */
export async function resolveMTeamDownloadUrlFromPage(torrentId) {
  const normalizedId = String(torrentId ?? "").trim();
  if (
    location.hostname !== "kp.m-team.cc"
    || !/^\d+$/.test(normalizedId)
    || !new RegExp(`^/detail/${normalizedId}/?$`).test(location.pathname)
  ) {
    throw new Error("当前页面不是对应的 M-Team 资源详情页");
  }

  const apiHosts = [
    "https://api.m-team.cc/api",
    "https://api.m-team.io/api",
    "https://api2.m-team.cc/api"
  ];
  const storedApiHost = String(localStorage.getItem("apiHost") ?? "")
    .trim()
    .replace(/\/+$/, "");
  // 页面存储值不能直接作为凭据发送目标，只允许使用 M-Team Web 客户端公开的 API 列表。
  const apiHost = apiHosts.includes(storedApiHost) ? storedApiHost : apiHosts[0];
  const authorization = String(localStorage.getItem("auth") ?? "").trim();
  if (!authorization) {
    throw new Error("M-Team 登录状态不可用，请重新登录资源页后重试");
  }

  const endpointPath = "/torrent/genDlToken";
  const requestUrl = `${apiHost}${endpointPath}`;
  const timestamp = Date.now();
  const signingText = `POST&${new URL(requestUrl).pathname}&${timestamp}`;

  // 该 HMAC key 与字段拼写来自 M-Team 公开 Web 客户端，不是用户凭据；`_sgin` 是站点协议原名。
  const signingKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("HLkPcWmycL57mfJt"),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const signatureBytes = await crypto.subtle.sign(
    "HMAC",
    signingKey,
    new TextEncoder().encode(signingText)
  );
  const signature = btoa(
    String.fromCharCode(...new Uint8Array(signatureBytes))
  );

  const body = new FormData();
  body.append("id", normalizedId);
  body.append("_timestamp", String(timestamp));
  body.append("_sgin", signature);

  const headers = {
    authorization,
    ts: String(Math.floor(Date.now() / 1000)),
    version: "1.1.7",
    visitorId: String(localStorage.getItem("visitorId") ?? ""),
    webVersion: "1170"
  };
  const did = String(localStorage.getItem("did") ?? "").trim();
  if (did) {
    headers.did = did;
  }

  let response;
  try {
    response = await fetch(requestUrl, {
      method: "POST",
      credentials: "include",
      headers,
      body
    });
  } catch {
    throw new Error("无法连接 M-Team 下载接口，请稍后重试");
  }
  if (!response.ok) {
    throw new Error(`M-Team 下载接口请求失败（HTTP ${response.status}）`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("M-Team 下载接口返回了无法解析的响应");
  }
  if (Number(payload?.code) !== 0) {
    const message = typeof payload?.message === "string" && payload.message.trim()
      ? payload.message.trim()
      : "M-Team 无法生成临时下载地址";
    throw new Error(message);
  }

  let downloadUrl;
  try {
    downloadUrl = new URL(String(payload?.data ?? ""), location.origin);
  } catch {
    throw new Error("M-Team 返回的临时下载地址无效");
  }
  const trustedDownloadHost = downloadUrl.hostname === "m-team.cc"
    || downloadUrl.hostname.endsWith(".m-team.cc")
    || downloadUrl.hostname === "m-team.io"
    || downloadUrl.hostname.endsWith(".m-team.io");
  if (!new Set(["http:", "https:"]).has(downloadUrl.protocol) || !trustedDownloadHost) {
    // 临时 URL 会与 PT Cookie 一起交给 MoviePilot，必须阻止异常响应把凭据带到外部主机。
    throw new Error("M-Team 返回了不受信任的下载地址");
  }

  downloadUrl.searchParams.set("useHttps", "true");
  downloadUrl.searchParams.set("type", "");
  return downloadUrl.href;
}
