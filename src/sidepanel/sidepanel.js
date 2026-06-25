const PANEL_STATE_KEY_PREFIX = "sheetMatePanelState:";
const SNAPSHOT_KEY_PREFIX = "sheetMateSnapshot:";
const CAPTURE_STATUS_KEY_PREFIX = "sheetMateCaptureStatus:";
const SUPPORTED_LAYOUTS = ["single", "columns", "rows"];
const SUPPORTED_MODES = ["auto", "text", "markdown", "json", "latex", "media"];
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "heic", "heif"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "ogg", "mov", "m4v", "m3u8", "avi"]);
const FEISHU_MEDIA_HOST_PATTERN = /(?:^|\.)((feishu\.cn)|(larksuite\.com)|(larkoffice\.com))$/i;
const FEISHU_IMAGE_HINT_PATTERN = /\b(image|img|photo|picture|thumbnail|thumb|cover|avatar|snapshot)\b/i;
const FEISHU_VIDEO_HINT_PATTERN = /\b(video|stream|vod|media|playback)\b/i;
const STALE_SCRIPT_HINT_DELAY_MS = 12000;
const CONTENT_SCRIPT_REQUEST_COOLDOWN_MS = 1500;
const SHEET_MATE_TEST_MODE = globalThis.__SHEET_MATE_TEST__ === true;

const DEFAULT_STATE = {
  layout: "single",
  activePaneId: "paneA",
  panes: {
    paneA: {
      mode: "auto",
      snapshot: null
    },
    paneB: {
      mode: "auto",
      snapshot: null
    }
  }
};

let state = cloneDefaultState();
let currentTab = null;
let captureStatus = null;
let hydrateVersion = 0;
let lastSupportState = "";
let supportStateSince = Date.now();
const contentScriptInjectionRequestAtByTab = new Map();

const board = document.getElementById("board");
const layoutButtons = Array.from(document.querySelectorAll("[data-layout]"));
const paneElements = new Map(
  Array.from(document.querySelectorAll(".pane")).map((element) => [
    element.dataset.paneId,
    {
      root: element,
      header: element.querySelector(".pane__header"),
      badge: element.querySelector(".pane__badge"),
      meta: element.querySelector(".pane__meta"),
      content: element.querySelector(".pane__content"),
      modeSelect: element.querySelector(".mode-select")
    }
  ])
);

if (!SHEET_MATE_TEST_MODE) {
  initialize();
}

function initialize() {
  bindEvents();
  hydrateStateForActiveTab();
}

function bindEvents() {
  for (const button of layoutButtons) {
    button.addEventListener("click", () => {
      applyLayout(button.dataset.layout);
    });
  }

  for (const [paneId, pane] of paneElements.entries()) {
    pane.header.addEventListener("click", () => {
      setActivePane(paneId);
    });

    pane.root.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const interactiveTarget = target?.closest("a, select, option, video, iframe");
      if (interactiveTarget) {
        return;
      }

      setActivePane(paneId);
    });

    pane.modeSelect.addEventListener("change", (event) => {
      updatePaneMode(paneId, event.target.value);
    });
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "session" || !currentTab?.id) {
      return;
    }

    const snapshotKey = getSnapshotKey(currentTab.id);
    const captureStatusKey = getCaptureStatusKey(currentTab.id);
    if (changes[snapshotKey]) {
      applyIncomingSnapshot(changes[snapshotKey].newValue);
    }

    if (changes[captureStatusKey]) {
      applyCaptureStatus(changes[captureStatusKey].newValue);
    }
  });

  chrome.tabs.onActivated.addListener(() => {
    hydrateStateForActiveTab();
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (currentTab?.id !== tabId) {
      return;
    }

    if (changeInfo.status === "complete" || changeInfo.url || changeInfo.title) {
      hydrateStateForActiveTab();
    }
  });

  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId !== chrome.windows.WINDOW_ID_NONE) {
      hydrateStateForActiveTab();
    }
  });
}

function hydrateStateForActiveTab() {
  const requestVersion = ++hydrateVersion;

  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    void chrome.runtime.lastError;

    if (requestVersion !== hydrateVersion) {
      return;
    }

    const nextTab = normalizeTab(tabs?.[0]);
    currentTab = nextTab;

    if (!currentTab?.id) {
      state = cloneDefaultState();
      captureStatus = null;
      render();
      return;
    }

    chrome.storage.session.get(
      [getPanelStateKey(currentTab.id), getSnapshotKey(currentTab.id), getCaptureStatusKey(currentTab.id)],
      (data) => {
      void chrome.runtime.lastError;

      if (requestVersion !== hydrateVersion || currentTab?.id !== nextTab.id) {
        return;
      }

      state = mergeState(data[getPanelStateKey(currentTab.id)]);
      captureStatus = normalizeCaptureStatus(data[getCaptureStatusKey(currentTab.id)]);

      const latestSnapshot = normalizeSnapshot(data[getSnapshotKey(currentTab.id)]);
      if (latestSnapshot) {
        state.panes[state.activePaneId].snapshot = latestSnapshot;
      }

      render();
      requestContentScriptInjection(currentTab?.id, getPageSupportState());
      }
    );
  });
}

