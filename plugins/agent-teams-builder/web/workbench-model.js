export const STATUS_LABELS = Object.freeze({
  dispatching: "正在建立 Codex 任務", "opened-in-codex": "已建立 Codex 任務",
  running: "執行中", "waiting-input": "等待輸入", "waiting-approval": "等待核准",
  completed: "已完成", failed: "失敗", rejected: "已拒絕"
});

export const CARD_LIBRARY = Object.freeze({
  today: { name: "今日工作", icon: "today", description: "會議、待辦、信件與 AI 工作", width: 4, height: 3 },
  agents: { name: "常用工作流程 Agent", icon: "workflow", description: "真實員工與常用流程", width: 4, height: 3 },
  approvals: { name: "待確認及審核", icon: "approvals", description: "需要你補資料或核准的工作", width: 4, height: 3 },
  alerts: { name: "異常警示", icon: "alerts", description: "執行失敗與流程等待", width: 4, height: 3 },
  calendar: { name: "行事曆固定工作", icon: "calendar", description: "每日排程與外部行事曆", width: 4, height: 3 },
  projects: { name: "各項任務專案", icon: "projects", description: "執行工作區與業務專案", width: 4, height: 3 },
  recent: { name: "最近工作", icon: "recent", description: "執行摘要與 Codex 任務", width: 4, height: 3 },
  health: { name: "單位健康儀表板", icon: "health", description: "ERP、BI 與部門指標", width: 4, height: 3 },
  revenue: { name: "單位成果儀表板", icon: "revenue", description: "實際 AI 成果與營運 KPI", width: 4, height: 3 },
  meetings: { name: "會議紀錄", icon: "meetings", description: "逐字稿與決議轉任務", width: 4, height: 3 },
  bi: { name: "BI", icon: "bi", description: "資料來源與指標計算", width: 4, height: 3 },
  onepage: { name: "一頁重點表", icon: "onepage", description: "營運重點與異常彙整", width: 4, height: 3 },
  brands: { name: "品牌戰情", icon: "brands", description: "品牌營運資料", width: 4, height: 3 },
  staffprj: { name: "員工專案管理", icon: "team", description: "分工、負載與專案 WBS", width: 4, height: 3 }
});

export function defaultPreferences() {
  return {
    skin: "classic", theme: "light", period: "today", favorites: [], officeSeats: {},
    cards: ["today", "agents", "approvals", "alerts", "calendar", "projects", "recent", "health", "revenue"]
      .map((id) => ({ id, width: CARD_LIBRARY[id].width, height: CARD_LIBRARY[id].height, tint: "none" }))
  };
}

const integer = (value, min, max, fallback) => Number.isInteger(value) && value >= min && value <= max ? value : fallback;
export function normalizePreferences(value) {
  const defaults = defaultPreferences();
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaults;
  const seen = new Set();
  const cards = Array.isArray(value.cards) ? value.cards.slice(0, 14).flatMap((card) => {
    if (!card || !Object.hasOwn(CARD_LIBRARY, card.id) || seen.has(card.id)) return [];
    seen.add(card.id);
    return [{
      id: card.id, width: integer(card.width, 3, 12, 4), height: integer(card.height, 2, 6, 3),
      tint: ["none", "iris", "azure", "violet", "rose", "amber", "mint", "teal"].includes(card.tint) ? card.tint : "none"
    }];
  }) : defaults.cards;
  const officeSeats = {}, usedSeats = new Set();
  for (const [id, slot] of Object.entries(value.officeSeats || {}).slice(0, 1000)) {
    if (!/^[a-z0-9-]+$/.test(id) || !Number.isInteger(slot) || slot < 0 || slot > 4095 || usedSeats.has(slot)) continue;
    officeSeats[id] = slot; usedSeats.add(slot);
  }
  return {
    skin: ["classic", "office"].includes(value.skin) ? value.skin : defaults.skin,
    theme: ["light", "dark"].includes(value.theme) ? value.theme : defaults.theme,
    period: ["today", "week", "month"].includes(value.period) ? value.period : defaults.period,
    favorites: [...new Set(Array.isArray(value.favorites) ? value.favorites.filter((key) =>
      typeof key === "string" && /^[a-z0-9-]+\/[a-z0-9-]+$/.test(key)).slice(0, 100) : [])],
    cards, officeSeats
  };
}

