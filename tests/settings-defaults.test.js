import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_SETTINGS } from "../src/shared/constants.js";
import { getSettings, saveSettings } from "../src/shared/storage.js";

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

test("字符串 false 不会被误判为开启识别或 Cookie", async () => {
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({
          moviepilotSettings: {
            recognizeBeforeDownload: "false",
            includeCookiesByDefault: "false"
          }
        })
      }
    }
  };

  try {
    const settings = await getSettings();
    assert.equal(settings.recognizeBeforeDownload, false);
    assert.equal(settings.includeCookiesByDefault, false);
  } finally {
    delete globalThis.chrome;
  }
});

test("保存设置时只接受布尔值 true 开启行为策略", async () => {
  let storedSettings = null;
  globalThis.chrome = {
    storage: {
      local: {
        set: async (value) => {
          storedSettings = value.moviepilotSettings;
        }
      }
    }
  };

  try {
    await saveSettings({
      baseUrl: "https://moviepilot.example",
      apiToken: "token-token-token-token",
      recognizeBeforeDownload: "false",
      includeCookiesByDefault: "false"
    });
    assert.equal(storedSettings.recognizeBeforeDownload, false);
    assert.equal(storedSettings.includeCookiesByDefault, false);
  } finally {
    delete globalThis.chrome;
  }
});