function normalizeTab(tab) {
  if (!tab || !Number.isInteger(tab.id)) {
    return null;
  }

  return {
    id: tab.id,
    url: typeof tab.url === "string" ? tab.url : "",
    title: sanitizeInlineText(tab.title || "")
  };
}

function getPanelStateKey(tabId) {
  return `${PANEL_STATE_KEY_PREFIX}${tabId}`;
}

function getSnapshotKey(tabId) {
  return `${SNAPSHOT_KEY_PREFIX}${tabId}`;
}

function getCaptureStatusKey(tabId) {
  return `${CAPTURE_STATUS_KEY_PREFIX}${tabId}`;
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

function getPageSupportState() {
  if (!currentTab?.id) {
    return "no-tab";
  }

  if (!isFeishuWorkspaceUrl(currentTab.url)) {
    return "outside-feishu";
  }

  if (!captureStatus?.ready) {
    return "script-not-ready";
  }

  if (captureStatus.pageSupported === true) {
    return captureStatus.pageKind === "sheet-shell" ? "supported-shell" : "supported-page";
  }

  if (captureStatus.pageSupported === false) {
    return "unsupported-page";
  }

  return "detecting-page";
}

function canInteractWithCurrentTab() {
  return Boolean(currentTab?.id) && isFeishuWorkspaceUrl(currentTab.url);
}

function getCurrentPageUrl() {
  if (typeof captureStatus?.url === "string" && captureStatus.url) {
    return captureStatus.url;
  }

  return typeof currentTab?.url === "string" ? currentTab.url : "";
}

function getCurrentPageSessionKey() {
  return typeof captureStatus?.pageSessionKey === "string" ? captureStatus.pageSessionKey : "";
}

function isSnapshotStaleForPane(paneId, snapshot) {
  if (paneId !== state.activePaneId || !snapshot) {
    return false;
  }

  const currentPageUrl = getCurrentPageUrl();
  const supportState = getPageSupportState();
  if (!currentPageUrl || !isFeishuWorkspaceUrl(currentPageUrl)) {
    return false;
  }

  if (supportState !== "supported-page" && supportState !== "supported-shell") {
    return false;
  }

  const currentPageSessionKey = getCurrentPageSessionKey();
  if (currentPageSessionKey && snapshot.pageSessionKey) {
    return snapshot.pageSessionKey !== currentPageSessionKey;
  }

  return Boolean(snapshot.url) && snapshot.url !== currentPageUrl;
}

function shouldShowStaleScriptHint(supportState) {
  if (supportState !== lastSupportState) {
    lastSupportState = supportState;
    supportStateSince = Date.now();
    return false;
  }

  if (supportState !== "script-not-ready" && supportState !== "detecting-page") {
    return false;
  }

  return Date.now() - supportStateSince >= STALE_SCRIPT_HINT_DELAY_MS;
}

function applyLayout(layout) {
  if (!canInteractWithCurrentTab() || !SUPPORTED_LAYOUTS.includes(layout)) {
    return;
  }

  state.layout = layout;

  if (layout === "single") {
    state.activePaneId = "paneA";
  }

  persistAndRender();
}

function setActivePane(paneId) {
  if (!canInteractWithCurrentTab() || !state.panes[paneId]) {
    return;
  }

  if (state.layout === "single" && paneId === "paneB") {
    return;
  }

  state.activePaneId = paneId;
  persistAndRender();
}

function updatePaneMode(paneId, mode) {
  if (!canInteractWithCurrentTab() || !state.panes[paneId] || !SUPPORTED_MODES.includes(mode)) {
    return;
  }

  state.panes[paneId].mode = mode;
  persistAndRender();
}

function applyIncomingSnapshot(snapshot) {
  const normalized = normalizeSnapshot(snapshot);
  if (!normalized || !currentTab?.id || normalized.tabId !== currentTab.id) {
    render();
    return;
  }

  state.panes[state.activePaneId].snapshot = normalized;
  persistAndRender();
}

function applyCaptureStatus(nextStatus) {
  captureStatus = normalizeCaptureStatus(nextStatus);
  render();
}

function requestContentScriptInjection(tabId, supportState = getPageSupportState()) {
  if (!Number.isInteger(tabId) || !canInteractWithCurrentTab()) {
    return;
  }

  if (supportState !== "script-not-ready" && supportState !== "detecting-page") {
    return;
  }

  const lastRequestedAt = contentScriptInjectionRequestAtByTab.get(tabId) || 0;
  if (Date.now() - lastRequestedAt < CONTENT_SCRIPT_REQUEST_COOLDOWN_MS) {
    return;
  }

  contentScriptInjectionRequestAtByTab.set(tabId, Date.now());
  chrome.runtime.sendMessage(
    {
      type: "ENSURE_CONTENT_SCRIPT",
      payload: { tabId }
    },
    () => {
      void chrome.runtime.lastError;
    }
  );
}

function persistAndRender() {
  render();

  if (!currentTab?.id) {
    return;
  }

  chrome.storage.session.set({ [getPanelStateKey(currentTab.id)]: state }, () => {
    void chrome.runtime.lastError;
  });
}

function render() {
  const supportState = getPageSupportState();
  const staleScriptOrNotInjected = shouldShowStaleScriptHint(supportState);
  const canInteract = canInteractWithCurrentTab();
  board.dataset.layout = state.layout;
  board.dataset.connected = String(supportState === "supported-page");

  for (const button of layoutButtons) {
    const isActive = button.dataset.layout === state.layout;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
    button.disabled = !canInteract;
  }

  for (const [paneId, pane] of paneElements.entries()) {
    const paneState = state.panes[paneId];
    const isActivePane = paneId === state.activePaneId;
    const isHidden = state.layout === "single" && paneId === "paneB";

    pane.root.classList.toggle("is-active", isActivePane);
    pane.root.classList.toggle("is-hidden", isHidden);
    pane.root.classList.toggle("is-disabled", !canInteract);
    pane.header.disabled = !canInteract;
    pane.modeSelect.disabled = !canInteract;
    pane.modeSelect.value = paneState.mode;

    if (!currentTab?.id) {
      pane.badge.textContent = "等待中";
    } else if (supportState === "supported-shell") {
      pane.badge.textContent = "待捕获";
    } else if (supportState === "unsupported-page") {
      pane.badge.textContent = "不支持";
    } else if (staleScriptOrNotInjected) {
      pane.badge.textContent = "待刷新";
    } else if (supportState !== "supported-page") {
      pane.badge.textContent = "未连接";
    } else {
      pane.badge.textContent = isActivePane ? "跟随中" : "冻结中";
    }

    renderPaneMeta(paneId, paneState);
    renderPaneContent(pane.content, paneState);
  }

  requestContentScriptInjection(currentTab?.id, supportState);
}

function renderPaneMeta(paneId, paneState) {
  const pane = paneElements.get(paneId);
  const snapshot = paneState.snapshot;
  const isStaleSnapshot = isSnapshotStaleForPane(paneId, snapshot);
  const shouldShowBindingHint = paneId !== state.activePaneId && hasAnyPaneSnapshot();
  const supportState = getPageSupportState();
  const staleScriptOrNotInjected = shouldShowStaleScriptHint(supportState);

  if (supportState === "no-tab") {
    pane.meta.textContent = "等待";
    return;
  }

  if (supportState === "outside-feishu") {
    pane.meta.textContent = snapshot ? "已保留" : "未支持";
    return;
  }

  if (supportState === "script-not-ready" || supportState === "detecting-page") {
    pane.meta.textContent = snapshot ? "已保留" : staleScriptOrNotInjected ? "待重连" : "未连接";
    return;
  }

  if (supportState === "supported-shell") {
    if (isStaleSnapshot) {
      pane.meta.textContent = "等待";
      return;
    }

    pane.meta.textContent = snapshot ? "等待" : "待捕获";
    return;
  }

  if (isStaleSnapshot) {
    pane.meta.textContent = "等待";
    return;
  }

  if (supportState === "unsupported-page") {
    pane.meta.textContent = snapshot ? "已保留" : "未支持";
    return;
  }

  if (!snapshot) {
    pane.meta.textContent = shouldShowBindingHint ? "空白" : "等待";
    return;
  }

  const kindInfo = inferContentKind(snapshot.rawContent, paneState.mode);
  const cellRef = snapshot.cellRef || "当前";
  pane.meta.textContent = `${cellRef} · ${kindLabel(kindInfo.kind)}`;
}

function renderPaneContent(container, paneState) {
  container.replaceChildren();
  const paneId = Array.from(paneElements.entries()).find(([, pane]) => pane.content === container)?.[0] || null;
  const isStaleSnapshot = paneId ? isSnapshotStaleForPane(paneId, paneState.snapshot) : false;
  const shouldShowBindingHint = paneId && paneId !== state.activePaneId && hasAnyPaneSnapshot();
  const supportState = getPageSupportState();
  const staleScriptOrNotInjected = shouldShowStaleScriptHint(supportState);

  if (supportState === "no-tab") {
    container.appendChild(
      createEmptyState(
        "等待当前标签页"
      )
    );
    return;
  }

  if (supportState === "outside-feishu") {
    if (paneState.snapshot) {
      const preview = renderPreview(paneState.snapshot, paneState.mode);
      container.appendChild(preview);
      return;
    }

    container.appendChild(
      createEmptyState(
        "当前页不可预览"
      )
    );
    return;
  }

  if (supportState === "script-not-ready" || supportState === "detecting-page") {
    if (paneState.snapshot) {
      const preview = renderPreview(paneState.snapshot, paneState.mode);
      container.appendChild(preview);
      return;
    }

    container.appendChild(
      createEmptyState(
        staleScriptOrNotInjected ? "待重连" : "未连接"
      )
    );
    return;
  }

  if (supportState === "supported-shell") {
    if (isStaleSnapshot) {
      container.appendChild(
        createEmptyState(
          "等待当前选区"
        )
      );
      return;
    }

    if (paneState.snapshot) {
      const preview = renderPreview(paneState.snapshot, paneState.mode);
      container.appendChild(preview);
      return;
    }

    container.appendChild(
      createEmptyState(
        "等待当前选区"
      )
    );
    return;
  }

  if (supportState === "unsupported-page") {
    if (paneState.snapshot) {
      const preview = renderPreview(paneState.snapshot, paneState.mode);
      container.appendChild(preview);
      return;
    }

    container.appendChild(
      createEmptyState(
        "当前页不可预览"
      )
    );
    return;
  }

  if (isStaleSnapshot) {
    container.appendChild(
      createEmptyState(
        "等待当前选区"
      )
    );
    return;
  }

  if (!paneState.snapshot) {
    if (shouldShowBindingHint) {
      container.appendChild(
        createEmptyState(
          "空白"
        )
      );
      return;
    }

    container.appendChild(
      createEmptyState(
        hasCaptureAttempted(captureStatus) ? "未捕获" : "等待当前选区"
      )
    );
    return;
  }

  if (!paneState.snapshot.rawContent) {
    container.appendChild(
      createEmptyState(
        paneState.snapshot.cellRef ? `${paneState.snapshot.cellRef} 为空` : "空单元格"
      )
    );
    return;
  }

  const preview = renderPreview(paneState.snapshot, paneState.mode);
  container.appendChild(preview);
}

function renderPreview(snapshot, mode) {
  const card = createElement("section", "preview-card");
  const kindInfo = inferContentKind(snapshot.rawContent, mode);

  const meta = createElement("div", "preview-card__meta");
  meta.appendChild(createTag(snapshot.cellRef || "未识别坐标"));
  meta.appendChild(createTag(kindLabel(kindInfo.kind)));

  if (snapshot.pageTitle) {
    meta.appendChild(createTag(snapshot.pageTitle));
  }

  card.appendChild(meta);

  if (kindInfo.warning) {
    card.appendChild(createWarningCard(kindInfo.warning));
  }

  switch (kindInfo.kind) {
    case "markdown":
      card.appendChild(renderMarkdownBlock(snapshot.rawContent));
      break;
    case "json":
      card.appendChild(renderJsonBlock(snapshot.rawContent));
      break;
    case "latex":
      card.appendChild(renderLatexBlock(snapshot.rawContent));
      break;
    case "media":
      card.appendChild(renderMediaBlock(kindInfo.mediaItems, snapshot.rawContent));
      break;
    case "text":
    default:
      card.appendChild(renderTextBlock(snapshot.rawContent));
      break;
  }

  return card;
}

function hasCaptureAttempted(status) {
  return Boolean(status?.lastExtractorStage && status.lastExtractorStage !== "script-ready");
}

function hasAnyPaneSnapshot() {
  return Object.values(state.panes).some((pane) => Boolean(pane.snapshot));
}

function inferContentKind(rawContent, mode) {
  const trimmed = String(rawContent || "").trim();
  const mediaItems = extractMediaItems(trimmed);
  const embeddableMediaItems = mediaItems.filter((item) => item.type !== "unknown");

  if (!trimmed) {
    return { kind: "text", mediaItems };
  }

  if (mode !== "auto") {
    if (mode === "json" && !looksLikeJson(trimmed)) {
      return {
        kind: "json",
        mediaItems,
        warning: "JSON 格式可能不完整。"
      };
    }

    if (mode === "media") {
      return {
        kind: "media",
        mediaItems,
        warning: buildExplicitMediaWarning(mediaItems)
      };
    }

    return { kind: mode, mediaItems };
  }

  if (embeddableMediaItems.length > 0 && strippedMediaText(trimmed).length === 0) {
    return { kind: "media", mediaItems };
  }

  if (looksLikeJson(trimmed)) {
    return { kind: "json", mediaItems };
  }

  if (looksLikeLatex(trimmed)) {
    return { kind: "latex", mediaItems };
  }

  if (looksLikeMarkdown(trimmed)) {
    return { kind: "markdown", mediaItems };
  }

  if (embeddableMediaItems.length > 0) {
    return {
      kind: "media",
      mediaItems,
      warning: "已按媒体展示。"
    };
  }

  if (mediaItems.length > 0) {
    return {
      kind: "media",
      mediaItems,
      warning: "链接可直接打开。"
    };
  }

  return { kind: "text", mediaItems };
}

function buildExplicitMediaWarning(mediaItems) {
  if (!mediaItems.length) {
    return "当前内容里没有检测到可识别的媒体链接，下面会回退展示原文。";
  }

  if (mediaItems.every((item) => item.type === "unknown")) {
    return "识别到了链接，但暂时无法安全嵌入，下面保留可点击链接和原文。";
  }

  return "";
}

function looksLikeJson(value) {
  if (!/^[\[{]/.test(value)) {
    return false;
  }

  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function looksLikeLatex(value) {
  const trimmed = value.trim();

  if (/^\${1,2}[\s\S]+\${1,2}$/.test(trimmed) || /^\\\[[\s\S]+\\\]$/.test(trimmed) || /^\\\([\s\S]+\\\)$/.test(trimmed)) {
    return true;
  }

  if (/\\(frac|sqrt|sum|int|alpha|beta|gamma|theta|lambda|pi|sigma|phi|omega|begin|end|left|right|cdot|times|neq|leq|geq|text|mathrm|mathbf)/.test(trimmed)) {
    return true;
  }

  if (/\b[A-Za-z0-9]+\^[A-Za-z0-9]\b/.test(trimmed) || /\b[A-Za-z0-9]+\^\{[^}]+\}/.test(trimmed)) {
    return true;
  }

  if (/\b[A-Za-z]_[A-Za-z0-9]\b/.test(trimmed) || /\b[A-Za-z0-9]+_\{[^}]+\}/.test(trimmed)) {
    return true;
  }

  return false;
}

function looksLikeMarkdown(value) {
  return (
    /(^|\n)#{1,6}\s/.test(value) ||
    /(^|\n)\s*[-*+]\s+/.test(value) ||
    /(^|\n)\s*\d+\.\s+/.test(value) ||
    /(^|\n)>\s+/.test(value) ||
    /```/.test(value) ||
    /\[[^\]]+\]\((https?:\/\/[^\s)]+)\)/.test(value) ||
    /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/.test(value) ||
    /(\*\*|__)[^*_]+(\*\*|__)/.test(value) ||
    /`[^`]+`/.test(value)
  );
}

function strippedMediaText(value) {
  return value
    .replace(/!\[[^\]]*]\((https?:\/\/[^\s)]+)\)/g, "")
    .replace(/https?:\/\/[^\s)]+/g, "")
    .replace(/\s+/g, "");
}

