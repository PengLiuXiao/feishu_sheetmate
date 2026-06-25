const SHEET_MATE_TEST_MODE = globalThis.__SHEET_MATE_TEST__ === true;

function createSheetMateContentScriptRuntime(options = {}) {
  const { skipAutoStart = false } = options;

  if (!skipAutoStart && window.__sheetMateContentScriptLoaded__) {
    return null;
  }

  const LAST_SENT_SNAPSHOT_KEY = "__sheetMateLastSentSnapshot__";
  const LAST_SENT_STATUS_KEY = "__sheetMateLastSentStatus__";
  const CAPTURE_DELAY_MS = 140;
  const POLL_INTERVAL_MS = 1200;
  const TOP_BAR_SCAN_MAX_TOP = 420;
  const NAME_BOX_MAX_WIDTH = 140;
  const FORMULA_BAR_MIN_WIDTH = 180;
  const CELL_REF_REGEX = /\b([A-Z]{1,4}\d{1,7})\b/;
  const STRICT_CELL_REF_REGEX = /^([A-Z]{1,4}\d{1,7})$/;
  const EDITOR_SELECTORS = [
    "textarea",
    'input[type="text"]',
    "input:not([type])",
    '[contenteditable="true"]',
    '[role="textbox"]'
  ];
  const FORMULA_BAR_SELECTORS = [
    '[data-testid*="formula"]',
    '[data-testid*="fx"]',
    '[aria-label*="公式"]',
    '[aria-label*="formula"]',
    '[aria-label*="fx"]',
    '[class*="formula-bar"]',
    '[class*="formulabar"]',
    '[class*="formulaBar"]',
    '[class*="formula_input"]',
    '[class*="formulaInput"]',
    '[class*="inputarea"]'
  ];
  const NAME_BOX_SELECTORS = [
    '[data-testid*="name-box"]',
    '[data-testid*="cell-name"]',
    '[aria-label*="名称"]',
    '[aria-label*="name box"]',
    '[aria-label*="cell name"]',
    '[class*="name-box"]',
    '[class*="nameBox"]',
    '[class*="cell-name"]',
    '[class*="cellName"]'
  ];
  const ACTIVE_CELL_SELECTORS = [
    '[role="gridcell"][aria-selected="true"]',
    '[role="cell"][aria-selected="true"]',
    '[aria-rowindex][aria-colindex][aria-selected="true"]',
    '[data-row][data-col][data-active="true"]',
    '[data-row-index][data-col-index][data-active="true"]',
    '[class*="active-cell"]',
    '[class*="current-cell"]',
    '[class*="focused-cell"]',
    '[class*="cell-active"]'
  ];
  const SHEET_TOOLBAR_SELECTORS = [
    '[role="toolbar"]',
    '[data-testid*="toolbar"]',
    '[aria-label*="工具"]',
    '[aria-label*="菜单"]',
    '[aria-label*="插入"]',
    '[class*="toolbar"]',
    '[class*="tool-bar"]'
  ];
  const SUPPORT_GRID_ANCHOR_SELECTORS = [
    '[role="grid"]',
    '[role="gridcell"]',
    '[aria-rowindex][aria-colindex]',
    '[data-row][data-col]',
    '[data-row-index][data-col-index]'
  ];

  let captureTimer = null;
  let captureInterval = null;
  let mutationObserver = null;
  let isShutDown = false;
  let runtimeStarted = false;
  let currentRouteUrl = window.location.href;
  let currentNavigationFingerprint = "";
  let pageSessionVersion = 0;
  let pageSessionKey = "";
  let originalPushState = null;
  let originalReplaceState = null;
  const routeCaptureTimers = new Set();
  const listenerDisposers = [];

  function scheduleCapture() {
    if (isShutDown) {
      return;
    }

    if (!isExtensionContextAlive()) {
      teardown("extension-context-invalidated");
      return;
    }

    window.clearTimeout(captureTimer);
    captureTimer = window.setTimeout(captureAndSendSnapshot, CAPTURE_DELAY_MS);
  }

  function captureAndSendSnapshot() {
    if (isShutDown) {
      return;
    }

    if (!isExtensionContextAlive()) {
      teardown("extension-context-invalidated");
      return;
    }

    if (reconcilePageSession()) {
      reportReady();
    }

    if (document.hidden) {
      return;
    }

    const result = readCellSnapshot();
    reportCaptureStatus(result.status);

    if (!result.snapshot) {
      return;
    }

    const fingerprint = JSON.stringify([
      result.snapshot.cellRef || "",
      result.snapshot.rawContent || "",
      result.snapshot.source || "",
      result.snapshot.extractorStage || "",
      result.snapshot.pageTitle || "",
      result.snapshot.url || "",
      result.snapshot.pageSessionKey || ""
    ]);

    if (window[LAST_SENT_SNAPSHOT_KEY] === fingerprint) {
      return;
    }

    window[LAST_SENT_SNAPSHOT_KEY] = fingerprint;

    safeSendRuntimeMessage("CELL_SNAPSHOT", result.snapshot);
  }

  function readCellSnapshot() {
    const pageSupport = detectPageSupport();
    if (!pageSupport.pageSupported) {
      return {
        snapshot: null,
        status: {
          ready: true,
          stage: "miss:unsupported-page",
          message: pageSupport.supportReason || "当前页面不是可预览的飞书表格页面。",
          error: "",
          pageKind: pageSupport.pageKind,
          pageSupported: pageSupport.pageSupported,
          supportReason: pageSupport.supportReason
        }
      };
    }

    const missReasons = [];
    const nameBoxCandidate = pageSupport.supportSignals?.nameBoxCandidate || findNameBoxCandidate();
    if (!nameBoxCandidate?.cellRef) {
      missReasons.push("未找到名称框");
    }

    const formulaBarCandidate = pageSupport.supportSignals?.formulaBarCandidate || findFormulaBarCandidate(nameBoxCandidate);
    if (!formulaBarCandidate?.rawContent) {
      missReasons.push("未找到公式栏内容");
    }

    const editorCandidate = pageSupport.supportSignals?.editorCandidate || findEditorCandidate(nameBoxCandidate);
    if (!editorCandidate?.rawContent && !editorCandidate?.cellRef) {
      missReasons.push("未找到编辑态输入框");
    }

    const exactCellCandidate = nameBoxCandidate?.cellRef
      ? buildGridCandidate(findElementByCellReference(nameBoxCandidate.cellRef), nameBoxCandidate.cellRef, "exact-cell")
      : null;
    const selectedCellCandidate =
      pageSupport.supportSignals?.selectedCellCandidate || findSelectedCellCandidate(nameBoxCandidate?.cellRef || null);

    const gridCandidate = chooseBestCandidate([exactCellCandidate, selectedCellCandidate], true);
    if (!gridCandidate?.rawContent && !gridCandidate?.cellRef) {
      missReasons.push("未找到活动单元格");
    }

    const cellRef =
      nameBoxCandidate?.cellRef ||
      editorCandidate?.cellRef ||
      exactCellCandidate?.cellRef ||
      selectedCellCandidate?.cellRef ||
      null;
    const contentCandidate = chooseBestCandidate(
      [formulaBarCandidate, editorCandidate, exactCellCandidate, selectedCellCandidate],
      true
    );
    const rawContent = contentCandidate?.rawContent ?? "";

    const hasCurrentCellContent = Boolean(
      formulaBarCandidate?.rawContent ||
        editorCandidate?.rawContent ||
        selectedCellCandidate?.rawContent ||
        exactCellCandidate?.rawContent
    );
    const hasStableEmptySelection = Boolean(
      cellRef && !rawContent && (formulaBarCandidate || editorCandidate?.cellRef || gridCandidate?.cellRef)
    );

    if (!hasCurrentCellContent && !hasStableEmptySelection) {
      return {
        snapshot: null,
        status: {
          ready: true,
          stage: "miss:no-capture-source",
          message:
            pageSupport.pageKind === "sheet-shell"
              ? "已识别为飞书表格容器，但当前未命中单元格、名称框或公式栏。"
              : uniqueMessages(missReasons).join("；") || "已连接飞书页面，但还没有抓到当前单元格。",
          error: "",
          pageKind: pageSupport.pageKind,
          pageSupported: true,
          supportReason: pageSupport.supportReason
        }
      };
    }

    const context = buildPageContext();
    const sourceParts = [];
    if (nameBoxCandidate?.source) {
      sourceParts.push(nameBoxCandidate.source);
    }
    if (contentCandidate?.source) {
      sourceParts.push(contentCandidate.source);
    } else if (cellRef) {
      sourceParts.push("cell-ref");
    }
    if (hasStableEmptySelection) {
      sourceParts.push("empty-cell");
    }

    const source = uniqueMessages(sourceParts).join("+") || "unknown";
    const extractorMessage = buildHitMessage(sourceParts, cellRef, rawContent);

    return {
      snapshot: {
        cellRef,
        rawContent,
        source,
        extractorStage: `hit:${source}`,
        extractorMessage,
        pageKind: "sheet-ready",
        pageSupported: true,
        supportReason: pageSupport.supportReason,
        ...context
      },
      status: {
        ready: true,
        stage: `hit:${source}`,
        message: extractorMessage,
        error: "",
        pageKind: "sheet-ready",
        pageSupported: true,
        supportReason: pageSupport.supportReason
      }
    };
  }

  function detectPageSupport() {
    const isSheetPath = /\/sheets\//i.test(window.location.pathname);
    const hasGridAnchor = hasVisibleElement(SUPPORT_GRID_ANCHOR_SELECTORS);
    const hasNameBoxAnchor = hasVisibleElement(NAME_BOX_SELECTORS);
    const hasFormulaBarAnchor = hasVisibleElement(FORMULA_BAR_SELECTORS);
    const hasToolbarAnchor = hasVisibleElement(SHEET_TOOLBAR_SELECTORS);
    const nameBoxCandidate = findNameBoxCandidate();
    const formulaBarCandidate = findFormulaBarCandidate(nameBoxCandidate);
    const editorCandidate = findEditorCandidate(nameBoxCandidate);
    const selectedCellCandidate = findSelectedCellCandidate(nameBoxCandidate?.cellRef || null);
    const hasGridSignal = hasGridAnchor || Boolean(selectedCellCandidate?.cellRef || selectedCellCandidate?.rawContent);
    const hasCellReferenceSignal = Boolean(nameBoxCandidate?.cellRef || selectedCellCandidate?.cellRef);
    const hasContentSignal = Boolean(formulaBarCandidate?.rawContent || editorCandidate?.rawContent || selectedCellCandidate?.rawContent);
    const hasAnchorPair = hasNameBoxAnchor && hasFormulaBarAnchor;
    const hasWeakSignal =
      hasCellReferenceSignal ||
      hasNameBoxAnchor ||
      hasFormulaBarAnchor ||
      (isSheetPath && (hasToolbarAnchor || hasContentSignal));

    if (hasGridSignal || hasAnchorPair || (hasCellReferenceSignal && hasContentSignal)) {
      return {
        pageKind: "sheet-ready",
        pageSupported: true,
        supportReason: "已识别到飞书表格网格、活动单元格或名称框/公式栏锚点。",
        supportSignals: {
          nameBoxCandidate,
          formulaBarCandidate,
          editorCandidate,
          selectedCellCandidate
        }
      };
    }

    if (hasWeakSignal) {
      return {
        pageKind: "sheet-shell",
        pageSupported: true,
        supportReason: "已识别到飞书表格容器信号，等待名称框、公式栏或活动单元格稳定。",
        supportSignals: {
          nameBoxCandidate,
          formulaBarCandidate,
          editorCandidate,
          selectedCellCandidate
        }
      };
    }

    return {
      pageKind: "unsupported-page",
      pageSupported: false,
      supportReason: "当前页面未识别到飞书表格锚点（网格、名称框、公式栏）。",
      supportSignals: {
        nameBoxCandidate,
        formulaBarCandidate,
        editorCandidate,
        selectedCellCandidate
      }
    };
  }

  function findNameBoxCandidate() {
    const candidates = [];
    const elements = collectElements([
      ...NAME_BOX_SELECTORS,
      "input",
      "textarea",
      '[role="textbox"]',
      '[contenteditable="true"]',
      '[aria-label]',
      '[data-testid]'
    ]);

    for (const element of elements) {
      if (!(element instanceof HTMLElement) || !isVisible(element)) {
        continue;
      }

      const rect = element.getBoundingClientRect();
      if (!isLikelyTopBarElement(rect)) {
        continue;
      }

      const text = sanitizeInlineText(readElementText(element));
      const exactMatch = text.match(STRICT_CELL_REF_REGEX);
      const looseMatch = exactMatch || text.match(CELL_REF_REGEX);
      if (!looseMatch) {
        continue;
      }

      const isNameLike = matchesAnySelector(element, NAME_BOX_SELECTORS);
      const widthScore = rect.width && rect.width <= NAME_BOX_MAX_WIDTH ? 25 : 0;
      const score =
        70 +
        (isNameLike ? 45 : 0) +
        (exactMatch ? 45 : 0) +
        widthScore +
        Math.max(0, 36 - rect.top / 10);

      candidates.push({
        cellRef: looseMatch[1],
        rawContent: "",
        source: "name-box",
        score
      });
    }

    const selectedElementCandidate = buildGridCandidate(findFocusedGridElement(), null, "focused-cell");
    if (selectedElementCandidate?.cellRef) {
      selectedElementCandidate.score += 20;
      candidates.push(selectedElementCandidate);
    }

    candidates.sort((left, right) => right.score - left.score);
    return candidates[0] || null;
  }

  function findFormulaBarCandidate(nameBoxCandidate) {
    const candidates = [];
    const elements = collectElements([...FORMULA_BAR_SELECTORS, ...EDITOR_SELECTORS]);
    const nameBoxRect = nameBoxCandidate?.cellRef ? findNameBoxRect(nameBoxCandidate.cellRef) : null;

    for (const element of elements) {
      if (!(element instanceof HTMLElement) || !isVisible(element)) {
        continue;
      }

      const rect = element.getBoundingClientRect();
      if (!isLikelyTopBarElement(rect) || rect.width < FORMULA_BAR_MIN_WIDTH) {
        continue;
      }

      const rawContent = readElementText(element);
      const isFormulaLike = matchesAnySelector(element, FORMULA_BAR_SELECTORS);
      const alignedToNameBox = isAlignedWithNameBox(rect, nameBoxRect);
      const isActive = element === document.activeElement || element.contains(document.activeElement);

      if (!rawContent && !isActive && !isFormulaLike) {
        continue;
      }

      const score =
        80 +
        (isFormulaLike ? 60 : 0) +
        (alignedToNameBox ? 40 : 0) +
        (isActive ? 18 : 0) +
        Math.min(rawContent.length, 80) / 4;

      candidates.push({
        rawContent,
        cellRef: nameBoxCandidate?.cellRef || deriveCellReference(element),
        source: "formula-bar",
        score
      });
    }

    candidates.sort((left, right) => right.score - left.score);
    return candidates[0] || null;
  }

  function findEditorCandidate(nameBoxCandidate) {
    const elements = collectElements([...EDITOR_SELECTORS]);
    const nameBoxRect = nameBoxCandidate?.cellRef ? findNameBoxRect(nameBoxCandidate.cellRef) : null;
    if (document.activeElement instanceof HTMLElement) {
      elements.add(document.activeElement);

      const editableParent = document.activeElement.closest?.(
        'textarea, input, [contenteditable="true"], [role="textbox"]'
      );
      if (editableParent instanceof HTMLElement) {
        elements.add(editableParent);
      }
    }

    const candidates = [];

    for (const element of elements) {
      if (!(element instanceof HTMLElement) || !isVisible(element)) {
        continue;
      }

      if (isExcludedCaptureElement(element)) {
        continue;
      }

      const rawContent = readElementText(element);
      const isActive = element === document.activeElement || element.contains(document.activeElement);
      const isFormulaLike = matchesAnySelector(element, FORMULA_BAR_SELECTORS);
      const rect = element.getBoundingClientRect();
      const isBareNameBox = STRICT_CELL_REF_REGEX.test(rawContent) && isLikelyTopBarElement(rect) && rect.width <= NAME_BOX_MAX_WIDTH;

      if (isBareNameBox) {
        continue;
      }

      const directCellRef = deriveCellReference(element);
      const alignedToNameBox = isAlignedWithNameBox(rect, nameBoxRect);
      const formulaBarLike = isFormulaLike && isLikelyTopBarElement(rect) && rect.width >= FORMULA_BAR_MIN_WIDTH && (alignedToNameBox || !nameBoxRect);
      const activeGridEditor = isActive && isInsideSheetGrid(element);
      const explicitCurrentCellEditor = Boolean(
        directCellRef && (!nameBoxCandidate?.cellRef || directCellRef === nameBoxCandidate.cellRef)
      );

      if (!formulaBarLike && !activeGridEditor && !explicitCurrentCellEditor) {
        continue;
      }

      const score =
        55 +
        (isActive ? 32 : 0) +
        (formulaBarLike ? 36 : 0) +
        (explicitCurrentCellEditor ? 28 : 0) +
        (activeGridEditor ? 18 : 0) +
        (isLikelyTopBarElement(rect) ? 8 : 0) +
        Math.min(rawContent.length, 60) / 3;

      if (!rawContent && !isActive && !directCellRef) {
        continue;
      }

      candidates.push({
        rawContent,
        cellRef: directCellRef || (formulaBarLike || activeGridEditor ? nameBoxCandidate?.cellRef : null) || null,
        source: isFormulaLike ? "formula-bar" : "editor",
        score
      });
    }

    candidates.sort((left, right) => right.score - left.score);
    return candidates[0] || null;
  }

  function findSelectedCellCandidate(preferredCellRef) {
    const elements = collectElements(ACTIVE_CELL_SELECTORS);
    const focusedGridElement = findFocusedGridElement();
    if (focusedGridElement) {
      elements.add(focusedGridElement);
    }

    const candidates = [];

    for (const element of elements) {
      const candidate = buildGridCandidate(element, preferredCellRef, "selected-cell");
      if (candidate) {
        candidates.push(candidate);
      }
    }

    candidates.sort((left, right) => right.score - left.score);
    return candidates[0] || null;
  }

  function buildGridCandidate(element, preferredCellRef, source) {
    if (!(element instanceof HTMLElement) || !isVisible(element)) {
      return null;
    }

    const rawContent = readElementText(element);
    const cellRef = deriveCellReference(element) || preferredCellRef || null;
    const isPreferred = Boolean(preferredCellRef && cellRef === preferredCellRef);
    const hasGridSignal =
      element.getAttribute("role") === "gridcell" ||
      Boolean(element.getAttribute("aria-rowindex")) ||
      Boolean(element.getAttribute("aria-colindex")) ||
      Boolean(element.closest('[role="grid"], [role="table"]'));

    if (!rawContent && !cellRef) {
      return null;
    }

    return {
      rawContent,
      cellRef,
      source,
      score:
        48 +
        (isPreferred ? 40 : 0) +
        (hasGridSignal ? 20 : 0) +
        Math.min(rawContent.length, 60) / 4
    };
  }

  function chooseBestCandidate(candidates, preferContent) {
    const normalized = candidates.filter(Boolean);
    if (!normalized.length) {
      return null;
    }

    normalized.sort((left, right) => {
      const leftHasContent = Boolean(left.rawContent);
      const rightHasContent = Boolean(right.rawContent);

      if (preferContent && leftHasContent !== rightHasContent) {
        return leftHasContent ? -1 : 1;
      }

      return (right.score || 0) - (left.score || 0);
    });

    return normalized[0];
  }

  function findElementByCellReference(cellRef) {
    const coordinates = parseCellReference(cellRef);
    if (!coordinates) {
      return null;
    }

    const selectors = [
      `[aria-rowindex="${coordinates.row}"][aria-colindex="${coordinates.col}"]`,
      `[data-row="${coordinates.row}"][data-col="${coordinates.col}"]`,
      `[data-row-index="${coordinates.row}"][data-col-index="${coordinates.col}"]`,
      `[data-rowindex="${coordinates.row}"][data-colindex="${coordinates.col}"]`
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element instanceof HTMLElement && isVisible(element)) {
        return element;
      }
    }

    return null;
  }

  function parseCellReference(cellRef) {
    const match = String(cellRef || "").trim().match(/^([A-Z]{1,4})(\d{1,7})$/);
    if (!match) {
      return null;
    }

    const [, columnLabel, rowValue] = match;
    let column = 0;

    for (const character of columnLabel) {
      column = column * 26 + (character.charCodeAt(0) - 64);
    }

    return {
      row: Number.parseInt(rowValue, 10),
      col: column
    };
  }

  function findFocusedGridElement() {
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!activeElement) {
      return null;
    }

    return activeElement.closest?.(
      '[aria-rowindex][aria-colindex], [data-row][data-col], [data-row-index][data-col-index], [role="gridcell"], [role="cell"]'
    ) || null;
  }

  function isInsideSheetGrid(element) {
    return Boolean(
      element.closest?.(
        '[role="grid"], [role="table"], [aria-rowindex][aria-colindex], [data-row][data-col], [data-row-index][data-col-index], [role="gridcell"], [role="cell"]'
      )
    );
  }

  function isExcludedCaptureElement(element) {
    return Boolean(
      element.closest?.(
        [
          '[role="navigation"]',
          '[role="menu"]',
          '[aria-modal="true"]',
          '[class*="sidebar"]',
          '[class*="side-bar"]',
          '[class*="upload"]',
          '[class*="template"]',
          '[class*="monica"]',
          '[id*="monica"]',
          '[class*="codex"]',
          '[id*="codex"]'
        ].join(", ")
      )
    );
  }

  function findNameBoxRect(expectedCellRef) {
    const elements = collectElements(NAME_BOX_SELECTORS);

    for (const element of elements) {
      if (!(element instanceof HTMLElement) || !isVisible(element)) {
        continue;
      }

      const text = sanitizeInlineText(readElementText(element));
      if (text === expectedCellRef || text.match(CELL_REF_REGEX)?.[1] === expectedCellRef) {
        return element.getBoundingClientRect();
      }
    }

    return null;
  }

  function isAlignedWithNameBox(rect, nameBoxRect) {
    if (!nameBoxRect) {
      return false;
    }

    const verticalDistance = Math.abs(rect.top + rect.height / 2 - (nameBoxRect.top + nameBoxRect.height / 2));
    return rect.left >= nameBoxRect.right - 24 && verticalDistance <= 54;
  }

  function matchesAnySelector(element, selectors) {
    return selectors.some((selector) => element.matches(selector) || element.closest(selector));
  }

  function collectElements(selectors) {
    const elements = new Set();

    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((element) => {
        elements.add(element);
      });
    }

    return elements;
  }

  function hasVisibleElement(selectors) {
    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      for (const element of elements) {
        if (element instanceof HTMLElement && isVisible(element)) {
          return true;
        }
      }
    }

    return false;
  }

  function reportReady() {
    const context = buildPageContext();
    const pageSupport = detectPageSupport();
    safeSendRuntimeMessage("CONTENT_SCRIPT_READY", {
      ...context,
      pageKind: pageSupport.pageKind,
      pageSupported: pageSupport.pageSupported,
      supportReason: pageSupport.supportReason
    });
  }

  function reportCaptureStatus(status) {
    if (!status) {
      return;
    }

    const context = buildPageContext();
    const fingerprint = JSON.stringify([
      status.stage || "",
      status.message || "",
      status.error || "",
      status.pageKind || "",
      String(status.pageSupported ?? ""),
      status.supportReason || "",
      context.pageTitle || "",
      context.url || "",
      context.pageSessionKey || ""
    ]);

    if (window[LAST_SENT_STATUS_KEY] === fingerprint) {
      return;
    }

    window[LAST_SENT_STATUS_KEY] = fingerprint;
    safeSendRuntimeMessage("CAPTURE_STATUS", {
      ...context,
      ...status
    });
  }

  function safeSendRuntimeMessage(type, payload) {
    if (isShutDown) {
      return false;
    }

    if (!isExtensionContextAlive()) {
      teardown("extension-context-invalidated");
      return false;
    }

    try {
      chrome.runtime.sendMessage(
        {
          type,
          payload
        },
        () => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError?.message && /Extension context invalidated/i.test(runtimeError.message)) {
            teardown("extension-context-invalidated");
          }
        }
      );

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "");
      if (/Extension context invalidated/i.test(message)) {
        teardown("extension-context-invalidated");
      }
      return false;
    }
  }

  function isExtensionContextAlive() {
    try {
      return Boolean(globalThis.chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  function addManagedListener(target, eventName, handler, options) {
    target.addEventListener(eventName, handler, options);
    listenerDisposers.push(() => {
      target.removeEventListener(eventName, handler, options);
    });
  }

  function scheduleRouteCapture(delayMs) {
    if (isShutDown) {
      return;
    }

    if (delayMs <= 0) {
      scheduleCapture();
      return;
    }

    const timerId = window.setTimeout(() => {
      routeCaptureTimers.delete(timerId);
      scheduleCapture();
    }, delayMs);

    routeCaptureTimers.add(timerId);
  }

  function resetMessageFingerprints() {
    window[LAST_SENT_SNAPSHOT_KEY] = "";
    window[LAST_SENT_STATUS_KEY] = "";
  }

  function serializeHistoryState() {
    try {
      const serialized = JSON.stringify(history.state);
      if (serialized !== undefined) {
        return serialized;
      }
    } catch {
      return `[unserializable:${Object.prototype.toString.call(history.state)}]`;
    }

    return `[nonserializable:${typeof history.state}]`;
  }

  function buildNavigationFingerprint() {
    return JSON.stringify([
      window.location.href,
      document.title || "",
      serializeHistoryState()
    ]);
  }

  function beginNewPageSession(nextFingerprint) {
    currentNavigationFingerprint = nextFingerprint;
    currentRouteUrl = window.location.href;
    pageSessionVersion += 1;
    pageSessionKey = `session-${pageSessionVersion}`;
    resetMessageFingerprints();
  }

  function reconcilePageSession() {
    const nextFingerprint = buildNavigationFingerprint();
    if (nextFingerprint === currentNavigationFingerprint && pageSessionKey) {
      return false;
    }

    beginNewPageSession(nextFingerprint);
    return true;
  }

  function handleRouteChange() {
    if (isShutDown) {
      return;
    }

    if (!reconcilePageSession()) {
      return;
    }

    reportReady();
    scheduleRouteCapture(0);
    scheduleRouteCapture(250);
    scheduleRouteCapture(1000);
  }

  function installRouteChangeObservers() {
    originalPushState = typeof history.pushState === "function" ? history.pushState : null;
    originalReplaceState = typeof history.replaceState === "function" ? history.replaceState : null;

    if (originalPushState) {
      history.pushState = function patchedPushState(...args) {
        const result = originalPushState.apply(history, args);
        handleRouteChange();
        return result;
      };
    }

    if (originalReplaceState) {
      history.replaceState = function patchedReplaceState(...args) {
        const result = originalReplaceState.apply(history, args);
        handleRouteChange();
        return result;
      };
    }
  }

  function teardown() {
    if (isShutDown) {
      return;
    }

    isShutDown = true;
    window.clearTimeout(captureTimer);
    captureTimer = null;

    if (captureInterval) {
      window.clearInterval(captureInterval);
      captureInterval = null;
    }

    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }

    for (const timerId of routeCaptureTimers) {
      window.clearTimeout(timerId);
    }
    routeCaptureTimers.clear();

    if (originalPushState) {
      history.pushState = originalPushState;
      originalPushState = null;
    }

    if (originalReplaceState) {
      history.replaceState = originalReplaceState;
      originalReplaceState = null;
    }

    while (listenerDisposers.length) {
      const dispose = listenerDisposers.pop();
      dispose?.();
    }
  }

  function buildPageContext() {
    return {
      pageTitle: sanitizeInlineText(document.title.replace(/\s*-\s*飞书.*/, "")),
      url: window.location.href,
      pageSessionKey
    };
  }

  function buildHitMessage(sourceParts, cellRef, rawContent) {
    const labels = uniqueMessages(sourceParts.map(translateSource));
    const label = labels.length ? labels.join(" + ") : "当前单元格";

    if (cellRef && rawContent) {
      return `已命中 ${label}，同步 ${cellRef} 的单元格内容。`;
    }

    if (cellRef && sourceParts.includes("empty-cell")) {
      return `已命中 ${cellRef} 空单元格。`;
    }

    if (cellRef) {
      return `已命中 ${label}，同步 ${cellRef} 的坐标信息。`;
    }

    return `已命中 ${label}，同步当前单元格内容。`;
  }

  function translateSource(source) {
    switch (source) {
      case "name-box":
        return "名称框";
      case "formula-bar":
        return "公式栏";
      case "editor":
        return "编辑态输入框";
      case "exact-cell":
        return "精确坐标单元格";
      case "selected-cell":
        return "活动单元格";
      case "focused-cell":
        return "聚焦单元格";
      case "cell-ref":
        return "单元格坐标";
      case "empty-cell":
        return "空单元格";
      default:
        return source || "页面推断";
    }
  }

  function uniqueMessages(values) {
    return Array.from(new Set(values.filter(Boolean)));
  }

  function deriveCellReference(element) {
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    const directMatch = inspectAttributesForCellReference(element);
    if (directMatch) {
      return directMatch;
    }

    const row =
      readNumericAttribute(element, [
        "data-row",
        "data-row-index",
        "data-rowindex",
        "aria-rowindex"
      ]) || null;
    const col =
      readNumericAttribute(element, [
        "data-col",
        "data-col-index",
        "data-colindex",
        "aria-colindex"
      ]) || null;

    if (row && col) {
      return `${columnNumberToName(col)}${row}`;
    }

    const parentWithCoords = element.closest?.(
      '[data-row][data-col], [data-row-index][data-col-index], [aria-rowindex][aria-colindex]'
    );

    if (parentWithCoords instanceof HTMLElement && parentWithCoords !== element) {
      return deriveCellReference(parentWithCoords);
    }

    return null;
  }

  function inspectAttributesForCellReference(element) {
    const values = [];

    for (const attributeName of element.getAttributeNames()) {
      values.push(element.getAttribute(attributeName) || "");
    }

    values.push(element.id || "");
    values.push(element.className || "");

    for (const value of values) {
      const match = String(value).match(CELL_REF_REGEX);
      if (match) {
        return match[1];
      }
    }

    return null;
  }

  function readNumericAttribute(element, attributeNames) {
    for (const attributeName of attributeNames) {
      const rawValue = element.getAttribute(attributeName);
      if (!rawValue) {
        continue;
      }

      const parsed = Number.parseInt(rawValue, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }

    return null;
  }

  function columnNumberToName(value) {
    let column = value;
    let label = "";

    while (column > 0) {
      const remainder = (column - 1) % 26;
      label = String.fromCharCode(65 + remainder) + label;
      column = Math.floor((column - 1) / 26);
    }

    return label || "";
  }

  function readElementText(element) {
    if (!(element instanceof HTMLElement)) {
      return "";
    }

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return sanitizeMultilineText(element.value);
    }

    return sanitizeMultilineText(element.innerText || element.textContent || "");
  }

  function sanitizeMultilineText(value) {
    return String(value || "")
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
      .replace(/\r\n?/g, "\n")
      .trim();
  }

  function sanitizeInlineText(value) {
    return String(value || "")
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return false;
    }

    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function isLikelyTopBarElement(rect) {
    return rect.bottom > 0 && rect.top < TOP_BAR_SCAN_MAX_TOP;
  }

  function start() {
    if (runtimeStarted || isShutDown || window.__sheetMateContentScriptLoaded__) {
      return;
    }

    runtimeStarted = true;
    window.__sheetMateContentScriptLoaded__ = true;

    reconcilePageSession();
    reportReady();
    installRouteChangeObservers();

    const passiveEvents = [
      "click",
      "dblclick",
      "mouseup",
      "keyup",
      "keydown",
      "focusin",
      "input",
      "change",
      "paste"
    ];

    for (const eventName of passiveEvents) {
      addManagedListener(document, eventName, scheduleCapture, true);
    }

    addManagedListener(document, "selectionchange", scheduleCapture, true);
    addManagedListener(window, "hashchange", handleRouteChange, true);
    addManagedListener(window, "popstate", handleRouteChange, true);

    mutationObserver = new MutationObserver(() => {
      scheduleCapture();
    });

    mutationObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true
    });

    captureInterval = window.setInterval(scheduleCapture, POLL_INTERVAL_MS);
    scheduleCapture();
  }

  const runtime = {
    buildGridCandidate,
    buildHitMessage,
    buildPageContext,
    captureAndSendSnapshot,
    chooseBestCandidate,
    columnNumberToName,
    detectPageSupport,
    deriveCellReference,
    findEditorCandidate,
    findFocusedGridElement,
    findFormulaBarCandidate,
    findNameBoxCandidate,
    findSelectedCellCandidate,
    parseCellReference,
    reconcilePageSession,
    readCellSnapshot,
    reportCaptureStatus,
    reportReady,
    handleRouteChange,
    scheduleCapture,
    start,
    teardown,
    translateSource
  };

  if (!skipAutoStart) {
    start();
  }

  return runtime;
}

function bootstrapSheetMate() {
  return createSheetMateContentScriptRuntime();
}

function exposeContentScriptTestExports() {
  if (!SHEET_MATE_TEST_MODE) {
    return;
  }

  const root = globalThis.__sheetMateTestExports || (globalThis.__sheetMateTestExports = {});
  root.contentScript = {
    bootstrapSheetMate,
    createSheetMateContentScriptRuntime
  };
}

exposeContentScriptTestExports();

if (!SHEET_MATE_TEST_MODE) {
  bootstrapSheetMate();
}
