import { buildApiUrl, inferSiteName, isSupportedTorrentUrl } from "./url-utils.js";

const DEFAULT_TIMEOUT_MS = 45_000;
const SUPPORTED_MEDIA_SOURCES = new Set([
  "themoviedb",
  "douban",
  "bangumi",
  "anilist"
]);
const SUPPORTED_MEDIA_TYPES = new Set(["电影", "电视剧"]);

/**
 * 校验页面草稿携带的媒体数据源标识，避免把页面中的任意文本拼入 API 路径或请求体。
 *
 * @param {object} draft 页面提取的种子草稿。
 * @returns {{source: string, id: string, type: string}|null} 合法媒体标识；无标识时返回 null。
 * @sideEffects 无副作用。
 */
function getDraftMediaIdentity(draft) {
  const source = String(draft?.mediaSource ?? "").trim().toLowerCase();
  const id = String(draft?.mediaId ?? "").trim();
  if (!SUPPORTED_MEDIA_SOURCES.has(source) || !/^\d+$/.test(id)) {
    return null;
  }
  const mediaType = String(draft?.mediaType ?? "").trim();
  return {
    source,
    id,
    type: SUPPORTED_MEDIA_TYPES.has(mediaType) ? mediaType : ""
  };
}

/**
 * MoviePilot 请求失败时使用的结构化错误。
 *
 * 错误对象只保留 HTTP 状态和接口返回消息，不记录 API Token、Cookie 或完整请求体。
 */
