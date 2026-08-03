import assert from "node:assert/strict";
import test from "node:test";

import { extractTorrentPage } from "../src/shared/page-extractor.js";

/**
 * 在测试期间安装最小页面全局对象，并在结束后完整恢复属性描述符。
 *
 * @param {Record<string, unknown>} values 需要临时覆盖的全局值。
 * @param {() => Promise<void>|void} callback 使用临时页面环境执行的断言。
 * @returns {Promise<void>} 回调及环境恢复完成后解决。
 * @throws {unknown} 回调抛出的断言或运行异常。
 * @sideEffects 测试期间临时修改 globalThis，结束后恢复原状。
 */
async function withPageGlobals(values, callback) {
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

test("M-Team 详情页忽略右键元数据链接并提取发布名元素", async () => {
  const releaseTitle = "Murderer Report 2025 1080p ATVP WEB-DL H.264 DD5.1-HHWEB";
  const description = "杀人者报告 / 인터뷰 / Murder Report | 1080p | 类型: 犯罪";
  const headings = [
    {
      textContent: "杀人者报告2025豆 7.1IMDB",
      childNodes: [
        { nodeType: 1, nodeName: "SPAN", textContent: "杀人者报告2025" },
        { nodeType: 1, nodeName: "DIV", textContent: "豆 7.1IMDB" }
      ]
    },
    {
      textContent: `${releaseTitle}Free 2d 6h`,
      childNodes: [
        { nodeType: 1, nodeName: "SPAN", textContent: releaseTitle },
        { nodeType: 1, nodeName: "A", textContent: "" },
        { nodeType: 1, nodeName: "SPAN", textContent: "Free 2d 6h" }
      ]
    }
  ];
  const anchors = [
    {
      textContent: "豆瓣",
      getAttribute: () => "https://movie.douban.com/subject/36171173/"
    },
    {
      textContent: "電影/HD",
      getAttribute: () => "/browse?cat=401"
    }
  ];
  await withPageGlobals({
    location: {
      href: "https://kp.m-team.cc/detail/1222137",
      hostname: "kp.m-team.cc",
      pathname: "/detail/1222137"
    },
    navigator: { userAgent: "Chrome Test" },
    document: {
      // 故意提供不同的 document.title，确保可见资源标题元素始终拥有最高优先级。
      title: "M-Team - TP :: 種子詳情 \"Stale Document Release 2024 720p\" - Powered by mTorrent",
      querySelectorAll: (selector) => {
        if (selector === "h2") {
          return headings;
        }
        if (selector === "p") {
          return [{ textContent: description }];
        }
        if (selector === "a[href]") {
          return anchors;
        }
        return [];
      }
    }
  }, () => {
    const drafts = [
      extractTorrentPage(),
      extractTorrentPage("https://kp.m-team.cc/mdb/name?type=douban&id=27496721")
    ];

    for (const draft of drafts) {
      assert.equal(draft.title, releaseTitle);
      assert.equal(draft.description, description);
      assert.equal(draft.enclosure, "");
      assert.equal(draft.downloadAdapter, "mteam-dynamic-download");
      assert.equal(draft.torrentId, "1222137");
      assert.equal("recognitionTitle" in draft, false);
      assert.equal(draft.mediaSource, "douban");
      assert.equal(draft.mediaId, "36171173");
      assert.equal(draft.mediaType, "电影");
      assert.equal(draft.pageUrl, "https://kp.m-team.cc/detail/1222137");
      assert.equal(draft.userAgent, "Chrome Test");
      assert.match(draft.extractedAt, /^\d{4}-\d{2}-\d{2}T/);
    }
  });
});
