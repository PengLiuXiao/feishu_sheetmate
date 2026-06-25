const SNAPSHOT_KEY_PREFIX = "sheetMateSnapshot:";
const PANEL_STATE_KEY_PREFIX = "sheetMatePanelState:";
const CAPTURE_STATUS_KEY_PREFIX = "sheetMateCaptureStatus:";
const SHEET_MATE_TEST_MODE = globalThis.__SHEET_MATE_TEST__ === true;
const CONTENT_SCRIPT_FILE = "src/content-script.js";

let backgroundInitialized = false;

function configureSidePanelBehavior() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {
      // Chrome 在某些版本上会在冷启动时短暂抛错，这里静默忽略。
    });
}

function getSnapshotKey(tabId) {
  return `${SNAPSHOT_KEY_PREFIX}${tabId}`;
}

function getPanelStateKey(tabId) {
  return `${PANEL_STATE_KEY_PREFIX}${tabId}`;
}

function getCaptureStatusKey(tabId) {
  return `${CAPTURE_STATUS_KEY_PREFIX}${tabId}`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isFeishuWorkspaceUrl(url) {
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return (
      /(?:^|\.)feishu\.cn$/i.test(parsed.hostname) ||
      /(?:^|\.)larksuite\.com$/i.test(parsed.hostname) ||
      /(?:^|\.)larkoffice\.com$/i.test(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function isInjectableFeishuTab(tab) {
  return Boolean(
    tab &&
      Number.isInteger(tab.id) &&
      typeof tab.url === "string" &&
      /^https?:/i.test(tab.url) &&
      isFeishuWorkspaceUrl(tab.url)
  );
}

function injectContentScript(tabId) {
  if (!Number.isInteger(tabId)) {
    return Promise.resolve({ ok: false, reason: "invalid-tab-id" });
  }

  return Promise.resolve(
    chrome.scripting.executeScript({
      target: { tabId },
      files: [CONTENT_SCRIPT_FILE]
    })
  )
    .then(() => ({ ok: true }))
    .catch((error) => ({
      ok: false,
      reason: normalizeText(error?.message || error) || "inject-failed"
    }));
}

function injectOpenFeishuTabs() {
  try {
    chrome.tabs.query({}, (tabs) => {
      void chrome.runtime.lastError;

      for (const tab of tabs || []) {
        if (!isInjectableFeishuTab(tab)) {
          continue;
        }

        void injectContentScript(tab.id);
      }
    });
  } catch {
    // 某些测试或受限环境里 tabs.query 可能不存在，这里静默跳过。
  }
}

function mergeCaptureStatus(previous, patch) {
  return {
    ready: patch.ready ?? previous?.ready ?? false,
    connectedAt: patch.connectedAt ?? previous?.connectedAt ?? null,
    lastReadyAt: patch.lastReadyAt ?? previous?.lastReadyAt ?? null,
    lastStatusAt: patch.lastStatusAt ?? previous?.lastStatusAt ?? null,
    lastSnapshotAt: patch.lastSnapshotAt ?? previous?.lastSnapshotAt ?? null,
    lastExtractorStage: normalizeText(patch.lastExtractorStage) || previous?.lastExtractorStage || "",
    lastExtractorMessage: normalizeText(patch.lastExtractorMessage) || previous?.lastExtractorMessage || "",
    lastError: patch.lastError === undefined ? previous?.lastError || "" : normalizeText(patch.lastError),
    pageKind: normalizeText(patch.pageKind) || previous?.pageKind || "",
    pageSupported: patch.pageSupported ?? previous?.pageSupported ?? null,
    lastSupportReason: normalizeText(patch.supportReason) || normalizeText(patch.lastSupportReason) || previous?.lastSupportReason || "",
    pageTitle: normalizeText(patch.pageTitle) || previous?.pageTitle || "",
    url: normalizeText(patch.url) || previous?.url || "",
    pageSessionKey: normalizeText(patch.pageSessionKey) || previous?.pageSessionKey || ""
  };
}

function updateCaptureStatus(tabId, patch, callback) {
  const key = getCaptureStatusKey(tabId);

  chrome.storage.session.get([key], (data) => {
    const next = mergeCaptureStatus(data[key], patch);

    chrome.storage.session.set({ [key]: next }, () => {
      void chrome.runtime.lastError;
      callback?.(next);
    });
  });
}

function buildSnapshotPayload(tabId, payload) {
  return {
    cellRef: normalizeText(payload.cellRef) || null,
    rawContent: typeof payload.rawContent === "string" ? payload.rawContent : String(payload.rawContent || ""),
    source: normalizeText(payload.source) || "unknown",
    pageTitle: normalizeText(payload.pageTitle),
    url: normalizeText(payload.url),
    pageSessionKey: normalizeText(payload.pageSessionKey),
    pageKind: normalizeText(payload.pageKind),
    pageSupported: payload.pageSupported ?? null,
    supportReason: normalizeText(payload.supportReason),
    extractorStage: normalizeText(payload.extractorStage),
    extractorMessage: normalizeText(payload.extractorMessage),
    capturedAt: Date.now(),
    tabId
  };
}

function getMessageTabId(sender) {
  return sender.tab?.id;
}

function handleContentScriptReady(tabId, payload, sendResponse) {
  const now = Date.now();
  const readyMessage = normalizeText(payload.supportReason) || "内容脚本已连接到当前飞书页面。";

  updateCaptureStatus(
    tabId,
    {
      ready: true,
      connectedAt: now,
      lastReadyAt: now,
      lastStatusAt: now,
      lastExtractorStage: "script-ready",
      lastExtractorMessage: readyMessage,
      lastError: "",
      pageKind: payload.pageKind,
      pageSupported: payload.pageSupported,
      supportReason: payload.supportReason,
      pageTitle: payload.pageTitle,
      url: payload.url,
      pageSessionKey: payload.pageSessionKey
    },
    () => {
      sendResponse({ ok: true });
    }
  );
}

function handleCaptureStatus(tabId, payload, sendResponse) {
  updateCaptureStatus(
    tabId,
    {
      ready: true,
      lastStatusAt: Date.now(),
      lastExtractorStage: payload.stage,
      lastExtractorMessage: payload.message,
      lastError: payload.error || "",
      pageKind: payload.pageKind,
      pageSupported: payload.pageSupported,
      supportReason: payload.supportReason,
      pageTitle: payload.pageTitle,
      url: payload.url,
      pageSessionKey: payload.pageSessionKey
    },
    () => {
      sendResponse({ ok: true });
    }
  );
}

function handleCellSnapshot(tabId, payload, sendResponse) {
  const snapshot = buildSnapshotPayload(tabId, payload);

  chrome.storage.session.set({ [getSnapshotKey(tabId)]: snapshot }, () => {
    void chrome.runtime.lastError;

    updateCaptureStatus(
      tabId,
      {
        ready: true,
        lastStatusAt: snapshot.capturedAt,
        lastSnapshotAt: snapshot.capturedAt,
        lastExtractorStage: snapshot.extractorStage || `hit:${snapshot.source}`,
        lastExtractorMessage: snapshot.extractorMessage || "已抓到当前单元格内容。",
        lastError: "",
        pageKind: snapshot.pageKind,
        pageSupported: snapshot.pageSupported,
        supportReason: snapshot.supportReason,
        pageTitle: snapshot.pageTitle,
        url: snapshot.url,
        pageSessionKey: snapshot.pageSessionKey
      },
      () => {
        sendResponse({ ok: true });
      }
    );
  });
}

function handleEnsureContentScript(message, sendResponse) {
  const tabId = Number.isInteger(message?.payload?.tabId) ? message.payload.tabId : null;
  if (!Number.isInteger(tabId)) {
    sendResponse({ ok: false, reason: "invalid-tab-id" });
    return;
  }

  injectContentScript(tabId).then(sendResponse);
}

function initializeBackgroundRuntime() {
  if (backgroundInitialized) {
    return;
  }

  backgroundInitialized = true;

  chrome.runtime.onInstalled.addListener(() => {
    configureSidePanelBehavior();
    injectOpenFeishuTabs();
  });

  chrome.runtime.onStartup.addListener(() => {
    configureSidePanelBehavior();
    injectOpenFeishuTabs();
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message?.type) {
      case "ENSURE_CONTENT_SCRIPT":
        handleEnsureContentScript(message, sendResponse);
        return true;
      case "CONTENT_SCRIPT_READY":
      case "CAPTURE_STATUS":
      case "CELL_SNAPSHOT": {
        const tabId = getMessageTabId(sender);
        if (!Number.isInteger(tabId)) {
          return undefined;
        }

        if (message?.type === "CONTENT_SCRIPT_READY") {
          handleContentScriptReady(tabId, message.payload || {}, sendResponse);
          return true;
        }

        if (message?.type === "CAPTURE_STATUS") {
          handleCaptureStatus(tabId, message.payload || {}, sendResponse);
          return true;
        }

        if (!message.payload) {
          return undefined;
        }

        handleCellSnapshot(tabId, message.payload, sendResponse);
        return true;
      }
      default:
        return undefined;
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    chrome.storage.session.remove(
      [getSnapshotKey(tabId), getPanelStateKey(tabId), getCaptureStatusKey(tabId)],
      () => {
        void chrome.runtime.lastError;
      }
    );
  });
}

function exposeBackgroundTestExports() {
  if (!SHEET_MATE_TEST_MODE) {
    return;
  }

  const root = globalThis.__sheetMateTestExports || (globalThis.__sheetMateTestExports = {});
  root.background = {
    buildSnapshotPayload,
    getCaptureStatusKey,
    getMessageTabId,
    getPanelStateKey,
    getSnapshotKey,
    handleCaptureStatus,
    handleCellSnapshot,
    handleContentScriptReady,
    handleEnsureContentScript,
    injectContentScript,
    injectOpenFeishuTabs,
    initializeBackgroundRuntime,
    isFeishuWorkspaceUrl,
    isInjectableFeishuTab,
    mergeCaptureStatus,
    normalizeText,
    updateCaptureStatus
  };
}

exposeBackgroundTestExports();

if (!SHEET_MATE_TEST_MODE) {
  initializeBackgroundRuntime();
}
