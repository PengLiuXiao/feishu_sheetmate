import { readFileSync } from "node:fs";

import { JSDOM } from "jsdom";

const GLOBAL_KEYS = [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "MutationObserver",
  "URL",
  "getComputedStyle"
];

function resolveUrl(relativePath) {
  return new URL(relativePath, import.meta.url);
}

export function readRepoFile(relativePath) {
  return readFileSync(resolveUrl(`../../${relativePath}`), "utf8");
}

export function createDom(html, { url = "https://example.com/" } = {}) {
  return new JSDOM(html, {
    url,
    pretendToBeVisual: true,
    runScripts: "outside-only"
  });
}

function installDomGlobals(window) {
  for (const key of GLOBAL_KEYS) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: window[key]
    });
  }

  Object.defineProperty(globalThis, "self", {
    configurable: true,
    writable: true,
    value: window
  });
}

export async function loadBrowserScript(relativePath, options = {}) {
  const {
    html = "<!doctype html><html><body></body></html>",
    url,
    setupWindow
  } = options;
  const dom = createDom(html, { url });
  const { window } = dom;

  window.__SHEET_MATE_TEST__ = true;
  window.__sheetMateTestExports = {};
  window.console = console;

  setupWindow?.(window, dom);
  installDomGlobals(window);

  globalThis.__SHEET_MATE_TEST__ = true;
  globalThis.__sheetMateTestExports = {};
  globalThis.chrome = window.chrome;

  vi.resetModules();
  await import(new URL(`../../${relativePath}?t=${Date.now()}-${Math.random()}`, import.meta.url));

  return {
    dom,
    window,
    exports: globalThis.__sheetMateTestExports
  };
}

export function setVisibleRect(element, rect = {}) {
  const {
    top = 10,
    left = 10,
    width = 120,
    height = 32
  } = rect;

  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: left,
      y: top,
      top,
      left,
      width,
      height,
      right: left + width,
      bottom: top + height
    })
  });

  return element;
}

export function createChromeMock({ sessionData = {}, tabsData = [] } = {}) {
  const storage = { ...sessionData };
  const listeners = {
    installed: [],
    startup: [],
    message: [],
    removed: []
  };

  const chrome = {
    runtime: {
      id: "test-extension",
      lastError: null,
      onInstalled: {
        addListener(listener) {
          listeners.installed.push(listener);
        }
      },
      onStartup: {
        addListener(listener) {
          listeners.startup.push(listener);
        }
      },
      onMessage: {
        addListener(listener) {
          listeners.message.push(listener);
        }
      },
      sendMessage: vi.fn((message, callback) => {
        callback?.();
        return message;
      })
    },
    sidePanel: {
      setPanelBehavior: vi.fn(() => Promise.resolve())
    },
    scripting: {
      executeScript: vi.fn(() => Promise.resolve())
    },
    tabs: {
      query: vi.fn((queryInfo, callback) => {
        callback?.(tabsData);
      }),
      onRemoved: {
        addListener(listener) {
          listeners.removed.push(listener);
        }
      }
    },
    storage: {
      session: {
        get: vi.fn((keys, callback) => {
          const normalizedKeys = Array.isArray(keys) ? keys : [keys];
          const result = {};

          for (const key of normalizedKeys) {
            result[key] = storage[key];
          }

          callback(result);
        }),
        set: vi.fn((patch, callback) => {
          Object.assign(storage, patch);
          callback?.();
        }),
        remove: vi.fn((keys, callback) => {
          for (const key of keys) {
            delete storage[key];
          }
          callback?.();
        })
      }
    }
  };

  return {
    chrome,
    listeners,
    storage
  };
}
