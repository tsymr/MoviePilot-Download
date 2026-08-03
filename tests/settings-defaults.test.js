import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_SETTINGS } from "../src/shared/constants.js";
import { getSettings } from "../src/shared/storage.js";

test("右键发送默认跳过识别确认", () => {
  assert.equal(DEFAULT_SETTINGS.recognizeBeforeDownload, false);
});

test("Cookie 默认策略保持为显式设置值", () => {
  assert.equal(DEFAULT_SETTINGS.includeCookiesByDefault, true);
});

test("旧版设置缺少识别策略时自动补为直发模式", async () => {
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({
          moviepilotSettings: {
            baseUrl: "https://moviepilot.example",
            apiToken: "token-token-token-token"
          }
        })
      }
    }
  };

  try {
    const settings = await getSettings();
    assert.equal(settings.recognizeBeforeDownload, false);
  } finally {
    delete globalThis.chrome;
  }
});
