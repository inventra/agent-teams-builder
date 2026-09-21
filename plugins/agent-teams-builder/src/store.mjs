import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AGENT_SCHEMA_VERSION = 1;
const DRAFT_TTL_MS = 15 * 60 * 1000;
const SAFE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const AFFIRMATIVE_CONFIRMATION = /^(確認|同意|是|好|可以|請建立|請修改|yes\b|confirm\b|approved\b|ok\b)/i;
const SECRET_PATTERNS = [
  /sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/,
  /Bearer\s+[A-Za-z0-9._~-]{20,}/i,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /AKIA[0-9A-Z]{16}/
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function cleanString(value, field, max = 4000) {
  assert(typeof value === "string", `${field} must be a string`);
  const cleaned = value.trim();
  assert(cleaned.length > 0, `${field} is required`);
  assert(cleaned.length <= max, `${field} is too long (max ${max})`);
  return cleaned;
}

function cleanStringArray(value, field, { required = false, maxItems = 50, maxLength = 500 } = {}) {
  if (value === undefined || value === null) value = [];
  assert(Array.isArray(value), `${field} must be an array`);
  assert(value.length <= maxItems, `${field} has too many items`);
  const cleaned = [...new Set(value.map((item, index) => cleanString(item, `${field}[${index}]`, maxLength)))];
  if (required) assert(cleaned.length > 0, `${field} must contain at least one item`);
  return cleaned;
}

function normalizeId(value, field = "id") {
  const id = cleanString(value, field, 64).toLowerCase();
  assert(SAFE_ID.test(id), `${field} must be an English kebab-case name such as booking or flight-helper`);
  return id;
}

function ensureWithin(parent, child) {
  const parentResolved = path.resolve(parent) + path.sep;
  const childResolved = path.resolve(child);
  assert(childResolved.startsWith(parentResolved), "Resolved path escaped the Agent Teams directory");
  return childResolved;
}

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function agentTeamsRoot() {
  if (process.env.AGENT_TEAMS_HOME) return path.resolve(process.env.AGENT_TEAMS_HOME);
  return path.join(os.homedir(), "Downloads", "Agent Teams");
}

export function ensureAgentTeamsRoot() {
  const root = agentTeamsRoot();
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, ".drafts"), { recursive: true });
  const readme = path.join(root, "README.md");
  if (!fs.existsSync(readme)) {
    writeAtomic(readme, [
      "# Agent Teams",
      "",
      "此資料夾由 Agent Teams Builder 管理。每個 Agent 使用獨立的英文資料夾名稱。",
      "請透過 Claude Code、Codex 或隨附的 CLI 建立與修改 Agent，避免直接更動 `.drafts` 與 `.system`。",
      ""
    ].join("\n"));
  }
  return root;
}

function normalizeSkill(skill, index) {
  assert(skill && typeof skill === "object" && !Array.isArray(skill), `skills[${index}] must be an object`);
  return {
    id: normalizeId(skill.id, `skills[${index}].id`),
    name: cleanString(skill.name, `skills[${index}].name`, 100),
    description: cleanString(skill.description, `skills[${index}].description`, 1000),
    triggers: cleanStringArray(skill.triggers, `skills[${index}].triggers`, { required: true, maxItems: 30, maxLength: 160 }),
    allowedTools: cleanStringArray(skill.allowedTools, `skills[${index}].allowedTools`, { maxItems: 40, maxLength: 120 }),
    steps: cleanStringArray(skill.steps, `skills[${index}].steps`, { required: true, maxItems: 100, maxLength: 1200 }),
    successCriteria: cleanStringArray(skill.successCriteria, `skills[${index}].successCriteria`, { required: true, maxItems: 50, maxLength: 700 })
  };
}

export function normalizeSpec(raw, previous = null) {
  assert(raw && typeof raw === "object" && !Array.isArray(raw), "spec must be an object");
  const id = normalizeId(raw.id);
  const skills = (raw.skills || []).map(normalizeSkill);
  assert(skills.length > 0, "At least one skill is required");
  assert(new Set(skills.map((skill) => skill.id)).size === skills.length, "Skill ids must be unique");
  const now = new Date().toISOString();
  return {
    schemaVersion: AGENT_SCHEMA_VERSION,
    id,
    displayName: cleanString(raw.displayName, "displayName", 100),
    aliases: cleanStringArray(raw.aliases, "aliases", { maxItems: 30, maxLength: 100 }),
    description: cleanString(raw.description, "description", 1000),
    purpose: cleanString(raw.purpose, "purpose", 2000),
    version: previous ? Number(previous.version || 0) + 1 : 1,
    createdAt: previous?.createdAt || now,
    updatedAt: now,
    framework: {
      name: "Host-native Agent Plugin",
      executionMode: "current-host",
      supportedHosts: ["codex", "claude-code"],
      modelApiRequired: false
    },
    systemPrompt: cleanString(raw.systemPrompt, "systemPrompt", 12000),
    memory: cleanString(raw.memory || "尚無長期記憶。", "memory", 20000),
    skills
  };
}