function extractMediaItems(rawContent) {
  const items = new Map();
  const urlMatches = [];

  for (const match of rawContent.matchAll(/!\[[^\]]*]\((https?:\/\/[^\s)]+)\)/g)) {
    urlMatches.push(match[1]);
  }

  for (const match of rawContent.matchAll(/https?:\/\/[^\s<>"')]+/g)) {
    urlMatches.push(trimTrailingPunctuation(match[0]));
  }

  for (const rawUrl of urlMatches) {
    const safeUrl = sanitizeUrl(rawUrl);
    if (!safeUrl || items.has(safeUrl)) {
      continue;
    }

    items.set(safeUrl, resolveMediaItem(safeUrl));
  }

  return Array.from(items.values());
}

function resolveMediaItem(url) {
  const fallback = { url, type: "unknown" };

  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) {
      return fallback;
    }

    for (const candidate of collectFilenameCandidates(parsed)) {
      const type = inferMediaTypeFromName(candidate);
      if (type !== "unknown") {
        return { url, type };
      }
    }

    const mimeType = inferMediaTypeFromQuery(parsed);
    if (mimeType !== "unknown") {
      return { url, type: mimeType };
    }

    const feishuType = inferFeishuMediaType(parsed);
    if (feishuType !== "unknown") {
      return { url, type: feishuType };
    }

    return fallback;
  } catch {
    return fallback;
  }
}

