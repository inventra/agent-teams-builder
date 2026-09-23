(() => {
  "use strict";

  const SENTINEL = "__vixoAgentsInjection__";
  const OWNED = "data-vixo-agents-owned";
  const HIDDEN = "data-vixo-agents-native-hidden";
  const HOST = "data-vixo-agents-page-host";
  const ENTRY_ID = "vixo-agents-sidebar-entry";
  const TASKBOARD_ENTRY_ID = "codex-taskboard-entry";
  const PAGE_ID = "vixo-agents-codex-page";
  const FRAME_ID = "vixo-agents-codex-frame";
  const STYLE_ID = "vixo-agents-codex-style";
  const PLUGIN_LABELS = ["plugins", "插件", "外掛程式", "プラグイン"];
  const SEND_LABELS = ["send", "submit", "傳送", "送出", "發送"];
  const configuredUrl = String(window.__VIXO_AGENTS_DASHBOARD_URL__ || "").trim();
  const sourceHash = String(window.__VIXO_AGENTS_SOURCE_HASH__ || "development");

  function safeDashboardUrl(value) {
    try {
      const url = new URL(value);
      const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
      if (!loopback || (url.protocol !== "http:" && url.protocol !== "https:")) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  const dashboardUrl = safeDashboardUrl(configuredUrl);
  if (!dashboardUrl) throw new Error("VIXO Agents requires a loopback Dashboard URL");

  const previous = window[SENTINEL];
  if (previous?.sourceHash === sourceHash && previous?.dashboardUrl === dashboardUrl) {
    previous.refresh?.();
    return;
  }
  try { previous?.destroy?.(); } catch {}

  let entry = null;
  let page = null;
  let frame = null;
  let observer = null;
  let refreshTimer = null;
  let active = false;
  let loaded = false;
  let frameName = "";

  const normalized = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.setAttribute(OWNED, "true");
    style.textContent = `
      #${ENTRY_ID}[aria-current="page"] {
        background: var(--color-token-list-hover-background, color-mix(in srgb, currentColor 8%, transparent));
        color: var(--color-token-foreground, inherit);
      }
      #${ENTRY_ID}:focus-visible {
        outline: 2px solid var(--color-token-border, Highlight);
        outline-offset: 2px;
      }
      [${HOST}="true"] {
        position: relative !important;
        z-index: 31 !important;
        pointer-events: none !important;
      }
      [${HIDDEN}="true"] {
        visibility: hidden !important;
        pointer-events: none !important;
      }
      #${PAGE_ID} {
        position: absolute;
        inset: 0;
        z-index: 2;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        background: Canvas;
        color: CanvasText;
        pointer-events: auto;
      }
      #${PAGE_ID}[hidden] { display: none !important; }
      #${FRAME_ID} {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
        background: Canvas;
      }
      #${PAGE_ID} .vixo-agents-loading {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        padding: 24px;
        color: var(--color-token-text-secondary, color-mix(in srgb, CanvasText 60%, transparent));
        font: 13px/1.5 system-ui, sans-serif;
        text-align: center;
        pointer-events: none;
      }
      #${PAGE_ID}[data-loaded="true"] .vixo-agents-loading { display: none; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function findReferenceButton() {
    const scroll = document.querySelector("[data-app-action-sidebar-scroll]");
    if (!scroll) return null;
    // Dashi Taskboard also keeps its entry immediately after Plugins. Using
    // that entry as our preferred anchor establishes one stable order instead
    // of letting both MutationObservers move their buttons after Plugins.
    const taskboard = scroll.querySelector(`#${TASKBOARD_ENTRY_ID}`);
    if (taskboard?.parentElement) return taskboard;
    const buttons = Array.from(scroll.querySelectorAll("button"))
      .filter((button) => button.getAttribute(OWNED) !== "true");
    const plugin = buttons.find((button) => PLUGIN_LABELS.includes(normalized(
      button.textContent || button.getAttribute("aria-label"),
    )));
    if (plugin) return plugin;
    const firstSection = scroll.querySelector("[data-app-action-sidebar-section]");
    if (!firstSection) return buttons.at(-1) || null;
    const sectionTop = firstSection.getBoundingClientRect().top;
    return buttons.filter((button) => {
      const rect = button.getBoundingClientRect();
      return rect.height > 0 && rect.bottom <= sectionTop;
    }).at(-1) || null;
  }

  function setEntryText(button) {
    button.setAttribute("aria-label", "開啟 VIXO Agents");
    button.setAttribute("title", "VIXO Agents");
    const label = button.querySelector(".text-fade-truncate")
      || Array.from(button.querySelectorAll("span")).find((node) => PLUGIN_LABELS.includes(normalized(node.textContent)));
    if (label) label.textContent = "VIXO Agents";
    else button.textContent = "VIXO Agents";
  }

  function setEntryIcon(button) {
    const icon = button.querySelector("svg");
    if (!icon) return;
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.8");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    icon.innerHTML = '<circle cx="8" cy="8" r="3"></circle><circle cx="16" cy="8" r="3"></circle><path d="M3.5 19c.4-3 2-5 4.5-5s4.1 2 4.5 5M11.5 19c.4-3 2-5 4.5-5s4.1 2 4.5 5"></path>';
  }

  function createEntry(reference) {
    const button = reference.cloneNode(true);
    button.id = ENTRY_ID;
    button.type = "button";
    button.removeAttribute("disabled");
    button.removeAttribute("aria-expanded");
    button.removeAttribute("aria-controls");
    button.removeAttribute("aria-describedby");
    button.removeAttribute("data-state");
    button.setAttribute(OWNED, "true");
    button.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
    setEntryText(button);
    setEntryIcon(button);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      open();
    });
    return button;
  }

  function ensureEntry() {
    installStyles();
    const reference = findReferenceButton();
    if (!reference?.parentElement) return false;
    if (!entry) entry = createEntry(reference);
    if (entry.parentElement !== reference.parentElement || entry.previousElementSibling !== reference) {
      reference.after(entry);
    }
    entry.toggleAttribute("aria-current", active);
    if (active) entry.setAttribute("aria-current", "page");
    return true;
  }

  function findPageMount() {
    const frameHost = document.querySelector(".app-shell-main-content-frame");
    const viewport = frameHost?.closest?.("[data-app-shell-main-content-layout]")
      || document.querySelector("[data-app-shell-main-content-layout]");
    const surface = viewport?.parentElement;
    if (!viewport || !surface || !surface.closest("main")) return null;
    return surface;
  }

  function createPage() {
    const container = document.createElement("section");
    container.id = PAGE_ID;
    container.hidden = true;
    container.setAttribute(OWNED, "true");
    container.setAttribute("aria-label", "VIXO Agents");
    const loading = document.createElement("div");
    loading.className = "vixo-agents-loading";
    loading.textContent = "正在載入 VIXO Agents…";
    const nextFrame = document.createElement("iframe");
    nextFrame.id = FRAME_ID;
    frameName = `vixo-agents-${crypto.randomUUID()}`;
    nextFrame.name = frameName;
    nextFrame.title = "VIXO Agents";
    nextFrame.referrerPolicy = "no-referrer";
    nextFrame.setAttribute("allow", "clipboard-read; clipboard-write");
    nextFrame.setAttribute("sandbox", "allow-scripts allow-forms allow-modals allow-downloads");
    nextFrame.src = "about:blank";
    container.append(loading, nextFrame);
    frame = nextFrame;
    return container;
  }

  function restoreNative() {
    document.querySelectorAll(`[${HIDDEN}="true"]`).forEach((node) => node.removeAttribute(HIDDEN));
    document.querySelectorAll(`[${HOST}="true"]`).forEach((node) => node.removeAttribute(HOST));
  }

  function mountPage() {
    if (!active) return false;
    const surface = findPageMount();
    if (!surface) return false;
    if (!page) page = createPage();
    if (page.parentElement !== surface) surface.appendChild(page);
    surface.setAttribute(HOST, "true");
    Array.from(surface.children).forEach((child) => {
      if (child !== page && child.getAttribute(OWNED) !== "true") child.setAttribute(HIDDEN, "true");
    });
    document.querySelectorAll('[data-testid="app-shell-header-context-menu-surface"] > *')
      .forEach((child) => {
        if (child.getAttribute(OWNED) !== "true") child.setAttribute(HIDDEN, "true");
      });
    page.hidden = false;
    return true;
  }

  function close() {
    active = false;
    if (page) page.hidden = true;
    restoreNative();
    entry?.removeAttribute("aria-current");
  }

  function open() {
    try { window.__codexTaskboardInjection__?.close?.(false); } catch {}
    active = true;
    ensureEntry();
    mountPage();
    entry?.setAttribute("aria-current", "page");
  }

  function refresh() {
    ensureEntry();
    if (active) mountPage();
  }

  function scheduleRefresh() {
    if (refreshTimer !== null) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      refresh();
    }, 100);
  }

  function requestNativeFetch(path, body) {
    const bridge = window.electronBridge;
    if (!bridge || typeof bridge.sendMessageFromView !== "function") return Promise.resolve(null);
    return new Promise((resolve) => {
      const requestId = `vixo-native-fetch-${crypto.randomUUID()}`;
      let settled = false;
      const finish = (value = null) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        resolve(value);
      };
      const onMessage = (event) => {
        const message = event.data;
        if (!message || message.type !== "fetch-response" || message.requestId !== requestId) return;
        try { finish(JSON.parse(message.bodyJsonString || "null")); }
        catch { finish(); }
      };
      const timeout = window.setTimeout(finish, 1500);
      window.addEventListener("message", onMessage);
      try {
        bridge.sendMessageFromView({
          type: "fetch",
          requestId,
          method: "POST",
          url: `vscode://codex/${path}`,
          body: JSON.stringify(body),
        });
      } catch { finish(); }
    });
  }

  function normalizeNativeRootPath(value) {
    const input = String(value || "").trim();
    if (!input) return "";
    const windowsPath = /^[A-Za-z]:[\\/]/.test(input) || input.includes("\\");
    const normalizedSlashes = windowsPath ? input.replace(/\\/g, "/") : input;
    const withoutTrailingSlash = normalizedSlashes.replace(/\/+$/, "")
      || (normalizedSlashes.startsWith("/") ? "/" : normalizedSlashes);
    if (!windowsPath || !/^[A-Za-z]:/.test(withoutTrailingSlash)) return withoutTrailingSlash;
    return `${withoutTrailingSlash[0].toLowerCase()}${withoutTrailingSlash.slice(1)}`;
  }

  async function nativeProjects() {
    const bootstrap = await window.electronBridge?.getInitialSidebarBootstrap?.();
    const entries = new Map((bootstrap?.globalStateEntries || []).map((item) => [item?.key, item?.value]));
    const projects = entries.get("local-projects") || {};
    return Object.entries(projects).flatMap(([id, project]) => {
      const workspacePath = Array.isArray(project?.rootPaths)
        ? project.rootPaths.find((root) => typeof root === "string" && root.trim())
        : null;
      if (!id || !workspacePath) return [];
      return [{ id, workspacePath }];
    });
  }

  async function selectedNativeProjectId() {
    const selected = (await requestNativeFetch("get-global-state", { key: "selected-project" }))?.value;
    return typeof selected?.projectId === "string" ? selected.projectId : "";
  }

  async function activeNativeWorkspaceRoots() {
    const roots = (await requestNativeFetch("active-workspace-roots", {}))?.roots;
    return Array.isArray(roots) ? roots.filter((root) => typeof root === "string") : [];
  }

  async function switchToNativeProject(projectId, workspacePath) {
    const bridge = window.electronBridge;
    const projects = await nativeProjects();
    const normalizedWorkspace = normalizeNativeRootPath(workspacePath);
    const project = projects.find((candidate) => (
      candidate.id === projectId
      && normalizeNativeRootPath(candidate.workspacePath) === normalizedWorkspace
    ));
    if (!project) throw new Error("Codex 中找不到指定的專案或專案路徑已改變");
    const projectRow = Array.from(document.querySelectorAll("[data-app-action-sidebar-project-row]"))
      .find((candidate) => candidate.getAttribute("data-app-action-sidebar-project-id") === project.id);
    if (projectRow) (projectRow.querySelector("[data-app-action-sidebar-select-project]") || projectRow).click();
    else bridge.sendMessageFromView({ type: "electron-add-new-workspace-root-option", root: project.workspacePath });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const selectedId = await selectedNativeProjectId();
      if (selectedId === project.id) return;
      const roots = await activeNativeWorkspaceRoots();
      if (normalizeNativeRootPath(roots[0]) === normalizedWorkspace) return;
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    throw new Error("Codex 未能切換到指定專案");
  }

  function dispatchHostMessage(message) {
    window.postMessage(message, window.location.origin);
  }

  function threadRows() {
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]"));
  }

  function normalizedThreadId(value) {
    const threadId = String(value || "").trim();
    if (threadId.includes("client-new-thread")) return "";
    return threadId.startsWith("local:") ? threadId.slice("local:".length) : threadId;
  }

  async function knownNativeThreadIds() {
    const memberships = (await requestNativeFetch("get-global-state", { key: "thread-project-membership-host-ids" }))?.value;
    return new Set([
      ...threadRows().map((row) => normalizedThreadId(row.getAttribute("data-app-action-sidebar-thread-id"))),
      ...Object.keys(memberships && typeof memberships === "object" ? memberships : {}),
    ].filter(Boolean));
  }

  async function nativeThreadProjectId(threadId) {
    const assignments = (await requestNativeFetch("get-global-state", { key: "thread-project-assignments" }))?.value;
    const assignment = assignments && typeof assignments === "object" ? assignments[threadId] : null;
    return assignment?.projectKind === "local" && typeof assignment.projectId === "string"
      ? assignment.projectId
      : "";
  }

  function activeThreadId(excluded = new Set()) {
    const rows = threadRows();
    const activeRow = rows.find((row) => row.getAttribute("data-app-action-sidebar-thread-active") === "true")
      || rows.find((row) => ["page", "true"].includes(row.getAttribute("aria-current")))
      || rows.find((row) => !excluded.has(row.getAttribute("data-app-action-sidebar-thread-id")));
    return normalizedThreadId(activeRow?.getAttribute("data-app-action-sidebar-thread-id"));
  }

  async function submitPrefilledComposer(instruction) {
    const deadline = Date.now() + 10_000;
    let textbox = null;
    while (Date.now() < deadline) {
      textbox = Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"]'))
        .find((candidate) => !candidate.closest(`#${PAGE_ID}`));
      const text = String(textbox?.innerText || textbox?.textContent || "").trim();
      if (textbox && text && (text.includes(instruction.slice(0, 36)) || instruction.includes(text.slice(0, 36)))) break;
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    if (!textbox) throw new Error("Codex 新任務輸入框沒有出現");
    textbox.focus();
    const submit = Array.from(document.querySelectorAll("button"))
      .find((button) => {
        if (button.disabled || button.closest(`#${PAGE_ID}`)) return false;
        const label = normalized(button.getAttribute("aria-label") || button.getAttribute("title") || button.textContent);
        return button.type === "submit" || SEND_LABELS.some((candidate) => label === candidate || label.includes(candidate));
      });
    if (submit) submit.click();
    else {
      for (const type of ["keydown", "keypress", "keyup"]) {
        textbox.dispatchEvent(new KeyboardEvent(type, {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        }));
      }
    }
  }

  async function createNativeThread(payload) {
    const runId = String(payload?.runId || "").trim();
    const projectId = String(payload?.projectId || "").trim();
    const workspacePath = String(payload?.workspacePath || "").trim();
    const instruction = String(payload?.instruction || "").trim();
    if (!runId || !projectId || !workspacePath || !instruction) throw new Error("建立 Codex 任務所需資料不完整");
    const bridge = window.electronBridge;
    if (!bridge || typeof bridge.sendMessageFromView !== "function") throw new Error("目前 Codex 版本沒有提供桌面任務建立能力");
    const previousThreadIds = await knownNativeThreadIds();
    await switchToNativeProject(projectId, workspacePath);
    close();
    dispatchHostMessage({
      type: "navigate-to-route",
      path: "/",
      state: {
        focusComposerNonce: crypto.randomUUID(),
        prefillPrompt: instruction,
        project: { type: "local", projectId },
      },
    });
    await submitPrefilledComposer(instruction);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const currentThreadIds = await knownNativeThreadIds();
      const threadId = [...currentThreadIds].find((candidate) => !previousThreadIds.has(candidate))
        || activeThreadId(previousThreadIds);
      if (
        threadId
        && !previousThreadIds.has(threadId)
        && await nativeThreadProjectId(threadId) === projectId
      ) return { runId, threadId, projectId };
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    throw new Error("Codex 已送出任務，但無法確認 Session 已綁定到指定專案");
  }

  function openNativeThread(threadId) {
    const normalizedThreadId = String(threadId || "").trim();
    if (!normalizedThreadId) return;
    close();
    const row = threadRows().find((candidate) => candidate.getAttribute("data-app-action-sidebar-thread-id") === normalizedThreadId);
    if (row?.isConnected) row.click();
    else dispatchHostMessage({ type: "navigate-to-route", path: `/local/${encodeURIComponent(normalizedThreadId)}` });
  }

  function onDocumentClick(event) {
    if (!active) return;
    const clickable = event.target?.closest?.("button,a,[role='button'],[data-app-action-sidebar-thread-id]");
    if (!clickable || clickable === entry || clickable.closest?.(`#${ENTRY_ID}`)) return;
    if (clickable.closest?.("aside nav[role='navigation']")) close();
  }

  function onFrameMessage(event) {
    if (!frame || event.source !== frame.contentWindow) return;
    if (event.data?.type === "vixo-agents:ready") {
      loaded = true;
      page.dataset.loaded = "true";
      return;
    }
    if (event.data?.type === "vixo-agents:create-codex-thread") {
      void createNativeThread(event.data.payload).then((payload) => {
        frame?.contentWindow?.postMessage({ type: "vixo-agents:thread-created", payload }, "*");
      }, (error) => {
        open();
        frame?.contentWindow?.postMessage({
          type: "vixo-agents:thread-create-error",
          payload: { runId: event.data.payload?.runId, error: error instanceof Error ? error.message : String(error) },
        }, "*");
      });
      return;
    }
    if (event.data?.type === "vixo-agents:open-codex-thread") openNativeThread(event.data.threadId);
  }

  function destroy() {
    close();
    observer?.disconnect();
    observer = null;
    if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    document.removeEventListener("click", onDocumentClick, true);
    window.removeEventListener("message", onFrameMessage);
    document.querySelectorAll(`[${OWNED}="true"]`).forEach((node) => node.remove());
    if (window[SENTINEL] === api) delete window[SENTINEL];
  }

  function status() {
    return {
      sourceHash,
      dashboardOrigin: new URL(dashboardUrl).origin,
      entryMounted: Boolean(entry?.isConnected),
      pageVisible: Boolean(active && page && !page.hidden),
      frameLoaded: loaded,
      frameName,
    };
  }

  const api = { sourceHash, dashboardUrl, open, close, refresh, destroy, status, createNativeThread, openNativeThread };
  window[SENTINEL] = api;
  document.addEventListener("click", onDocumentClick, true);
  window.addEventListener("message", onFrameMessage);
  observer = new MutationObserver(scheduleRefresh);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  refresh();
})();
