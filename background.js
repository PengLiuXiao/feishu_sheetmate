const SNAPSHOT_KEY_PREFIX = "sheetMateSnapshot:";
const PANEL_STATE_KEY_PREFIX = "sheetMatePanelState:";
const CAPTURE_STATUS_KEY_PREFIX = "sheetMateCaptureStatus:";

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
    url: normalizeText(patch.url) || previous?.url || ""
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
      url: payload.url
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
      url: payload.url
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
        url: snapshot.url
      },
      () => {
        sendResponse({ ok: true });
      }
    );
  });
}

chrome.runtime.onInstalled.addListener(() => {
  configureSidePanelBehavior();
});

chrome.runtime.onStartup.addListener(() => {
  configureSidePanelBehavior();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = getMessageTabId(sender);
  if (!Number.isInteger(tabId)) {
    return undefined;
  }

  switch (message?.type) {
    case "CONTENT_SCRIPT_READY":
      handleContentScriptReady(tabId, message.payload || {}, sendResponse);
      return true;
    case "CAPTURE_STATUS":
      handleCaptureStatus(tabId, message.payload || {}, sendResponse);
      return true;
    case "CELL_SNAPSHOT":
      if (!message.payload) {
        return undefined;
      }

      handleCellSnapshot(tabId, message.payload, sendResponse);
      return true;
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
