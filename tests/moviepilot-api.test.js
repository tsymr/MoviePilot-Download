import assert from "node:assert/strict";
import test from "node:test";

import {
  addTorrent,
  MoviePilotApiError,
  recognizeTorrent,
  testConnection
} from "../src/shared/moviepilot-api.js";

const settings = {
  baseUrl: "https://moviepilot.example/mp",
  apiToken: "0123456789abcdef"
};

/**
 * 构造 requestJson 可消费的最小 fetch Response 替身。
 *
 * @param {unknown} payload JSON 响应载荷。
 * @param {number} [status] HTTP 状态码。
 * @returns {{ok: boolean, status: number, text: () => Promise<string>}} 响应替身。
 * @sideEffects 无副作用。
 */
function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload)
  };
}

test("testConnection 使用 X-API-KEY 并读取下载路由", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return url.endsWith("/download/clients")
      ? jsonResponse([{ name: "qb", type: "qbittorrent" }])
      : jsonResponse([{ name: "电影", save_path: "local:/media/movies" }]);
  };

  const result = await testConnection(settings, fetchImpl);
  assert.equal(result.downloaders[0].name, "qb");
  assert.equal(result.paths[0].save_path, "local:/media/movies");
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => (
    request.options.headers["X-API-KEY"] === settings.apiToken
  )));
  assert.ok(requests.every((request) => !request.url.includes(settings.apiToken)));
});

test("recognizeTorrent 编码标题与副标题查询参数", async () => {
  let requestedUrl = "";
  const fetchImpl = async (url) => {
    requestedUrl = url;
    return jsonResponse({ media_info: { title: "测试电影" } });
  };

  await recognizeTorrent(
    settings,
    { title: "Movie & Name", description: "副标题 / 版本" },
    fetchImpl
  );
  const parsed = new URL(requestedUrl);
  assert.equal(parsed.pathname, "/mp/api/v1/media/recognize");
  assert.equal(parsed.searchParams.get("title"), "Movie & Name");
  assert.equal(parsed.searchParams.get("subtitle"), "副标题 / 版本");
});

test("recognizeTorrent 对 M-Team 草稿按豆瓣 ID 查询并使用可见发布标题", async () => {
  let requestedUrl = "";
  const fetchImpl = async (url) => {
    requestedUrl = url;
    return jsonResponse({
      title: "杀人者报告",
      year: "2025",
      type: "电影"
    });
  };

  const result = await recognizeTorrent(
    settings,
    {
      title: "Murderer Report 2025 1080p ATVP WEB-DL H.264 DD5.1-HHWEB",
      // 兼容扩展更新前留在弹窗内存中的旧草稿：隐藏标题必须被忽略。
      recognitionTitle: "错误的隐藏标题",
      mediaSource: "douban",
      mediaId: "36171173",
      mediaType: "电影"
    },
    fetchImpl
  );

  const parsed = new URL(requestedUrl);
  assert.equal(parsed.pathname, "/mp/api/v1/media/douban%3A36171173");
  assert.equal(parsed.searchParams.get("type_name"), "电影");
  assert.equal(
    parsed.searchParams.get("title"),
    "Murderer Report 2025 1080p ATVP WEB-DL H.264 DD5.1-HHWEB"
  );
  assert.equal(parsed.searchParams.get("year"), "2025");
  assert.equal(result.media_info.title, "杀人者报告");
});

test("recognizeTorrent 在 ID 查询无结果时仍使用可见发布标题兜底", async () => {
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(url);
    return requestedUrls.length === 1
      ? jsonResponse({})
      : jsonResponse({ media_info: { title: "杀人者报告" } });
  };

  await recognizeTorrent(
    settings,
    {
      title: "Murderer Report 2025 1080p WEB-DL",
      recognitionTitle: "错误的隐藏标题",
      description: "杀人者报告 / Murder Report | 类型: 犯罪",
      mediaSource: "douban",
      mediaId: "36171173",
      mediaType: "电影"
    },
    fetchImpl
  );

  assert.equal(requestedUrls.length, 2);
  const fallback = new URL(requestedUrls[1]);
  assert.equal(fallback.pathname, "/mp/api/v1/media/recognize");
  assert.equal(fallback.searchParams.get("title"), "Murderer Report 2025 1080p WEB-DL");
});

test("addTorrent 保留自动分类空值并只在本次请求携带 Cookie", async () => {
  let captured = null;
  const fetchImpl = async (url, options) => {
    captured = { url, options };
    return jsonResponse({
      success: true,
      data: { download_id: "abcdef1234567890" }
    });
  };

  const result = await addTorrent(
    settings,
    {
      title: "Movie.Name.2026.1080p.WEB-DL",
      description: "测试副标题",
      enclosure: "https://pt.example/download.php?id=123",
      pageUrl: "https://pt.example/details.php?id=123",
      userAgent: "Chrome Test"
    },
    {
      downloader: "",
      savePath: "",
      cookieHeader: "session=private-value"
    },
    fetchImpl
  );

  const body = JSON.parse(captured.options.body);
  assert.equal(captured.url, "https://moviepilot.example/mp/api/v1/download/add");
  assert.equal(body.downloader, null);
  assert.equal(body.save_path, null);
  assert.equal(body.torrent_in.site_name, "pt.example");
  assert.equal(body.torrent_in.site_cookie, "session=private-value");
  assert.equal(result.downloadId, "abcdef1234567890");
});

test("addTorrent 为 M-Team 草稿携带豆瓣媒体标识并保留原始发布名", async () => {
  let capturedBody = null;
  const fetchImpl = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return jsonResponse({
      success: true,
      data: { download_id: "mteam-download-id" }
    });
  };

  await addTorrent(
    settings,
    {
      title: "Murderer Report 2025 1080p ATVP WEB-DL H.264 DD5.1-HHWEB",
      description: "杀人者报告 / Murder Report | 类型: 犯罪",
      enclosure: "https://kp.m-team.cc/download.php?id=temporary",
      pageUrl: "https://kp.m-team.cc/detail/1222137",
      mediaSource: "douban",
      mediaId: "36171173",
      mediaType: "电影"
    },
    {},
    fetchImpl
  );

  assert.equal(capturedBody.media_source, "douban");
  assert.equal(capturedBody.media_id, "36171173");
  assert.equal(capturedBody.doubanid, "36171173");
  assert.equal(
    capturedBody.torrent_in.title,
    "Murderer Report 2025 1080p ATVP WEB-DL H.264 DD5.1-HHWEB"
  );
});

test("addTorrent 将 MoviePilot 业务失败转换为结构化错误", async () => {
  const fetchImpl = async () => jsonResponse({
    success: false,
    message: "无法识别媒体信息"
  });

  await assert.rejects(
    addTorrent(
      settings,
      {
        title: "Unknown.Release",
        enclosure: "https://pt.example/download.php?id=1"
      },
      {},
      fetchImpl
    ),
    (error) => {
      assert.ok(error instanceof MoviePilotApiError);
      assert.equal(error.code, "DOWNLOAD_REJECTED");
      assert.match(error.message, /无法识别媒体信息/);
      assert.ok(!error.message.includes(settings.apiToken));
      return true;
    }
  );
});

test("HTTP 鉴权错误不会在异常中泄露本地 API Token", async () => {
  const fetchImpl = async () => jsonResponse({ detail: "apikey 校验不通过" }, 401);

  await assert.rejects(
    testConnection(settings, fetchImpl),
    (error) => {
      assert.ok(error instanceof MoviePilotApiError);
      assert.equal(error.status, 401);
      assert.ok(!error.message.includes(settings.apiToken));
      return true;
    }
  );
});