function agentDirectory(id) {
  return ensureWithin(agentTeamsRoot(), path.join(agentTeamsRoot(), normalizeId(id)));
}

export function getAgent(reference) {
  const root = ensureAgentTeamsRoot();
  const directId = typeof reference === "string" ? reference.trim().toLowerCase() : "";
  if (SAFE_ID.test(directId)) {
    const directFile = path.join(agentDirectory(directId), "agent.json");
    if (fs.existsSync(directFile)) return readJson(directFile);
  }
  const needle = cleanString(reference, "agent", 100).toLocaleLowerCase("zh-TW");
  const matches = listAgents().filter((agent) => {
    const candidates = [agent.id, agent.displayName, ...(agent.aliases || [])];
    return candidates.some((candidate) => candidate.toLocaleLowerCase("zh-TW") === needle);
  });
  assert(matches.length > 0, `Agent not found: ${reference}`);
  assert(matches.length === 1, `Agent reference is ambiguous: ${reference}`);
  return readJson(path.join(root, matches[0].id, "agent.json"));
}

export function listAgents() {
  const root = ensureAgentTeamsRoot();
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && SAFE_ID.test(entry.name))
    .flatMap((entry) => {
      const file = path.join(root, entry.name, "agent.json");
      if (!fs.existsSync(file)) return [];
      try {
        const agent = readJson(file);
        return [{
          id: agent.id,
          displayName: agent.displayName,
          aliases: agent.aliases || [],
          description: agent.description,
          version: agent.version,
          skills: (agent.skills || []).map((skill) => ({ id: skill.id, name: skill.name, description: skill.description })),
          updatedAt: agent.updatedAt
        }];
      } catch {
        return [];
      }
    })
    .sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-TW"));
}

function renderAgentMarkdown(agent) {
  return [
    "---",
    `name: ${agent.id}`,
    `description: ${JSON.stringify(agent.description)}`,
    `memory: project`,
    "---",
    "",
    `# ${agent.displayName}`,
    "",
    agent.systemPrompt,
    "",
    "## 用途",
    "",
    agent.purpose,
    "",
    "## 技能路由",
    "",
    ...agent.skills.flatMap((skill) => [
      `### ${skill.name} (${skill.id})`,
      "",
      skill.description,
      "",
      `觸發條件：${skill.triggers.join("、")}`,
      ""
    ])
  ].join("\n");
}

function renderSkillMarkdown(agent, skill) {
  return [
    "---",
    `name: ${skill.id}`,
    `description: ${JSON.stringify(skill.description)}`,
    "---",
    "",
    `# ${agent.displayName}｜${skill.name}`,
    "",
    "## 何時使用",
    "",
    ...skill.triggers.map((trigger) => `- ${trigger}`),
    "",
    "## SOP",
    "",
    ...skill.steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    "## 可用工具",
    "",
    ...(skill.allowedTools.length ? skill.allowedTools.map((tool) => `- ${tool}`) : ["- 使用目前宿主環境已提供、且符合使用者授權範圍的工具。"]),
    "",
    "## 完成條件",
    "",
    ...skill.successCriteria.map((criterion) => `- ${criterion}`),
    "",
    "## 安全界線",
    "",
    "- 不得自行推斷缺少的付款、身分、法務或外部送出資料。",
    "- 任何不可逆或會對外送出的動作，都必須遵守目前宿主環境的確認與權限政策。",
    ""
  ].join("\n");
}

function renderMemory(agent) {
  return [
    `# ${agent.displayName} Memory`,
    "",
    agent.memory,
    "",
    "## 維護規則",
    "",
    "只保存可重複使用且經使用者確認的資訊；不得保存密碼、Token、信用卡、身分證號或 Session Cookie。",
    ""
  ].join("\n");
}

export function createPreview({ action, spec }) {
  const requestedAction = action === "update" ? "update" : "create";
  const serializedInput = JSON.stringify(spec || {});
  assert(!SECRET_PATTERNS.some((pattern) => pattern.test(serializedInput)), "Potential secret detected. Replace credentials, tokens, or session data with an environment-variable placeholder before previewing.");
  let previous = null;
  try { previous = getAgent(spec?.id); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("Agent not found:")) throw error;
  }
  if (requestedAction === "create") assert(!previous, `Agent ${spec?.id} already exists; use update`);
  if (requestedAction === "update") assert(previous, `Agent ${spec?.id} does not exist; use create`);
  const normalized = normalizeSpec(spec, previous);
  const payload = { action: requestedAction, spec: normalized, expiresAt: new Date(Date.now() + DRAFT_TTL_MS).toISOString() };
  const token = sha256(`${stableJson(payload)}:${crypto.randomUUID()}`);
  const draftPath = ensureWithin(agentTeamsRoot(), path.join(agentTeamsRoot(), ".drafts", `${token}.json`));
  writeAtomic(draftPath, `${JSON.stringify(payload, null, 2)}\n`);
  return { token, expiresAt: payload.expiresAt, action: requestedAction, spec: normalized };
}