// Fixed slots derived from identity, not API order or a simulated walking loop.
export function officePositions(agents, savedSeats = {}) {
  const occupied = new Set();
  const assignments = new Map();
  for (const agent of agents) {
    const slot = savedSeats[agent.id];
    if (Number.isInteger(slot) && slot >= 0 && !occupied.has(slot)) {
      occupied.add(slot); assignments.set(agent.id, slot);
    }
  }
  return [...agents].sort((a, b) => a.id.localeCompare(b.id)).map((agent) => {
    let hash = 2166136261;
    for (const char of agent.id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    let slot = assignments.get(agent.id);
    if (slot === undefined) { slot = hash % 18; while (occupied.has(slot)) slot++; }
    occupied.add(slot);
    const seat = slot % 18, row = Math.floor(seat / 6);
    return { agentId: agent.id, slot, floor: Math.floor(slot / 18), x: 20 + (seat % 6) * 12, y: 35 + row * 20, hue: hash % 360 };
  });
}

export function searchWorkbench(state, runs, query) {
  const needle = String(query || "").trim().toLocaleLowerCase();
  if (!needle) return [];
  const results = [];
  for (const agent of state.agents || []) {
    results.push({ type: "agent", id: agent.id, agentId: agent.id, title: agent.displayName, detail: agent.description });
    for (const skill of agent.skills || []) results.push({
      type: "skill", id: skill.id, agentId: agent.id, title: skill.name,
      detail: agent.displayName + " · " + (skill.description || "")
    });
    for (const workflow of agent.workflows || []) results.push({
      type: "workflow", id: workflow.id, agentId: agent.id, title: workflow.name,
      detail: agent.displayName + " · " + (workflow.description || "")
    });
  }
  for (const run of runs || []) results.push({
    type: "run", id: run.id, agentId: run.agentId,
    title: (run.agentName || run.agentId) + " · " + (run.workflowName || run.workflowId),
    detail: (STATUS_LABELS[run.status] || run.status) + " · " + (run.task || "") + " · " + (run.lastMessage || "")
  });
  return results.filter((entry) => (entry.title + " " + entry.detail + " " + entry.id + " " + entry.agentId).toLocaleLowerCase().includes(needle)).slice(0, 40);
}


// A disconnected, pending or unverifiable identity can never open private views.
export function dashboardSessionMode(session) {
  if (!session?.connected || !session?.user?.id) return "disconnected";
  if (session.access?.status === "pending") return "pending";
  if (session.access?.status === "disabled") return "disabled";
  if (session.access?.status !== "approved") return "unverified";
  return session.offline ? "offline" : "approved";
}
export const SYNC_LABELS = Object.freeze({"local-only":"未開啟同步",local:"僅在本機",pending:"等待同步",synced:"已同步雲端",conflict:"版本衝突",uncertain:"同步結果待確認",error:"同步失敗"});
export function libraryLocation(entry) {
  const cloudLinked = Boolean(entry.assetId || entry.id?.startsWith("cloud:"));
  return { cloudLinked, storage: cloudLinked ? "本機＋雲端" : "僅存本機",
    scope: entry.workspaceId ? (cloudLinked ? "團隊共享" : "待同步至團隊") : "私人內容", execution: "本機執行" };
}
export function visibleLibrary(entries, session, kind) {
  const mode = dashboardSessionMode(session);
  if (!["approved", "offline"].includes(mode)) return [];
  return (entries || []).filter(entry => (!kind || entry.kind === kind) &&
    (mode !== "offline" || entry.id?.startsWith("local:")));
}
export function validateAccountInput({username,password,confirmation,displayName}, mode="login") {
  if (!/^[a-z][a-z0-9_-]{2,31}$/.test(username)) return "帳號需為 3–32 個小寫英文字母、數字、底線或連字號，並以英文字母開頭。";
  if (typeof password !== "string" || !password.length) return "請輸入密碼。";
  if (new TextEncoder().encode(password).length > 72) return "請縮短密碼，中文字元會佔用較多長度。";
  if (mode !== "login" && [...password].length < 12) return "密碼至少需要 12 個字元。";
  if (mode !== "login" && password !== confirmation) return "兩次輸入的密碼不一致。";
  if (mode === "register" && (!displayName?.trim() || [...displayName.trim()].length > 80)) return "請輸入 1–80 個字元的姓名。";
  return "";
}
export function draftBundleTemplate(kind="agent") {
  const skill = { id: 'new-skill', name: '新技能', description: '請填寫這項技能的用途。', triggers: ['使用者指定這項技能'], allowedTools: [], steps: ['請在這裡填寫完整、可執行的工作步驟。'], successCriteria: ['確認完成使用者要求。'] };
  const workflow = { id: 'new-workflow', name: '新流程', description: '請填寫這項流程的用途。', triggers: [], nodes: [{ id: 'first-step', name: '執行技能', type: 'skill', skillId: skill.id, instructions: '依技能的完整 SOP 執行。', requiresApproval: false }] };
  const agent = { id: 'new-agent', displayName: '新 Agent', aliases: [], description: '請填寫這個角色的用途。', purpose: '依使用者指定的任務提供協助。', systemPrompt: '請依完整 SOP 與本次使用者授權執行工作；缺少資料時先確認。', memory: '', skills: [skill], workflows: [] };
  return { formatVersion: 1, kind, spec: kind === 'agent' ? agent : kind === 'workflow' ? { ...workflow, skills: [skill] } : skill, files: [{ path: 'skills/new-skill/SKILL.md', content: '# 新技能\n\n請在此補上與 spec.steps 一致的完整工作步驟。\n' }], dependencies: [], requirements: { platforms: [], tools: [] } };
}

export function libraryWithAgentChildren(entries=[], agents=[]) {
  const rows=[...entries];
  for(const agent of agents) {
    const parent=entries.find(entry=>entry.kind==="agent" && entry.id===agent.id);
    if(!parent)continue;
    for(const [kind,children] of [["skill",agent.skills||[]],["workflow",agent.workflows||[]]])
      for(const child of children)rows.push({id:`${parent.id}/${kind}:${child.id}`,parentId:parent.id,parentTitle:parent.title,
        kind,title:child.name,slug:child.id,description:child.description||"",syncState:parent.syncState,syncMode:parent.syncMode,assetId:parent.assetId,workspaceId:parent.workspaceId,revision:parent.revision});
  }
  return rows;
}
