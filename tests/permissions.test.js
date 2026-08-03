import assert from "node:assert/strict";
import test from "node:test";

import { requestSendPermissions } from "../src/shared/permissions.js";

test("Cookie 开启时只申请 MoviePilot 主机和 cookies 权限", async () => {
  const requests = [];
  const removals = [];
  globalThis.chrome = {
    permissions: {
      request: async (request) => {
        requests.push(request);
        return true;
      },
      remove: async (request) => {
        removals.push(request);
        return true;
      }
    }
  };

  try {
    const granted = await requestSendPermissions(
      "https://moviepilot.example/app",
      true
    );
    assert.equal(granted, true);
    assert.deepEqual(requests, [{
      origins: ["https://moviepilot.example:443/*"],
      permissions: ["cookies"]
    }]);
    assert.deepEqual(removals, []);
  } finally {
    delete globalThis.chrome;
  }
});

test("Cookie 关闭时不申请并撤销旧 cookies 权限", async () => {
  const requests = [];
  const removals = [];
  globalThis.chrome = {
    permissions: {
      request: async (request) => {
        requests.push(request);
        return true;
      },
      remove: async (request) => {
        removals.push(request);
        return true;
      }
    }
  };

  try {
    const granted = await requestSendPermissions(
      "http://localhost:3000",
      false
    );
    assert.equal(granted, true);
    assert.deepEqual(requests, [{ origins: ["http://localhost:3000/*"] }]);
    assert.deepEqual(removals, [{ permissions: ["cookies"] }]);
  } finally {
    delete globalThis.chrome;
  }
});
