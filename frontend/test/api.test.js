import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getCurrentUser,
  hasStoredAuthToken,
  login,
  storeAuthToken,
} from '../src/api.js';

class MemoryStorage {
  constructor() {
    this.items = new Map();
  }

  getItem(key) {
    return this.items.get(key) || null;
  }

  setItem(key, value) {
    this.items.set(key, String(value));
  }

  removeItem(key) {
    this.items.delete(key);
  }
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? 'Unauthorized' : 'Error',
    headers: {
      get: () => 'application/json',
    },
    json: async () => payload,
  };
}

describe('api auth handling', () => {
  beforeEach(() => {
    global.window = new EventTarget();
    global.window.localStorage = new MemoryStorage();
    global.fetch = vi.fn();
  });

  it('clears the stored session and emits an event when an authenticated request returns 401', async () => {
    storeAuthToken('expired-token');
    let expiredMessage = '';
    window.addEventListener('virtualwebcam:unauthorized', (event) => {
      expiredMessage = event.detail.message;
    });
    fetch.mockResolvedValue(jsonResponse(401, { error: 'Unauthorized' }));

    await expect(getCurrentUser()).rejects.toMatchObject({
      message: '登录已过期，请重新登录',
      status: 401,
    });
    expect(hasStoredAuthToken()).toBe(false);
    expect(expiredMessage).toBe('登录已过期，请重新登录');
  });

  it('keeps login failures as form errors instead of session-expiry events', async () => {
    let emitted = false;
    window.addEventListener('virtualwebcam:unauthorized', () => {
      emitted = true;
    });
    fetch.mockResolvedValue(jsonResponse(401, { error: '用户名或密码错误' }));

    await expect(login({ username: 'admin', password: 'bad' })).rejects.toMatchObject({
      message: '用户名或密码错误',
      status: 401,
    });
    expect(emitted).toBe(false);
  });
});