function collectFilenameCandidates(parsed) {
  const candidates = [];
  const pathSegment = parsed.pathname.split("/").filter(Boolean).pop();

  if (pathSegment) {
    candidates.push(pathSegment);
  }

  for (const key of ["filename", "file_name", "fileName", "name", "download_name", "downloadName", "attname", "origin_name", "originName"]) {
    const value = parsed.searchParams.get(key);
    if (value) {
      candidates.push(value);
    }
  }

  return candidates.map(decodeMaybe);
}

function inferMediaTypeFromName(value) {
  const normalized = decodeMaybe(String(value || "")).toLowerCase();
  const match = normalized.match(/\.([a-z0-9]+)(?:$|[?#])/);

  if (!match) {
    return "unknown";
  }

  if (IMAGE_EXTENSIONS.has(match[1])) {
    return "image";
  }

  if (VIDEO_EXTENSIONS.has(match[1])) {
    return "video";
  }

  return "unknown";
}

function inferMediaTypeFromQuery(parsed) {
  for (const key of ["mime_type", "mimeType", "content-type", "contentType", "type", "file_type", "fileType"]) {
    const value = decodeMaybe(parsed.searchParams.get(key) || "").toLowerCase();

    if (value.startsWith("image/")) {
      return "image";
    }

    if (value.startsWith("video/")) {
      return "video";
    }
  }

  return "unknown";
}

function inferFeishuMediaType(parsed) {
  if (!FEISHU_MEDIA_HOST_PATTERN.test(parsed.hostname)) {
    return "unknown";
  }

  const path = decodeMaybe(parsed.pathname).toLowerCase();
  const queryHints = Array.from(parsed.searchParams.entries())
    .map(([key, value]) => `${decodeMaybe(key)} ${decodeMaybe(value)}`)
    .join(" ")
    .toLowerCase();
  const joined = `${path} ${queryHints}`;

  if (FEISHU_IMAGE_HINT_PATTERN.test(joined)) {
    return "image";
  }

  if (FEISHU_VIDEO_HINT_PATTERN.test(joined)) {
    return "video";
  }

  return "unknown";
}

function isEmbeddableMediaItem(item) {
  return Boolean(item) && (item.type === "image" || item.type === "video");
}

function isUnknownMediaItem(item) {
  return Boolean(item) && item.type === "unknown";
}

function renderTextBlock(rawContent) {
  const pre = createElement("pre", "preview-text");
  pre.textContent = rawContent;
  return pre;
}

function renderMarkdownBlock(rawContent) {
  const article = createElement("article", "markdown-body");
  article.innerHTML = markdownToHtml(rawContent);
  return article;
}

function renderJsonBlock(rawContent) {
  const wrapper = createElement("div", "json-block");
  const pre = createElement("pre");

  try {
    const formatted = JSON.stringify(JSON.parse(rawContent), null, 2);
    pre.innerHTML = syntaxHighlightJson(formatted);
  } catch {
    pre.textContent = rawContent;
  }

  wrapper.appendChild(pre);
  return wrapper;
}

function renderLatexBlock(rawContent) {
  const panel = createElement("section", "latex-panel");
  const rendered = createElement("div", "latex-rendered");
  const source = createElement("pre", "latex-source");
  source.textContent = rawContent;

  try {
    if (!globalThis.katex) {
      throw new Error("KaTeX 资源未加载");
    }

    const payload = parseLatexPayload(rawContent);
    globalThis.katex.render(payload.expression, rendered, {
      displayMode: payload.displayMode,
      throwOnError: true,
      strict: "warn",
      trust: false
    });

    const note = createElement("p", "latex-note");
    note.textContent = payload.displayMode ? "已按块级公式渲染。" : "已按行内公式渲染。";

    panel.append(rendered, note, source);
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    panel.append(createWarningCard(`LaTeX 渲染失败，已回退源码预览：${message}`), source);
  }

  return panel;
}

function parseLatexPayload(rawContent) {
  const trimmed = String(rawContent || "").trim();

  if (/^\$\$[\s\S]+\$\$$/.test(trimmed)) {
    return {
      expression: trimmed.slice(2, -2).trim(),
      displayMode: true
    };
  }

  if (/^\$[\s\S]+\$$/.test(trimmed)) {
    return {
      expression: trimmed.slice(1, -1).trim(),
      displayMode: false
    };
  }

  if (/^\\\[[\s\S]+\\\]$/.test(trimmed)) {
    return {
      expression: trimmed.slice(2, -2).trim(),
      displayMode: true
    };
  }

  if (/^\\\([\s\S]+\\\)$/.test(trimmed)) {
    return {
      expression: trimmed.slice(2, -2).trim(),
      displayMode: false
    };
  }

  return {
    expression: trimmed,
    displayMode: /\n/.test(trimmed) || /\\begin\{/.test(trimmed)
  };
}

function renderMediaBlock(mediaItems, rawContent) {
  const wrapper = createElement("section", "media-grid");
  const embeddableItems = mediaItems.filter((item) => isEmbeddableMediaItem(item));
  const linkOnlyItems = mediaItems.filter((item) => isUnknownMediaItem(item));

  if (!mediaItems.length) {
    wrapper.appendChild(createWarningCard("没有识别出可直接嵌入的图片或视频链接，下面展示原始文本。"));
    wrapper.appendChild(renderTextBlock(rawContent));
    return wrapper;
  }

  if (!embeddableItems.length) {
    wrapper.appendChild(createWarningCard("识别到了链接，但暂时无法安全嵌入，下面保留原始链接和原文。"));
  }

  for (const item of embeddableItems) {
    const card = createElement("article", "media-card");

    if (item.type === "image") {
      const image = createElement("img");
      image.src = item.url;
      image.alt = "预览图片";
      image.loading = "lazy";
      card.appendChild(image);
    }

    if (item.type === "video") {
      const video = createElement("video");
      video.src = item.url;
      video.controls = true;
      video.preload = "metadata";
      card.appendChild(video);
    }

    const link = createExternalLink(item.url, item.url);
    link.className = "media-card__url";
    card.appendChild(link);
    wrapper.appendChild(card);
  }

  if (linkOnlyItems.length) {
    wrapper.appendChild(createLinkList(linkOnlyItems.map((item) => item.url), embeddableItems.length ? "其他链接" : "识别到的链接"));
  }

  if (strippedMediaText(rawContent).length > 0) {
    wrapper.appendChild(createWarningCard("存在附加文本。"));
  }

  if (!embeddableItems.length) {
    wrapper.appendChild(renderTextBlock(rawContent));
  }

  return wrapper;
}

function markdownToHtml(markdown) {
  const lines = normalizeLineEndings(markdown).split("\n");
  const blocks = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (!line.trim()) {
      continue;
    }

    if (/^```/.test(line.trim())) {
      const language = line.trim().slice(3).trim();
      const buffer = [];
      index += 1;

      while (index < lines.length && !/^```/.test(lines[index].trim())) {
        buffer.push(lines[index]);
        index += 1;
      }

      blocks.push(
        `<pre><code class="language-${escapeAttribute(language)}">${escapeHtml(buffer.join("\n"))}</code></pre>`
      );
      continue;
    }

    if (/^#{1,6}\s/.test(line)) {
      const [, hashes, content] = line.match(/^(#{1,6})\s+(.*)$/) || [];
      const level = hashes.length;
      blocks.push(`<h${level}>${renderInlineMarkdown(content)}</h${level}>`);
      continue;
    }

    if (/^>\s?/.test(line)) {
      const buffer = [line.replace(/^>\s?/, "")];
      while (index + 1 < lines.length && /^>\s?/.test(lines[index + 1])) {
        index += 1;
        buffer.push(lines[index].replace(/^>\s?/, ""));
      }

      blocks.push(`<blockquote>${buffer.map(renderInlineMarkdown).join("<br>")}</blockquote>`);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [line.replace(/^\s*[-*+]\s+/, "")];
      while (index + 1 < lines.length && /^\s*[-*+]\s+/.test(lines[index + 1])) {
        index += 1;
        items.push(lines[index].replace(/^\s*[-*+]\s+/, ""));
      }

      blocks.push(`<ul>${items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [line.replace(/^\s*\d+\.\s+/, "")];
      while (index + 1 < lines.length && /^\s*\d+\.\s+/.test(lines[index + 1])) {
        index += 1;
        items.push(lines[index].replace(/^\s*\d+\.\s+/, ""));
      }

      blocks.push(`<ol>${items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ol>`);
      continue;
    }

    const paragraph = [line];
    while (
      index + 1 < lines.length &&
      lines[index + 1].trim() &&
      !/^```/.test(lines[index + 1].trim()) &&
      !/^#{1,6}\s/.test(lines[index + 1]) &&
      !/^>\s?/.test(lines[index + 1]) &&
      !/^\s*[-*+]\s+/.test(lines[index + 1]) &&
      !/^\s*\d+\.\s+/.test(lines[index + 1])
    ) {
      index += 1;
      paragraph.push(lines[index]);
    }

    blocks.push(`<p>${renderInlineMarkdown(paragraph.join("\n"))}</p>`);
  }

  return blocks.join("");
}

function renderInlineMarkdown(text) {
  let html = escapeHtml(text);

  html = html.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (match, alt, url) => {
    const safe = sanitizeUrl(url);
    if (!safe) {
      return escapeHtml(match);
    }

    return `<figure class="markdown-media"><img src="${escapeAttribute(safe)}" alt="${escapeAttribute(alt)}" loading="lazy"></figure>`;
  });

  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (match, label, url) => {
    const safe = sanitizeUrl(url);
    if (!safe) {
      return escapeHtml(match);
    }

    return `<a href="${escapeAttribute(safe)}" target="_blank" rel="noreferrer">${label}</a>`;
  });

  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  html = html.replace(/(^|[^_])_([^_]+)_/g, "$1<em>$2</em>");
  html = html.replace(/\n/g, "<br>");

  return html;
}

function syntaxHighlightJson(json) {
  return escapeHtml(json).replace(
    /("(\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let className = "json-number";

      if (match.startsWith('"')) {
        className = match.endsWith(":") ? "json-key" : "json-string";
      } else if (/true|false/.test(match)) {
        className = "json-boolean";
      } else if (/null/.test(match)) {
        className = "json-null";
      }

      return `<span class="${className}">${match}</span>`;
    }
  );
}

function kindLabel(kind) {
  switch (kind) {
    case "markdown":
      return "Markdown";
    case "json":
      return "JSON";
    case "latex":
      return "LaTeX";
    case "media":
      return "媒体";
    case "text":
    default:
      return "纯文本";
  }
}

function createEmptyState(title) {
  const wrapper = createElement("section", "empty-state");
  wrapper.innerHTML = `<div>${escapeHtml(title)}</div>`;
  return wrapper;
}

function createWarningCard(message) {
  const warning = createElement("div", "warning-card");
  warning.textContent = message;
  return warning;
}

function createTag(label) {
  const tag = createElement("span", "tag");
  tag.textContent = label;
  return tag;
}

function createExternalLink(label, url) {
  const link = createElement("a");
  link.href = sanitizeUrl(url) || "#";
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = label;
  return link;
}

function createLinkList(urls, title) {
  const wrapper = createElement("section", "link-list");

  if (title) {
    const heading = createElement("strong", "link-list__title");
    heading.textContent = title;
    wrapper.appendChild(heading);
  }

  for (const url of urls) {
    wrapper.appendChild(createExternalLink(url, url));
  }

  return wrapper;
}

function createElement(tagName, className) {
  const element = document.createElement(tagName);
  if (className) {
    element.className = className;
  }
  return element;
}

function sanitizeUrl(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function trimTrailingPunctuation(value) {
  return value.replace(/[),.;!?]+$/, "");
}

function normalizeLineEndings(value) {
  return String(value || "").replace(/\r\n?/g, "\n");
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function decodeMaybe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sanitizeInlineText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function cloneDefaultState() {
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

function mergeState(input) {
  const merged = cloneDefaultState();

  if (!input || typeof input !== "object") {
    return merged;
  }

  if (SUPPORTED_LAYOUTS.includes(input.layout)) {
    merged.layout = input.layout;
  }

  for (const paneId of Object.keys(merged.panes)) {
    if (!input.panes?.[paneId]) {
      continue;
    }

    if (SUPPORTED_MODES.includes(input.panes[paneId].mode)) {
      merged.panes[paneId].mode = input.panes[paneId].mode;
    }

    const snapshot = normalizeSnapshot(input.panes[paneId].snapshot);
    if (snapshot) {
      merged.panes[paneId].snapshot = snapshot;
    }
  }

  if (input.activePaneId === "paneB" && merged.layout !== "single") {
    merged.activePaneId = "paneB";
  }

  return merged;
}

function normalizeSnapshot(input) {
  if (!input || typeof input !== "object") {
    return null;
  }

  const rawContent = typeof input.rawContent === "string" ? input.rawContent : String(input.rawContent || "");
  const cellRef = typeof input.cellRef === "string" && input.cellRef.trim() ? input.cellRef.trim() : null;
  const source = typeof input.source === "string" && input.source.trim() ? input.source.trim() : "unknown";
  const pageTitle = typeof input.pageTitle === "string" ? sanitizeInlineText(input.pageTitle) : "";
  const url = typeof input.url === "string" ? input.url : "";
  const pageSessionKey = typeof input.pageSessionKey === "string" ? input.pageSessionKey.trim() : "";
  const capturedAt = Number.isFinite(input.capturedAt) ? input.capturedAt : null;
  const tabId = Number.isInteger(input.tabId) ? input.tabId : null;

  return {
    cellRef,
    rawContent,
    source,
    pageTitle,
    url,
    pageSessionKey,
    capturedAt,
    tabId
  };
}

function normalizeCaptureStatus(input) {
  if (!input || typeof input !== "object") {
    return null;
  }

  return {
    ready: Boolean(input.ready),
    connectedAt: Number.isFinite(input.connectedAt) ? input.connectedAt : null,
    lastReadyAt: Number.isFinite(input.lastReadyAt) ? input.lastReadyAt : null,
    lastStatusAt: Number.isFinite(input.lastStatusAt) ? input.lastStatusAt : null,
    lastSnapshotAt: Number.isFinite(input.lastSnapshotAt) ? input.lastSnapshotAt : null,
    lastExtractorStage: typeof input.lastExtractorStage === "string" ? input.lastExtractorStage.trim() : "",
    lastExtractorMessage: typeof input.lastExtractorMessage === "string" ? input.lastExtractorMessage.trim() : "",
    lastError: typeof input.lastError === "string" ? input.lastError.trim() : "",
    pageKind: typeof input.pageKind === "string" ? input.pageKind.trim() : "",
    pageSupported: typeof input.pageSupported === "boolean" ? input.pageSupported : null,
    lastSupportReason:
      typeof input.lastSupportReason === "string"
        ? input.lastSupportReason.trim()
        : typeof input.supportReason === "string"
          ? input.supportReason.trim()
          : "",
    pageTitle: typeof input.pageTitle === "string" ? sanitizeInlineText(input.pageTitle) : "",
    url: typeof input.url === "string" ? input.url : "",
    pageSessionKey: typeof input.pageSessionKey === "string" ? input.pageSessionKey.trim() : ""
  };
}

function setTestRuntimeState(nextState = {}) {
  if ("state" in nextState) {
    state = mergeState(nextState.state);
  }

  if ("currentTab" in nextState) {
    currentTab = nextState.currentTab ? normalizeTab(nextState.currentTab) : null;
  }

  if ("captureStatus" in nextState) {
    captureStatus = normalizeCaptureStatus(nextState.captureStatus);
  }

  if ("lastSupportState" in nextState) {
    lastSupportState = String(nextState.lastSupportState || "");
  }

  if ("supportStateSince" in nextState) {
    supportStateSince = Number.isFinite(nextState.supportStateSince) ? nextState.supportStateSince : Date.now();
  }
}

function getTestRuntimeState() {
  return {
    state,
    currentTab,
    captureStatus,
    lastSupportState,
    supportStateSince
  };
}

function exposeSidepanelTestExports() {
  if (!SHEET_MATE_TEST_MODE) {
    return;
  }

  const root = globalThis.__sheetMateTestExports || (globalThis.__sheetMateTestExports = {});
  root.sidepanel = {
    extractMediaItems,
    inferContentKind,
    mergeState,
    renderPreview,
    render,
    resolveMediaItem,
    setTestRuntimeState
  };
}

exposeSidepanelTestExports();
