import assert from "node:assert/strict";
import test from "node:test";

import {
  isMTeamDynamicDraft,
  resolveMTeamDownloadUrlFromPage
} from "../src/shared/mteam-adapter.js";

// Chrome 会序列化 MAIN world 函数；测试同样切断模块闭包，防止未来误引用导入变量。
const serializedMTeamResolver = Function(
  `"use strict"; return (${resolveMTeamDownloadUrlFromPage.toString()});`
)();

/**
 * 临时覆盖解析器依赖的浏览器全局对象，并确保测试之间不共享登录态替身。
 *
 * @param {Record<string, unknown>} values 需要临时覆盖的全局值。
 * @param {() => Promise<void>|void} callback 使用替身环境执行的断言。
 * @returns {Promise<void>} 回调与清理完成后解决。
 * @throws {unknown} 回调抛出的断言或运行异常。
 * @sideEffects 测试期间临时修改 globalThis，结束后恢复原状。
 */
async function withBrowserGlobals(values, callback) {
  const originalDescriptors = new Map();
  for (const [key, value] of Object.entries(values)) {
    originalDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }

  try {
    await callback();
  } finally {
    for (const [key, descriptor] of originalDescriptors) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete globalThis[key];
      }
    }
  }
}

/**
 * 构造只在内存中读取固定键值的 localStorage 替身。
 *
 * @param {Record<string, string>} values 测试登录态与站点配置。
 * @returns {{getItem: (key: string) => string|null}} 最小 localStorage 接口。
 * @sideEffects 无副作用，不访问真实浏览器存储。
 */
function storageStub(values) {
  return {
    getItem: (key) => Object.hasOwn(values, key) ? values[key] : null
  };
}

test("只把匹配来源页和数字 ID 的草稿识别为 M-Team 动态下载", () => {
  assert.equal(isMTeamDynamicDraft({
    downloadAdapter: "mteam-dynamic-download",
    torrentId: "1222137",
    pageUrl: "https://kp.m-team.cc/detail/1222137"
  }), true);
  assert.equal(isMTeamDynamicDraft({
    downloadAdapter: "mteam-dynamic-download",
    torrentId: "1222137",
    pageUrl: "https://example.com/detail/1222137"
  }), false);
  assert.equal(isMTeamDynamicDraft({
    downloadAdapter: "mteam-dynamic-download",
    torrentId: "../1222137",
    pageUrl: "https://kp.m-team.cc/detail/1222137"
  }), false);
});

test("生成临时地址时限制 API 主机并且不返回页面授权值", async () => {
  let capturedRequest = null;
  const authorization = "Bearer test-page-authorization";
  await withBrowserGlobals({
    location: {
      hostname: "kp.m-team.cc",
      pathname: "/detail/1222137",
      origin: "https://kp.m-team.cc"
    },
    localStorage: storageStub({
      apiHost: "https://untrusted.example/api",
      auth: authorization,
      did: "test-device-id",
      visitorId: "test-visitor-id"
    }),
    fetch: async (url, options) => {
      capturedRequest = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          data: "/download?token=temporary-test-token"
        })
      };
    }
  }, async () => {
    const downloadUrl = await serializedMTeamResolver("1222137");
    assert.equal(
      downloadUrl,
      "https://kp.m-team.cc/download?token=temporary-test-token&useHttps=true&type="
    );
    assert.ok(!downloadUrl.includes(authorization));
    assert.equal(
      capturedRequest.url,
      "https://api.m-team.cc/api/torrent/genDlToken"
    );
    assert.equal(capturedRequest.options.method, "POST");
    assert.equal(capturedRequest.options.credentials, "include");
    assert.equal(capturedRequest.options.headers.authorization, authorization);
    assert.equal(capturedRequest.options.headers.did, "test-device-id");
    assert.equal(capturedRequest.options.body.get("id"), "1222137");
    assert.match(capturedRequest.options.body.get("_timestamp"), /^\d{13}$/);
    assert.ok(capturedRequest.options.body.get("_sgin").length > 10);
  });
});

test("缺少登录态或返回外部主机时拒绝生成下载地址", async () => {
  await withBrowserGlobals({
    location: {
      hostname: "kp.m-team.cc",
      pathname: "/detail/1222137",
      origin: "https://kp.m-team.cc"
    },
    localStorage: storageStub({}),
    fetch: async () => {
      throw new Error("不应发起请求");
    }
  }, async () => {
    await assert.rejects(
      serializedMTeamResolver("1222137"),
      /登录状态不可用/
    );
  });

  await withBrowserGlobals({
    location: {
      hostname: "kp.m-team.cc",
      pathname: "/detail/1222137",
      origin: "https://kp.m-team.cc"
    },
    localStorage: storageStub({ auth: "Bearer test" }),
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        code: 0,
        data: "https://untrusted.example/download?token=test"
      })
    })
  }, async () => {
    await assert.rejects(
      serializedMTeamResolver("1222137"),
      /不受信任的下载地址/
    );
  });
});
