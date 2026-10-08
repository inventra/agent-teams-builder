import { CARD_LIBRARY, STATUS_LABELS, defaultPreferences, normalizePreferences, officePositions, searchWorkbench } from "./workbench-model.js";
import { officeBackground } from "./office-background.js";
import { icon } from "./icons.js";

export function createWorkbench({ api, esc, toast, play, schedule, openThread, onNavigate }) {
  const root = document.querySelector("#workbench");
  let state = null, data = null, preferences = defaultPreferences(), capabilities = null;
  let initialized = false, active = false, view = "home", dragId = null, resizing = null, officeFloor = 0;
  let saveQueue = Promise.resolve(), refreshing = false, preferenceRevision = 0, generation = 0;
  const $ = (selector) => root.querySelector(selector);
  const actionIcons = Object.freeze({ theme: "theme", refresh: "refresh", "close-detail": "close", "close-layout": "close",
    favorite: "star", play: "play", schedule: "calendar", "schedule-delete": "trash", layout: "plus",
    "card-settings": "settings", "card-up": "up", "card-down": "down", "card-remove": "trash", "card-add": "plus",
    thread: "thread", reply: "reply", approve: "check", reject: "close", module: "docs", view: "thread" });
  const button = (action, label, attrs = "", css = "") =>
    '<button type="button" class="wb-btn ' + css + '" data-wb="' + action + '" ' + attrs + ">" +
    (actionIcons[action] ? icon(actionIcons[action]) : "") + label + "</button>";
  const badge = (label, css = "") => '<span class="wb-badge ' + css + '">' + esc(label) + "</span>";
  const unavailable = (title, text = "尚未串接正式資料來源") =>
    '<div class="wb-unavailable">' + badge("未串接", "muted") + "<strong>" + esc(title) + "</strong><p>" + esc(text) + "</p></div>";
  const empty = (text) => '<div class="wb-empty">' + esc(text) + "</div>";
  const attrs = (agentId, workflowId) => 'data-agent="' + esc(agentId) + '" data-workflow="' + esc(workflowId) + '"';
  const periodName = () => ({ today: "今天", week: "本週", month: "本月" })[preferences.period];
  const timestamp = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "時間未知" : date.toLocaleString("zh-TW", { hour12: false });
  };
  const allKnownRuns = () => [...new Map([...(data?.runs || []), ...(data?.approvals || []), ...(data?.alerts || []),
    ...(state?.runs || [])].map((run) => [run.id, run])).values()];
  const workflowRows = (agents, favoritesOnly = false) => {
    let rows = agents.flatMap((agent) => (agent.workflows || []).map((workflow) => ({ agent, workflow })));
    if (favoritesOnly && preferences.favorites.length) rows = rows.filter(({ agent, workflow }) =>
      preferences.favorites.includes(agent.id + "/" + workflow.id));
    return rows.map(({ agent, workflow }) => '<div class="wb-row"><div class="wb-row-main">' +
      button("agent", esc(agent.displayName) + " · " + esc(workflow.name), 'data-id="' + esc(agent.id) + '"', "link") +
      "<small>" + esc(workflow.description) + '</small></div><div class="wb-actions">' +
      button("favorite", "", attrs(agent.id, workflow.id) + ' aria-label="釘選 ' + esc(workflow.name) +
        '" aria-pressed="' + preferences.favorites.includes(agent.id + "/" + workflow.id) + '"',
        preferences.favorites.includes(agent.id + "/" + workflow.id) ? "is-favorite" : "") +
      button("play", "執行", attrs(agent.id, workflow.id), "primary") + "</div></div>").join("") ||
      empty("尚無 Workflow；建立或修改員工須先預覽與 Double Check。");
  };
  const runRows = (runs, limit = 8) => runs.slice(0, limit).map((run) =>
    '<div class="wb-row"><div class="wb-row-main">' + button("run", esc(run.agentName || run.agentId) + " · " +
      esc(run.workflowName || run.workflowId), 'data-id="' + esc(run.id) + '"', "link") +
      "<small>" + esc(timestamp(run.startedAt)) + (run.pendingNodeName ? " · " + esc(run.pendingNodeName) : "") +
      "</small></div>" + badge(STATUS_LABELS[run.status] || run.status, run.status) + "</div>").join("") || empty("此期間尚無執行紀錄");

  root.innerHTML = '<div class="wb-toolbar"><div class="wb-crumb">VIXO <span>／</span> Docs <span>／</span> <b id="wb-crumb-current">首頁總覽</b></div>' +
    '<label class="wb-search-label">' + icon("search") + '<span class="wb-sr-only">搜尋 Agent、Skill、Workflow 或執行紀錄</span><input id="wb-search" type="search" placeholder="搜尋 Agent、Skill、Workflow、執行紀錄…" autocomplete="off"></label>' +
    button("theme", "", 'aria-label="切換明暗主題"') + button("refresh", "", 'aria-label="重新整理"') + "</div>" +
    '<div class="wb-dimbar"><div class="wb-segment" id="wb-period">' +
    ["today", "week", "month"].map((period) => button("period", ({ today: "今天", week: "本週", month: "本月" })[period],
      'data-id="' + period + '"')).join("") + '</div><span class="wb-scope">VIXO 獨立工作區 · 目前登入帳號</span>' +
    '<span id="wb-sync" role="status"></span></div><div id="wb-error" role="alert" hidden></div><div id="wb-stage"></div>' +
    '<dialog id="wb-detail" class="wb-dialog"><div class="wb-dialog-heading"><b id="wb-detail-title"></b>' +
    button("close-detail", "", 'aria-label="關閉詳情"') + '</div><div id="wb-detail-body"></div></dialog>' +
    '<dialog id="wb-layout" class="wb-dialog"><div class="wb-dialog-heading"><b class="wb-icon-heading">' + icon("skins") + '首頁卡片配置</b>' +
    button("close-layout", "", 'aria-label="關閉卡片配置"') + '</div><div id="wb-layout-body"></div></dialog>';

  function syncTheme() {
    document.body.classList.toggle("docs-mode", active);
    document.documentElement.dataset.wbTheme = active ? preferences.theme : "light";
    $("#wb-period").querySelectorAll("button").forEach((node) => node.classList.toggle("on", node.dataset.id === preferences.period));
    onNavigate?.();
  }
  function savePreferences() {
    const stamp = generation;
    preferenceRevision++;
    const snapshot = JSON.parse(JSON.stringify(preferences));
    $("#wb-sync").textContent = "正在儲存設定…";
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      if (stamp !== generation || !active) return;
      await api("/api/preferences/workbench", { method: "POST", body: JSON.stringify(snapshot) });
      if (stamp !== generation || !active) return;
      $("#wb-sync").textContent = "設定已儲存";
    }).catch((error) => { if (stamp !== generation || error.code === "stale_operation") return; $("#wb-sync").textContent = "設定未儲存"; toast("設定儲存失敗：" + error.message); });
    return saveQueue;
  }
  function cardBody(id) {
    if (id === "today") return '<div class="wb-mini-metrics">' +
      ["Outlook 會議", "個人待辦", "需回覆信件"].map((name) => '<div><span>' + name + "</span><b>未串接</b></div>").join("") +
      "</div><h4>" + periodName() + " AI 工作</h4>" + runRows(data.runs, 4);
    if (id === "agents") return workflowRows(state.agents, true);
    if (id === "approvals") return runRows(data.approvals, 6) +
      '<p class="wb-note">待辦跨期間保留。原生 Codex 任務請在對應任務中確認。</p>';
    if (id === "alerts") return runRows(data.alerts.filter((run) => data.runs.some((item) => item.id === run.id) ||
      ["waiting-input", "waiting-approval"].includes(run.status)), 6) + '<p class="wb-note">只顯示已知失敗與等待，不推算卡住時數。</p>';
    if (id === "calendar") return (state.schedules || []).map((item) =>
      '<div class="wb-row"><div class="wb-row-main"><strong>' + esc(item.time) + " · " + esc(item.workflowName) +
      "</strong><small>每日 · " + esc(item.timezone) + " · " + esc(item.host) + "</small></div>" +
      badge(item.enabled ? "已啟用" : "已停用", item.enabled ? "completed" : "muted") +
      button("schedule-delete", "移除", 'data-id="' + esc(item.id) + '" aria-label="移除 ' + esc(item.workflowName) + ' 排程"') +
      "</div>").join("") + (!state.schedules.length ? empty("尚未設定每日排程，可從員工詳情新增") : "") +
      unavailable("Outlook 行事曆", "外部會議及週排程尚未接通");
    if (id === "projects") return '<h4>Codex 執行工作區</h4>' + (state.codexProjects || []).slice(0, 4).map((project) =>
      '<div class="wb-row"><strong>' + esc(project.name) + "</strong>" + badge(project.selected ? "目前工作區" : "可選工作區", "muted") + "</div>"
    ).join("") + (!(state.codexProjects || []).length ? empty("尚無可選 Codex 專案") : "") +
      unavailable("Planner 業務專案", "Codex 工作區不是業務專案；不顯示虛構完成率");
    if (id === "recent") return runRows(data.runs, 6) + '<p class="wb-note">執行摘要與任務連結；SharePoint 最近檔案未串接。</p>';
    if (id === "revenue") return '<div class="wb-result-number">' + data.summary.completedRuns + '<small>' + periodName() +
      '已完成的背景工作</small></div><div class="wb-mini-metrics"><div><span>節省工時</span><b>尚無資料</b></div>' +
      '<div><span>AI 費用</span><b>尚無資料</b></div></div>' + unavailable("營收與 KPI", "尚未設定正式資料、目標與公式");
    const sources = { health: "ERP／BI／KPI", meetings: "Teams 逐字稿", bi: "ERP 與鼎新 BI",
      onepage: "企業營運資料", brands: "品牌及營運資料", staffprj: "組織、Planner 及分工資料" };
    return unavailable(sources[id] || CARD_LIBRARY[id].description);
  }
  function home() {
    const summary = data.summary;
    return '<div class="wb-heading"><div><h2>把工作放在同一個畫面。</h2><p>' + periodName() +
      "的 Agent 工作、等待確認與執行成果。沒有串接的資訊，清楚留白。</p></div>" +
      button("layout", "自訂首頁") + '</div><section class="wb-core wb-glass"><div><span class="wb-eyebrow">VIXO CORE</span>' +
      "<h3>你的 AI 工作核心</h3><p>" + summary.completedRuns + " 件已完成 · " + summary.pendingApprovals +
      ' 件等待你確認或補充</p></div><div class="wb-core-orb" aria-hidden="true">V</div><div class="wb-core-metrics">' +
      [[summary.agents, "Agent"], [summary.skills, "Skills"], [summary.workflows, "Workflows"],
        [summary.enabledSchedules, "啟用排程"], [summary.totalRuns, periodName() + "執行"]]
        .map(([number, label]) => "<div><b>" + number + "</b><span>" + label + "</span></div>").join("") +
      '</div></section><div class="wb-grid">' + preferences.cards.map((card) => {
        const model = CARD_LIBRARY[card.id];
        return '<article class="wb-card wb-glass wb-tint-' + card.tint + '" data-card="' + card.id +
          '" style="--wb-width:' + card.width + ";--wb-height:" + card.height + '"><div class="wb-card-head">' +
          '<button type="button" class="wb-drag" draggable="true" data-card="' + card.id +
          '" aria-label="拖曳排序 ' + model.name + '">' + icon("grip") + '</button><span class="wb-card-icon">' + icon(model.icon) + "</span><h3>" +
          model.name + "</h3>" + button("card-settings", "", 'data-id="' + card.id + '" aria-label="設定 ' + model.name + '"') +
          '</div><div class="wb-card-body">' + cardBody(card.id) + '</div><button type="button" class="wb-resize" data-resize="' +
          card.id + '" aria-label="拖曳縮放 ' + model.name + '">' + icon("resize") + '</button></article>';
      }).join("") + (preferences.cards.length ? "" : empty("尚未放置卡片，點「自訂首頁」加入。")) + "</div>";
  }
  function office() {
    const positions = officePositions(state.agents, preferences.officeSeats);
    const seats = Object.fromEntries(positions.map((position) => [position.agentId, position.slot]));
    if (JSON.stringify(seats) !== JSON.stringify(preferences.officeSeats)) { preferences.officeSeats = seats; savePreferences(); }
    const floors = Math.max(1, ...positions.map((position) => position.floor + 1));
    officeFloor = Math.min(officeFloor, floors - 1);
    return '<div class="wb-heading"><div><h2>VIXO 像素辦公室</h2><p>點員工就能查看職責、技能與流程。空間為附件示意底圖，並非真實辦公室占用資訊。</p></div>' +
      button("view", "切回經典首頁", 'data-id="home"') + '</div><div class="wb-office-layout">' +
      '<section class="wb-glass wb-office-roster"><span class="wb-eyebrow">TEAM · ' + state.agents.length + '</span><h3>在這裡工作的 Agent</h3>' +
      state.agents.map((agent) => {
        const activity = data.agentActivity.find((item) => item.agentId === agent.id);
        const run = activity?.latestRun;
        return '<div class="wb-row"><div class="wb-row-main">' + button("agent", esc(agent.displayName), 'data-id="' + esc(agent.id) + '"', "link") +
          "<small>" + agent.skills.length + " Skills · " + agent.workflows.length + " Workflows</small>" +
          "</div>" + badge(run ? STATUS_LABELS[run.status] || run.status : "尚無紀錄", run?.status || "muted") + "</div>";
      }).join("") + (!state.agents.length ? empty("尚無員工；不會自動建立示範員工。") : "") +
      '<p class="wb-note">狀態來自執行紀錄，不代表真人出勤或即時在線。已建立 Codex 任務不代表完成。</p></section>' +
      '<section class="wb-glass wb-office-stage">' + (floors > 1 ? '<div class="wb-segment">' +
        Array.from({length:floors}, (_, index) => button("office-floor", "工作區 " + (index + 1), 'data-id="' + index + '"',
          index === officeFloor ? "on" : "")).join("") + "</div>" : "") + '<div class="wb-floor"><img src="' + officeBackground +
      '" alt="附件中的像素辦公室示意空間，非真實空間使用資料">' +
      positions.filter((position) => position.floor === officeFloor).map((position) => {
        const agent = state.agents.find((item) => item.id === position.agentId);
        const run = data.agentActivity.find((item) => item.agentId === agent.id)?.latestRun;
        return '<button type="button" class="wb-person" data-wb="agent" data-id="' + esc(agent.id) +
          '" style="left:' + position.x + "%;top:" + position.y + "%;--person-hue:" + position.hue +
          '" aria-label="查看 ' + esc(agent.displayName) + ' 詳情"><span class="wb-person-label">' +
          esc(agent.displayName) + '</span><span class="wb-person-sprite" aria-hidden="true"></span><span class="wb-person-status">' +
          esc(run ? STATUS_LABELS[run.status] || run.status : "尚無紀錄") + "</span></button>";
      }).join("") + '</div><div class="wb-floor-legend">' + badge("真實 Agent 資料", "completed") +
      '<span>僅可點選姓名的人物為真實 Agent；底圖人物為裝飾 · 不計空間使用率</span></div></section>' +
      '<section class="wb-glass wb-office-feed"><span class="wb-eyebrow">' + periodName() + '</span><h3>工作動態</h3>' +
      runRows(data.runs, 7) + button("view", "查看執行中心", 'data-id="runs"') + "</section></div>";
  }
  function skins() {
    return '<div class="wb-heading"><div><h2>同一套資料，不同工作方式。</h2><p>第一版接通經典首頁與像素辦公室，其他介面不以示範腳本冒充功能。</p></div></div>' +
      '<div class="wb-function-grid">' + [
        ["home", "VIXO OS 經典首頁", "厚玻璃、模塊化卡片與真實執行成果"],
        ["office", "像素辦公室", "點選真實員工、查看職責與啟動流程"],
        [null, "JARVIS", "後續：共用資料的指令與狀態面板"],
        [null, "n8n 式流程畫布", "後續：流程節點檢視與編輯，不代表已連接 n8n"],
        [null, "GPT 式對話", "後續：自然語言與語音交辦"],
        [null, "Slack 式協作", "後續：部門頻道與工作訊息，不代表已串接 Slack"],
        [null, "ClickUp／雙介面並排", "後續規劃，第一版未建置"]
      ].map(([id, title, description]) => '<section class="wb-glass wb-feature"><h3>' + title + "</h3><p>" + description +
        "</p>" + (id ? button("view", "開啟介面", 'data-id="' + id + '"', "primary") : badge("後續規劃", "muted")) +
        "</section>").join("") + "</div>";
  }
  function blueprint() {
    return '<div class="wb-heading"><div><h2>功能層</h2><p>15 個模組 · 79 個畫面節點 · 94 個背後功能節點。每個節點都保留來源與交付狀態。</p></div></div>' +
      '<div class="wb-function-grid">' + capabilities.modules.map((module) => {
        const nodes = capabilities.nodes.filter((node) => node.module === module.name);
        return '<section class="wb-glass wb-feature"><span class="wb-eyebrow">' + module.id + "</span><h3>" +
          esc(module.name) + "</h3><p>" + nodes.filter((node) => node.kind === "ui" && node.id !== module.id).slice(0, 3)
            .map((node) => esc(node.name)).join(" · ") + "</p><div>" +
          badge(nodes.filter((node) => node.status === "首版完成").length + " 首版功能", "completed") +
          badge(nodes.filter((node) => node.status === "待串接").length + " 待串接", "muted") +
          "</div>" + button("module", "查看完整功能", 'data-id="' + module.id + '"') + "</section>";
      }).join("") + "</div>";
  }
  function system() {
    return '<div class="wb-heading"><div><h2>系統層</h2><p>連線、資料來源與能力狀態。未授權的系統不會顯示假成功燈號。</p></div></div>' +
      '<section class="wb-glass wb-feature"><h3>現有執行宿主</h3><p>依本機安裝報告，不代表外部資料系統已授權。</p>' +
      badge("Codex：" + (state.hosts.codex ? "可用" : "不可用"), state.hosts.codex ? "completed" : "muted") +
      badge("Claude Code：" + (state.hosts.claude ? "可用" : "不可用"), state.hosts.claude ? "completed" : "muted") +
      '<p class="wb-note">VIXO 與 LazyOffice 儲存、執行與偏好完全分開；此頁不修改「小懶」規則。</p></section>' +
      '<div class="wb-function-grid">' + data.integrations.map((item) =>
        '<section class="wb-glass wb-feature"><h3>' + esc(item.name) + "</h3>" +
        unavailable("未串接", "需正式帳號、授權與資料設定；此版不提供假重新授權按鈕") + "</section>").join("") + "</div>";
  }
  function search(query) {
    const results = searchWorkbench(state, allKnownRuns(), query);
    return '<div class="wb-heading"><div><h2>搜尋結果</h2><p>僅搜尋真實 Agent、Skills、Workflows 與可用執行紀錄；不搜尋尚未串接的信件或檔案。</p></div></div>' +
      '<section class="wb-glass wb-feature">' + results.map((result) => '<div class="wb-row"><div class="wb-row-main">' +
        button(result.type === "run" ? "run" : "agent", esc(result.title),
          'data-id="' + esc(result.type === "run" ? result.id : result.agentId) + '"', "link") +
        "<small>" + esc(result.detail.slice(0, 220)) + "</small></div>" + badge(result.type, "muted") + "</div>").join("") +
      (!results.length ? empty("找不到符合的已登錄資料") : "") + "</section>";
  }
  function render() {
    if (!active || !state || !data || dragId || resizing) return;
    const focused = document.activeElement;
    if ($("#wb-stage").contains(focused) && ["INPUT", "TEXTAREA", "SELECT"].includes(focused.tagName)) return;
    const focusAction = focused?.dataset.wb, focusId = focused?.dataset.id;
    syncTheme();
    $("#wb-sync").textContent = "更新 " + new Date(data.refreshedAt).toLocaleTimeString("zh-TW", { hour12: false });
    $("#wb-crumb-current").textContent = ({ home: "首頁總覽", office: "像素辦公室", skins: "介面樣式",
      functions: "功能層", system: "系統層", runs: "執行中心" })[view];
    const query = $("#wb-search").value.trim();
    $("#wb-stage").innerHTML = query ? search(query) : ({
      home, office, skins, functions: blueprint, system,
      runs: () => '<div class="wb-heading"><div><h2>執行中心</h2><p>' + periodName() + "的完整紀錄。原生 Codex 任務只表示已建立；工作進度請開啟該任務。</p></div></div>" +
        '<section class="wb-glass wb-feature">' + runRows(data.runs, data.runs.length) + "</section>"
    })[view]();
    if (focusAction) {
      const selector = '[data-wb="' + CSS.escape(focusAction) + '"]' + (focusId ? '[data-id="' + CSS.escape(focusId) + '"]' : "");
      $("#wb-stage").querySelector(selector)?.focus({ preventScroll: true });
    }
  }
  function navigate(next) {
    if (!["home", "office", "skins", "functions", "system", "runs"].includes(next)) return;
    view = next;
    $("#wb-search").value = "";
    if (next === "office" || next === "home") {
      preferences.skin = next === "office" ? "office" : "classic";
      savePreferences();
    }
    render();
  }
  function showDetail(title, html) {
    if (!active || !state) return;
    $("#wb-detail-title").textContent = title;
    $("#wb-detail-body").innerHTML = html;
    if (!$("#wb-detail").open) $("#wb-detail").showModal();
  }
  function showAgent(id) {
    const agent = state.agents.find((item) => item.id === id);
    if (!agent) return toast("找不到這位 VIXO 員工");
    showDetail(agent.displayName, '<div class="wb-detail-meta">' + badge(agent.id, "muted") + badge("v" + agent.version, "muted") +
      "</div><h3>職責</h3><p>" + esc(agent.purpose || agent.description) + "</p><h3>Skills</h3>" +
      agent.skills.map((skill) => '<div class="wb-row"><div><strong>' + esc(skill.name) + "</strong><p>" + esc(skill.description) + "</p></div></div>").join("") +
      "<h3>Workflows</h3>" + workflowRows([agent]) +
      agent.workflows.map((workflow) => '<section class="wb-workflow-definition"><h4>' + esc(workflow.name) + "</h4>" +
        (workflow.nodes || []).map((node, index) => '<div class="wb-node"><span>' + (index + 1) + "</span><div><strong>" +
          esc(node.name) + "</strong><p>" + esc(node.instructions || "") + "</p></div>" +
          badge(node.requiresApproval ? "需核准" : node.type, node.requiresApproval ? "waiting-approval" : "muted") + "</div>").join("") +
        button("schedule", "設定每日排程", attrs(agent.id, workflow.id)) + "</section>").join("") +
      '<p class="wb-note">以上為流程定義，不是已執行的步驟證據。第一版不編輯員工 SOP。</p><h3>最近執行</h3>' +
      runRows(allKnownRuns().filter((run) => run.agentId === id), 8));
  }
  async function showRun(id) {
    const stamp = generation;
    const run = await api("/api/runs/" + encodeURIComponent(id));
    if (stamp !== generation || !active || !state) return;
    const agent = state.agents.find((item) => item.id === run.agentId);
    const workflow = agent?.workflows.find((item) => item.id === run.workflowId);
    let controls = "";
    if (run.status === "opened-in-codex" && run.threadId) controls = button("thread", "在 Codex 開啟任務", 'data-id="' + esc(run.threadId) + '"', "primary");
    if (run.resumable && ["waiting-input", "waiting-approval"].includes(run.status)) controls =
      '<label class="wb-label">回覆／核准說明<textarea id="wb-run-message" rows="3" placeholder="請填寫資料或核准理由"></textarea></label>' +
      button(run.status === "waiting-input" ? "reply" : "approve", run.status === "waiting-input" ? "回覆並繼續" : "核准並繼續",
        'data-id="' + esc(run.id) + '"', "primary") +
      button("reject", "拒絕／停止", 'data-id="' + esc(run.id) + '"');
    if (!run.resumable && ["waiting-input", "waiting-approval"].includes(run.status)) controls =
      empty("舊版紀錄沒有可續跑 Session，無法直接核准；請重新 Play，不會自動補執行。") +
      (workflow ? button("play", "重新 Play（新一次執行）", attrs(run.agentId, run.workflowId), "primary") : "");
    if (run.status === "failed" && workflow) controls = button("play", "重新 Play（新一次執行）", attrs(run.agentId, run.workflowId), "primary");
    showDetail((run.agentName || run.agentId) + " · " + (run.workflowName || run.workflowId),
      badge(STATUS_LABELS[run.status] || run.status, run.status) +
      '<p class="wb-note">' + esc(timestamp(run.startedAt)) + " · " + esc(run.host) + (run.projectName ? " · " + esc(run.projectName) : "") +
      "</p><h3>任務</h3><p>" + esc(run.task || "尚無任務說明") + "</p><h3>結果／目前回覆</h3><pre>" +
      esc(run.lastMessage || run.error || "尚無可用结果摘要") + "</pre>" +
      (run.pendingNodeName ? "<h3>等待節點</h3><p>" + esc(run.pendingNodeName) + "</p>" : "") +
      '<p class="wb-note">只呈現紀錄中的事實；沒有逐節點證據時，不顯示完成率。</p><div class="wb-actions">' + controls + "</div>");
  }
  function showModule(id) {
    const module = capabilities.modules.find((item) => item.id === id);
    if (!module) return;
    const nodes = capabilities.nodes.filter((node) => node.module === module.name);
    showDetail(module.name, '<p class="wb-note">首版完成只指備註中的交付範圍，不代表整個模組或外部系統已完成。</p>' +
      nodes.map((node) => '<div class="wb-trace-row"><div>' + badge(node.id + " · " + node.kind, "muted") +
        badge(node.status, node.status === "首版完成" ? "completed" : "muted") + "</div><h4>" + esc(node.name) +
        "</h4><p>" + esc(node.notes) + "</p><small>來源：" + esc(node.source) + "</small></div>").join(""));
  }
  function showLayout() {
    if (!active || !state) return;
    $("#wb-layout-body").innerHTML = preferences.cards.map((card, index) =>
      '<div class="wb-layout-row"><h4 class="wb-icon-heading">' + icon(CARD_LIBRARY[card.id].icon) + CARD_LIBRARY[card.id].name + '</h4><div class="wb-actions">' +
      button("card-up", "", 'data-id="' + card.id + '" aria-label="向前移動 ' + CARD_LIBRARY[card.id].name + '" ' + (index === 0 ? "disabled" : "")) +
      button("card-down", "", 'data-id="' + card.id + '" aria-label="向後移動 ' + CARD_LIBRARY[card.id].name + '" ' + (index === preferences.cards.length - 1 ? "disabled" : "")) +
      '<label><div class="wb-control-label">' + icon("width") + '寬度</div><select data-setting="width" data-id="' + card.id + '">' + [3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((value) =>
        '<option value="' + value + '" ' + (value === card.width ? "selected" : "") + ">" + value + "/12</option>").join("") + "</select></label>" +
      '<label><div class="wb-control-label">' + icon("height") + '高度</div><select data-setting="height" data-id="' + card.id + '">' + [2, 3, 4, 5, 6].map((value) =>
        '<option value="' + value + '" ' + (value === card.height ? "selected" : "") + ">" + value + "</option>").join("") + "</select></label>" +
      '<label><div class="wb-control-label">' + icon("palette") + '顏色</div><select data-setting="tint" data-id="' + card.id + '">' +
      ["none", "iris", "azure", "violet", "rose", "amber", "mint", "teal"].map((value) =>
        '<option value="' + value + '" ' + (value === card.tint ? "selected" : "") + ">" +
        ({ none: "原色", iris: "虹彩", azure: "藍", violet: "紫", rose: "粉", amber: "橙", mint: "綠", teal: "青" })[value] + "</option>").join("") +
      "</select></label>" + button("card-remove", "移除", 'data-id="' + card.id + '"') + "</div></div>"
    ).join("") + "<h3>加入首頁</h3><div class=\"wb-actions\">" + Object.entries(CARD_LIBRARY).filter(([id]) =>
      !preferences.cards.some((card) => card.id === id)).map(([id, card]) => button("card-add", card.name, 'data-id="' + id + '"')).join("") +
      "</div><p class=\"wb-note\">拖曳排序與縮放亦可使用此表單完成。所有設定只保存到 VIXO。</p>";
    if (!$("#wb-layout").open) $("#wb-layout").showModal();
  }
  root.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-wb]");
    if (!target || !root.contains(target) || target.disabled) return;
    const action = target.dataset.wb, id = target.dataset.id;
    try {
      if (action === "view") navigate(id);
      else if (action === "office-floor") { officeFloor = Number(id); render(); }
      else if (action === "theme") { preferences.theme = preferences.theme === "light" ? "dark" : "light"; syncTheme(); await savePreferences(); }
      else if (action === "period") { preferences.period = id; syncTheme(); await savePreferences(); await refresh(state); }
      else if (action === "refresh") await refresh(state);
      else if (action === "agent") showAgent(id);
      else if (action === "run") await showRun(id);
      else if (action === "module") showModule(id);
      else if (action === "thread") openThread(id);
      else if (action === "play" || action === "schedule") {
        $("#wb-detail").close();
        (action === "play" ? play : schedule)(target.dataset.agent, target.dataset.workflow);
      } else if (action === "schedule-delete") {
        if (!confirm("確認移除這個 VIXO 每日排程？")) return;
        await api("/api/schedules/" + encodeURIComponent(id), { method: "DELETE" });
        await refresh({ ...state, schedules: state.schedules.filter((item) => item.id !== id) });
        toast("已移除每日排程");
      } else if (["reply", "approve", "reject"].includes(action)) {
        const message = $("#wb-run-message")?.value.trim();
        if (!message) return toast("請先填寫資料或理由");
        target.disabled = true;
        try {
          await api("/api/runs/" + encodeURIComponent(id) + "/" + action, { method: "POST", body: JSON.stringify({ message }) });
          $("#wb-detail").close(); await refresh(state); toast("已提交回覆");
        } finally { target.disabled = false; }
      } else if (action === "favorite") {
        const key = target.dataset.agent + "/" + target.dataset.workflow;
        preferences.favorites = preferences.favorites.includes(key) ? preferences.favorites.filter((value) => value !== key) : preferences.favorites.concat(key);
        await savePreferences(); render();
        if ($("#wb-detail").open) showAgent(target.dataset.agent);
      } else if (action === "layout" || action === "card-settings") showLayout();
      else if (action === "close-detail") $("#wb-detail").close();
      else if (action === "close-layout") $("#wb-layout").close();
      else if (action.startsWith("card-")) {
        const index = preferences.cards.findIndex((card) => card.id === id);
        if (action === "card-remove") preferences.cards = preferences.cards.filter((card) => card.id !== id);
        if (action === "card-add" && Object.hasOwn(CARD_LIBRARY, id)) preferences.cards.push({ id, width: 4, height: 3, tint: "none" });
        if (action === "card-up" && index > 0) [preferences.cards[index - 1], preferences.cards[index]] = [preferences.cards[index], preferences.cards[index - 1]];
        if (action === "card-down" && index >= 0 && index < preferences.cards.length - 1) [preferences.cards[index], preferences.cards[index + 1]] =
          [preferences.cards[index + 1], preferences.cards[index]];
        await savePreferences(); render(); showLayout();
      }
    } catch (error) { if (error.code !== "stale_operation" && active) toast(error.message); }
  });
  root.addEventListener("change", async (event) => {
    const setting = event.target.dataset.setting, id = event.target.dataset.id;
    if (!setting) return;
    const card = preferences.cards.find((item) => item.id === id);
    if (!card) return;
    card[setting] = setting === "tint" ? event.target.value : Number(event.target.value);
    preferences = normalizePreferences(preferences); await savePreferences(); render();
  });
  $("#wb-search").addEventListener("input", render);
  root.addEventListener("dragstart", (event) => {
    const handle = event.target.closest(".wb-drag");
    if (!handle) return;
    dragId = handle.dataset.card; event.dataTransfer.setData("text/plain", dragId); event.dataTransfer.effectAllowed = "move";
  });
  root.addEventListener("dragover", (event) => { if (dragId && event.target.closest("[data-card]")) event.preventDefault(); });
  root.addEventListener("drop", (event) => {
    const target = event.target.closest("article[data-card]");
    if (!dragId || !target) return;
    event.preventDefault();
    const from = preferences.cards.findIndex((card) => card.id === dragId);
    const to = preferences.cards.findIndex((card) => card.id === target.dataset.card);
    if (from >= 0 && to >= 0 && from !== to) {
      const [card] = preferences.cards.splice(from, 1); preferences.cards.splice(to, 0, card);
      savePreferences();
    }
    dragId = null; render();
  });
  root.addEventListener("dragend", () => { dragId = null; render(); });
  root.addEventListener("pointerdown", (event) => {
    const handle = event.target.closest("[data-resize]");
    if (!handle || event.button !== 0) return;
    const card = preferences.cards.find((item) => item.id === handle.dataset.resize);
    resizing = { card, x: event.clientX, y: event.clientY, width: card.width, height: card.height, element: handle.closest("article") };
    handle.setPointerCapture(event.pointerId); event.preventDefault();
  });
  root.addEventListener("pointermove", (event) => {
    if (!resizing) return;
    const unit = $(".wb-grid").clientWidth / 12;
    resizing.card.width = Math.max(3, Math.min(12, resizing.width + Math.round((event.clientX - resizing.x) / unit)));
    resizing.card.height = Math.max(2, Math.min(6, resizing.height + Math.round((event.clientY - resizing.y) / 84)));
    resizing.element.style.setProperty("--wb-width", resizing.card.width);
    resizing.element.style.setProperty("--wb-height", resizing.card.height);
  });
  const finishResize = () => { if (resizing) { resizing = null; savePreferences(); render(); } };
  root.addEventListener("pointerup", finishResize); root.addEventListener("pointercancel", finishResize);

  async function refresh(nextState) {
    state = nextState;
    if (!active || refreshing) return;
    refreshing = true;
    const stamp = generation;
    try {
      if (!initialized) {
        const revision = preferenceRevision;
        const [saved, trace] = await Promise.all([api("/api/preferences/workbench"), api("/workbench-capabilities.json")]);
        if (stamp !== generation || !active) return;
        if (preferenceRevision === revision) preferences = normalizePreferences(saved);
        capabilities = trace; view = preferences.skin === "office" ? "office" : "home"; initialized = true;
      }
      let requestedPeriod, response;
      do {
        requestedPeriod = preferences.period;
        response = await api("/api/workbench?period=" + requestedPeriod);
      } while (active && preferences.period !== requestedPeriod);
      if (stamp !== generation || !active) return;
      data = response;
      $("#wb-error").hidden = true; render();
    } catch (error) {
      if (stamp !== generation || error.code === "stale_operation" || !active) return;
      $("#wb-error").hidden = false; $("#wb-error").textContent = "無法更新工作台：" + error.message + "。請重新整理；先前資料不代表最新狀態。";
      if (!data) $("#wb-stage").innerHTML = empty("工作台目前無法載入");
    } finally { if (stamp === generation) refreshing = false; }
  }
  return {
    get view() { return view; },
    get active() { return active; },
    async open(nextState) { active = true; root.hidden = false; syncTheme(); await refresh(nextState); },
    close() { active = false; root.hidden = true; $("#wb-detail").close(); $("#wb-layout").close(); syncTheme(); },
    reset() {
      generation++; active=false; initialized=false; refreshing=false; state=null; data=null; capabilities=null;
      preferences=defaultPreferences(); preferenceRevision++; dragId=null; resizing=null; officeFloor=0; view="home";
      root.hidden=true; $("#wb-detail").close(); $("#wb-layout").close(); $("#wb-search").value="";
      for(const id of ["wb-stage","wb-detail-title","wb-detail-body","wb-layout-body","wb-sync","wb-error"]) $("#"+id).replaceChildren();
      $("#wb-error").hidden=true; syncTheme();
    },
    navigate, refresh,
    reportError(message) { $("#wb-error").hidden = false; $("#wb-error").textContent = message; }
  };
}