export function commitPreview({ token, userConfirmation }) {
  assert(/^[a-f0-9]{64}$/.test(token || ""), "Invalid confirmation token");
  assert(typeof userConfirmation === "string" && userConfirmation.trim().length >= 1, "A verbatim user confirmation is required");
  assert(AFFIRMATIVE_CONFIRMATION.test(userConfirmation.trim()), "The confirmation text is not explicitly affirmative");
  const draftPath = ensureWithin(agentTeamsRoot(), path.join(agentTeamsRoot(), ".drafts", `${token}.json`));
  assert(fs.existsSync(draftPath), "Preview token not found or already used");
  const draft = readJson(draftPath);
  assert(Date.parse(draft.expiresAt) >= Date.now(), "Preview token expired; create a new preview");
  const spec = draft.spec;
  const directory = agentDirectory(spec.id);
  if (fs.existsSync(directory)) assert(!fs.lstatSync(directory).isSymbolicLink(), "Refusing to write through a symbolic link");
  fs.mkdirSync(path.join(directory, "history"), { recursive: true });
  fs.mkdirSync(path.join(directory, "skills"), { recursive: true });
  const retainedSkills = new Set(spec.skills.map((skill) => skill.id));
  const existingSkillRoot = path.join(directory, "skills");
  const removed = fs.readdirSync(existingSkillRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name) && !retainedSkills.has(entry.name));
  if (removed.length) {
    const archiveRoot = path.join(directory, "history", "removed-skills", new Date().toISOString().replace(/[:.]/g, "-"));
    fs.mkdirSync(archiveRoot, { recursive: true });
    for (const entry of removed) {
      const oldPath = ensureWithin(directory, path.join(existingSkillRoot, entry.name));
      assert(!fs.lstatSync(oldPath).isSymbolicLink(), "Refusing to archive a symbolic-link skill directory");
      fs.renameSync(oldPath, path.join(archiveRoot, entry.name));
    }
  }
  for (const skill of spec.skills) {
    const skillDirectory = ensureWithin(directory, path.join(directory, "skills", skill.id));
    fs.mkdirSync(skillDirectory, { recursive: true });
    writeAtomic(path.join(skillDirectory, "SKILL.md"), renderSkillMarkdown(spec, skill));
  }
  writeAtomic(path.join(directory, "agent.json"), `${JSON.stringify(spec, null, 2)}\n`);
  writeAtomic(path.join(directory, "AGENT.md"), renderAgentMarkdown(spec));
  writeAtomic(path.join(directory, "MEMORY.md"), renderMemory(spec));
  fs.appendFileSync(path.join(directory, "history", "revisions.jsonl"), `${JSON.stringify({
    at: new Date().toISOString(),
    action: draft.action,
    version: spec.version,
    confirmation: userConfirmation.trim(),
    specHash: sha256(stableJson(spec))
  })}\n`, { encoding: "utf8", mode: 0o600 });
  fs.unlinkSync(draftPath);
  return { id: spec.id, displayName: spec.displayName, version: spec.version, directory };
}

export function prepareRun({ agent: reference, task, skill: requestedSkill }) {
  const agent = getAgent(reference);
  const cleanTask = cleanString(task, "task", 8000);
  let selected;
  if (requestedSkill) {
    const needle = requestedSkill.trim().toLocaleLowerCase("zh-TW");
    selected = agent.skills.find((skill) => [skill.id, skill.name].some((value) => value.toLocaleLowerCase("zh-TW") === needle));
    assert(selected, `Skill not found: ${requestedSkill}`);
  } else {
    const normalizedTask = cleanTask.toLocaleLowerCase("zh-TW");
    selected = agent.skills.find((skill) => skill.triggers.some((trigger) => normalizedTask.includes(trigger.toLocaleLowerCase("zh-TW")))) || agent.skills[0];
  }
  const prompt = [
    agent.systemPrompt,
    "",
    `你現在以 ${agent.displayName} 身分工作。`,
    `使用技能：${selected.name}`,
    "",
    "請依序遵循：",
    ...selected.steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    "完成條件：",
    ...selected.successCriteria.map((criterion) => `- ${criterion}`),
    "",
    `使用者任務：${cleanTask}`
  ].join("\n");
  return {
    agent,
    skill: selected,
    task: cleanTask,
    execution: {
      mode: "current-host",
      supportedHosts: ["codex", "claude-code"],
      instruction: "Execute this prompt with the current Codex or Claude Code session and its available tools. Do not call a separate model API."
    },
    prompt
  };
}

export const internals = { SAFE_ID, normalizeId, stableJson, sha256 };
