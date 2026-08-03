import assert from "node:assert/strict";
import test from "node:test";

import {
  buildApiUrl,
  inferSiteName,
  isSupportedTorrentUrl,
  normalizeBaseUrl,
  toHostPermissionPattern
} from "../src/shared/url-utils.js";

test("normalizeBaseUrl 保留反向代理路径并移除 API 前缀", () => {
  assert.equal(
    normalizeBaseUrl("https://example.com/moviepilot/api/v1/"),
    "https://example.com/moviepilot"
  );
  assert.equal(normalizeBaseUrl("localhost:3000"), "http://localhost:3000");
});

test("normalizeBaseUrl 拒绝不安全或不受支持的地址形式", () => {
  assert.throws(() => normalizeBaseUrl(""), /请填写/);
  assert.throws(() => normalizeBaseUrl("ftp://example.com"), /HTTP/);
  assert.throws(
    () => normalizeBaseUrl("https://user:secret@example.com"),
    /用户名或密码/
  );
});

test("buildApiUrl 正确拼接反向代理 API 路径", () => {
  assert.equal(
    buildApiUrl("https://example.com/mp/", "/download/clients"),
    "https://example.com/mp/api/v1/download/clients"
  );
});

test("toHostPermissionPattern 固定实际端口并移除路径", () => {
  assert.equal(
    toHostPermissionPattern("http://localhost:3000/api/v1"),
    "http://localhost:3000/*"
  );
  assert.equal(
    toHostPermissionPattern("https://pt.example.com/download.php?id=1"),
    "https://pt.example.com:443/*"
  );
});

test("isSupportedTorrentUrl 仅接受 HTTP(S) 和 magnet", () => {
  assert.equal(isSupportedTorrentUrl("magnet:?xt=urn:btih:1234"), true);
  assert.equal(isSupportedTorrentUrl("https://pt.example/download.php?id=1"), true);
  assert.equal(isSupportedTorrentUrl("javascript:alert(1)"), false);
  assert.equal(isSupportedTorrentUrl("not a url"), false);
});

test("inferSiteName 优先使用详情页主机并兼容磁力链接", () => {
  assert.equal(
    inferSiteName(
      "https://pt.example/details.php?id=1",
      "https://dl.example/download.php?id=1"
    ),
    "pt.example"
  );
  assert.equal(inferSiteName("", "magnet:?xt=urn:btih:1234"), "手动发送");
});