export class MoviePilotApiError extends Error {
  /**
   * 创建 MoviePilot API 错误。
   *
   * @param {string} message 可直接展示给用户的错误信息。
   * @param {object} [details] 非敏感错误上下文。
   * @param {number} [details.status] HTTP 状态码，网络错误时为 0。
   * @param {string} [details.code] 稳定的扩展内部错误码。
   * @sideEffects 无副作用。
   */
  constructor(message, { status = 0, code = "MOVIEPILOT_ERROR" } = {}) {
    super(message);
    this.name = "MoviePilotApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * 从响应载荷中选择可展示的错误文本。
 *
 * @param {unknown} payload MoviePilot 返回的 JSON 值。
 * @param {number} status HTTP 状态码。
 * @returns {string} 不包含本地凭据的错误信息。
 * @sideEffects 无副作用。
 */
function getResponseMessage(payload, status) {
  if (payload && typeof payload === "object") {
    const message = payload.message_i18n ?? payload.message ?? payload.detail;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
    if (Array.isArray(message) && typeof message[0]?.msg === "string") {
      return message[0].msg;
    }
  }
  return `MoviePilot 请求失败（HTTP ${status}）`;
}

/**
 * 请求 MoviePilot JSON API，并统一处理超时、鉴权与业务错误。
 *
 * @param {object} settings 包含 baseUrl 和 apiToken 的扩展设置。
 * @param {string} apiPath `/api/v1` 后的接口路径，可包含查询参数。
 * @param {object} [options] 请求参数。
 * @param {string} [options.method] HTTP 方法。
 * @param {unknown} [options.body] 需要 JSON 序列化的请求体。
 * @param {number} [options.timeoutMs] 超时时间。
 * @param {typeof fetch} [options.fetchImpl] 测试时可注入的 fetch 实现。
 * @returns {Promise<unknown>} 解析后的 JSON 响应。
 * @throws {MoviePilotApiError} 网络、超时、HTTP 或业务响应失败时抛出。
 * @sideEffects 向用户配置的 MoviePilot 主机发起一次网络请求。
 */
async function requestJson(
  settings,
  apiPath,
  {
    method = "GET",
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch
  } = {}
) {
  if (!settings?.apiToken) {
    throw new MoviePilotApiError("尚未配置 MoviePilot API Token", {
      code: "NOT_CONFIGURED"
    });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(buildApiUrl(settings.baseUrl, apiPath), {
      method,
      headers: {
        Accept: "application/json",
        "Accept-Language": "zh-CN",
        "Content-Type": "application/json",
        "X-API-KEY": settings.apiToken
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });

    const rawText = await response.text();
    let payload = null;
    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        throw new MoviePilotApiError("MoviePilot 返回了无法解析的响应", {
          status: response.status,
          code: "INVALID_RESPONSE"
        });
      }
    }

    if (!response.ok) {
      throw new MoviePilotApiError(
        getResponseMessage(payload, response.status),
        { status: response.status, code: "HTTP_ERROR" }
      );
    }
    return payload;
  } catch (error) {
    if (error instanceof MoviePilotApiError) {
      throw error;
    }
    if (error?.name === "AbortError") {
      throw new MoviePilotApiError("MoviePilot 请求超时，请检查服务状态", {
        code: "TIMEOUT"
      });
    }
    throw new MoviePilotApiError("无法连接 MoviePilot，请检查地址和访问权限", {
      code: "NETWORK_ERROR"
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 测试 MoviePilot 连接并读取可用下载器与下载目录。
 *
 * @param {object} settings 扩展设置。
 * @param {typeof fetch} [fetchImpl] 测试时可注入的 fetch 实现。
 * @returns {Promise<{downloaders: Array, paths: Array}>} MoviePilot 当前可用选项。
 * @throws {MoviePilotApiError} 连接或鉴权失败时抛出。
 * @sideEffects 并行向 MoviePilot 发起两次只读请求。
 */
export async function testConnection(settings, fetchImpl = globalThis.fetch) {
  const [downloaders, paths] = await Promise.all([
    requestJson(settings, "/download/clients", { fetchImpl }),
    requestJson(settings, "/download/paths", { fetchImpl })
  ]);
  return {
    downloaders: Array.isArray(downloaders) ? downloaders : [],
    paths: Array.isArray(paths) ? paths : []
  };
}

/**
 * 调用 MoviePilot 的媒体识别接口预览标题、年份、类型与分类。
 *
 * 页面提供可信数据源 ID 和媒体类型时优先按 ID 查询；ID 查询无结果或接口版本
 * 不支持时，再使用表单当前显示的发布标题进行普通识别。两条路径必须使用同一个标题，
 * 避免用户看到、编辑的标题与实际请求不一致。
 *
 * @param {object} settings 扩展设置。
 * @param {object} draft 当前种子草稿。
 * @param {typeof fetch} [fetchImpl] 测试时可注入的 fetch 实现。
 * @returns {Promise<object>} MoviePilot 返回的 Context 数据。
 * @throws {TypeError} 草稿没有标题时抛出。
 * @throws {MoviePilotApiError} 识别请求失败时抛出。
 * @sideEffects 向 MoviePilot 发起一至两次只读识别请求，MoviePilot 可能继续访问其元数据源。
 */
export async function recognizeTorrent(
  settings,
  draft,
  fetchImpl = globalThis.fetch
) {
  const title = String(draft?.title ?? "").trim();
  if (!title) {
    throw new TypeError("请先填写种子标题");
  }

  const identity = getDraftMediaIdentity(draft);
  if (identity?.type) {
    const detailQuery = new URLSearchParams({
      type_name: identity.type,
      title
    });
    const year = title.match(/(?:^|\D)((?:19|20)\d{2})(?!\d)/)?.[1];
    if (year) {
      detailQuery.set("year", year);
    }

    try {
      const mediaInfo = await requestJson(
        settings,
        `/media/${encodeURIComponent(`${identity.source}:${identity.id}`)}`
          + `?${detailQuery.toString()}`,
        { fetchImpl }
      );
      if (mediaInfo?.title) {
        return { media_info: mediaInfo, meta_info: {} };
      }
    } catch (error) {
      // 旧版 MoviePilot 可能没有带来源前缀的详情接口，仅对“接口不存在/参数不兼容”降级。
      if (!(error instanceof MoviePilotApiError)
        || !new Set([404, 405, 422]).has(error.status)) {
        throw error;
      }
    }
  }

  const query = new URLSearchParams({ title });
  const description = String(draft?.description ?? "").trim();
  if (description) {
    query.set("subtitle", description);
  }
  return requestJson(settings, `/media/recognize?${query.toString()}`, {
    fetchImpl
  });
}

/**
 * 将种子草稿发送到 MoviePilot，并由 MoviePilot 完成媒体识别和自动分类。
 *
 * downloader 与 savePath 为空时不会覆盖 MoviePilot 的下载器和分类目录规则。
 * Cookie 只存在于本次内存与请求体中，扩展不会保存它。
 *
 * @param {object} settings 扩展设置。
 * @param {object} draft 种子标题、描述、下载链接和来源页面。
 * @param {object} [delivery] 本次发送选项。
 * @param {string} [delivery.downloader] 显式选择的下载器名称。
 * @param {string} [delivery.savePath] 显式保存路径；为空时自动分类。
 * @param {string} [delivery.cookieHeader] 当前 PT 站 Cookie 请求头。
 * @param {typeof fetch} [fetchImpl] 测试时可注入的 fetch 实现。
 * @returns {Promise<{downloadId: string|null, response: object}>} 下载任务标识与原始响应。
 * @throws {TypeError} 标题或链接无效时抛出。
 * @throws {MoviePilotApiError} MoviePilot 拒绝或处理失败时抛出。
 * @sideEffects 向 MoviePilot 发起下载请求，成功时会在配置的下载器中创建任务。
 */
export async function addTorrent(
  settings,
  draft,
  delivery = {},
  fetchImpl = globalThis.fetch
) {
  const title = String(draft?.title ?? "").trim();
  const enclosure = String(draft?.enclosure ?? "").trim();
  if (!title) {
    throw new TypeError("请填写种子标题");
  }
  if (!isSupportedTorrentUrl(enclosure)) {
    throw new TypeError("请填写有效的种子下载链接或磁力链接");
  }

  const pageUrl = String(draft?.pageUrl ?? "").trim();
  const torrentInput = {
    title,
    description: String(draft?.description ?? "").trim() || null,
    enclosure,
    page_url: pageUrl || null,
    site_name: inferSiteName(pageUrl, enclosure),
    site_ua: String(draft?.userAgent ?? "").trim() || null,
    site_proxy: false
  };
  const cookieHeader = String(delivery?.cookieHeader ?? "").trim();
  if (cookieHeader) {
    torrentInput.site_cookie = cookieHeader;
  }

  const requestBody = {
    torrent_in: torrentInput,
    downloader: String(delivery?.downloader ?? "").trim() || null,
    save_path: String(delivery?.savePath ?? "").trim() || null
  };
  const identity = getDraftMediaIdentity(draft);
  if (identity) {
    // 显式来源 ID 会让 MoviePilot 跳过脆弱的发布名搜索，直接读取对应媒体元数据。
    requestBody.media_source = identity.source;
    requestBody.media_id = identity.id;
    if (identity.source === "douban") {
      // 同时携带旧字段，兼容尚未引入 media_source/media_id 的 MoviePilot v2 版本。
      requestBody.doubanid = identity.id;
    }
  }

  const payload = await requestJson(settings, "/download/add", {
    method: "POST",
    body: requestBody,
    timeoutMs: 90_000,
    fetchImpl
  });

  if (!payload?.success) {
    throw new MoviePilotApiError(
      getResponseMessage(payload, 200) || "MoviePilot 添加下载任务失败",
      { status: 200, code: "DOWNLOAD_REJECTED" }
    );
  }
  return {
    downloadId: payload?.data?.download_id ?? null,
    response: payload
  };
}
