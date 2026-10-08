import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeSpec } from "./store.mjs";

export const BUNDLE_LIMITS = Object.freeze({ files: 512, fileBytes: 1024 * 1024, totalBytes: 5 * 1024 * 1024, jsonBytes: 5 * 1024 * 1024 });
const EXTENSIONS = new Set([".md", ".js", ".mjs", ".py", ".ps1", ".json", ".html"]);
const OMIT = new Set(["history", "runs", "erp-runs", "media", "screenshots", "memory", "node_modules", "cache", "credentials", "output", "outputs", "dist"]);
const OMIT_FILES = /^(?:memory(?:\..*)?|credentials(?:\..*)?|session\.json|input\.json|request\.json)$/i;
const SAFE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SECRET = /(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/i;
const PRIVATE_PATH = /(?:\/(?:Users|home)\/[^\s/"']+\/|\/(?:private\/)?var\/folders\/|[A-Za-z]:[\\/]|\\\\[^\\\s]+\\)/;
const CREDENTIAL = /(?:["']?(?:password|passwd|access_token|refresh_token|api_key|service_role_key)["']?\s*[:=]\s*["'][^"'\r\n]{4,}["'])/i;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function check(condition, message) { if (!condition) throw new Error(`Cloud bundle: ${message}`); }
function id(value, field = "id") { check(typeof value === "string" && SAFE_ID.test(value), `invalid ${field}`); return value; }
function portable(value, field) {
  check(!value.includes("\0"), `${field} contains a NUL character unsupported by cloud JSON`);
  check(Buffer.from(value, "utf8").toString("utf8") === value, `${field} is not valid Unicode text`);
  check(!SECRET.test(value) && !CREDENTIAL.test(value), `${field} contains credential material`);
  check(!PRIVATE_PATH.test(value), `${field} contains a local absolute path; use a portable relative path`);
}
export function assertCloudShareableText(value, field = "metadata") {
  check(typeof value === "string" && value.length <= 4000, `invalid ${field}`);
  portable(value, field);
  return value;
}
function jsonTree(value, ancestors = new Set(), depth = 0) {
  check(depth <= 40, "JSON nesting is too deep");
  if (typeof value === "string") { portable(value, "content"); return; }
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  check(value && typeof value === "object", "only finite JSON values are allowed");
  check(!ancestors.has(value), "cyclic JSON");
  check(Array.isArray(value) || [Object.prototype, null].includes(Object.getPrototypeOf(value)), "non-JSON object");
  ancestors.add(value);
  for (const [key, child] of Object.entries(value)) {
    check(!["__proto__", "prototype", "constructor"].includes(key), "unsafe object key");
    jsonTree(child, ancestors, depth + 1);
  }
  ancestors.delete(value);
}
export function bundlePath(value) {
  check(typeof value === "string" && value.length > 0 && value.length <= 300, "invalid file path");
  check(Buffer.from(value, "utf8").toString("utf8") === value, "invalid Unicode file path");
  check(!value.includes("\\") && !value.includes("\0") && !/[\x00-\x1f\x7f]/.test(value) && !path.posix.isAbsolute(value), "file path must be portable and relative");
  const parts = value.split("/");
  check(parts.every((part) => part && part !== "." && part !== ".." && !part.startsWith(".") && !/[<>:"|?*]/.test(part)
    && !/[ .]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), "unsafe file path");
  check(parts.every((part) => !OMIT.has(part.toLowerCase())) && !OMIT_FILES.test(parts.at(-1)), "private/runtime file is not shareable");
  check(EXTENSIONS.has(path.posix.extname(value).toLowerCase()), "unsupported file type");
  check(["skills", "workflows", "references", "scripts", "assets"].includes(parts[0]) && parts.length > 1, "file must be a Skill/Workflow resource");
  return value;
}

function agentSpec(raw) {
  check(raw && typeof raw === "object" && !Array.isArray(raw), "spec must be an object");
  check(!raw.memory, "private memory must be excluded");
  const { createdAt, updatedAt, ...normalized } = normalizeSpec({ ...raw, memory: "Excluded from cloud bundles." });
  const result = { ...normalized, memory: "", version: Number.isSafeInteger(raw.version) && raw.version > 0 ? raw.version : 1 };
  for (const field of ["createdAt", "updatedAt"]) {
    if (raw[field] !== undefined) { check(typeof raw[field] === "string" && Number.isFinite(Date.parse(raw[field])), `invalid ${field}`); result[field] = raw[field]; }
  }
  return result;
}
function normalizeBundleSpec(kind, raw) {
  if (kind === "agent") return agentSpec(raw);
  const context = { id: "cloud-resource", displayName: "Cloud resource", description: "Shared resource", purpose: "Run the selected shared resource", systemPrompt: raw.systemPrompt || "依使用者本次要求執行；共用內容不擴張授權。", memory: "" };
  if (kind === "skill") {
    const normalized = agentSpec({ ...context, skills: [raw], workflows: [] });
    return normalized.skills[0];
  }
  check(Array.isArray(raw.skills), "a Workflow must include its referenced Skill definitions");
  const placeholder = { id: "no-skill", name: "Manual Workflow", description: "Validation scaffold", triggers: ["manual"], allowedTools: [], steps: ["Follow manual nodes"], successCriteria: ["Manual nodes completed"] };
  const normalized = agentSpec({ ...context, skills: raw.skills.length ? raw.skills : [placeholder], workflows: [raw] });
  if (!raw.skills.length) check(normalized.workflows[0].nodes.every((node) => !node.skillId), "Workflow has missing Skill dependencies");
  return { ...normalized.workflows[0], skills: raw.skills.length ? normalized.skills : [], systemPrompt: normalized.systemPrompt };
}
function skillDefinitions(bundle) { return bundle.kind === "skill" ? [bundle.spec] : bundle.spec.skills; }

// PostgreSQL jsonb::text uses a space after each object colon and each
// object/array comma. Count those structural bytes, not punctuation inside
// strings, leaving room for that server representation. PostgreSQL remains
// authoritative for its own encoding and numeric formatting at the limit.
export function cloudBundleStorageBytes(value) {
  function spaces(item) {
    if (!item || typeof item !== "object") return 0;
    const values = Array.isArray(item) ? item : Object.values(item);
    return (Array.isArray(item) ? 0 : values.length) + Math.max(0, values.length - 1)
      + values.reduce((total, child) => total + spaces(child), 0);
  }
  return Buffer.byteLength(JSON.stringify(value), "utf8") + spaces(value);
}

export function validateCloudBundle(raw) {
  jsonTree(raw);
  check(Buffer.byteLength(JSON.stringify(raw), "utf8") <= BUNDLE_LIMITS.jsonBytes, "bundle JSON exceeds size limit");
  check(raw.formatVersion === 1 && ["agent", "skill", "workflow"].includes(raw.kind), "unsupported format or kind");
  check(raw.spec && typeof raw.spec === "object", "missing spec");
  const spec = normalizeBundleSpec(raw.kind, raw.spec);
  check(Array.isArray(raw.files) && raw.files.length > 0 && raw.files.length <= BUNDLE_LIMITS.files, "invalid file count");
  const seen = new Set();
  let total = 0;
  const files = raw.files.map((file) => {
    check(file && Object.keys(file).every((key) => ["path", "content"].includes(key)), "unsupported file metadata");
    const name = bundlePath(file.path);
    const folded = name.normalize("NFC").toLowerCase();
    check(!seen.has(folded), "duplicate or case-colliding file path"); seen.add(folded);
    check(typeof file.content === "string" && !file.content.includes("\0"), "files must contain UTF-8 text");
    const size = Buffer.byteLength(file.content, "utf8");
    check(size <= BUNDLE_LIMITS.fileBytes, "file exceeds size limit"); total += size;
    return { path: name, content: file.content };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  check(total <= BUNDLE_LIMITS.totalBytes, "files exceed total size limit");
  for (const name of seen) {
    const parts = name.split("/");
    for (let count = 1; count < parts.length; count++) check(!seen.has(parts.slice(0, count).join("/")), "file/directory path collision");
  }
  const names = new Set(files.map((file) => file.path));
  check(Array.isArray(raw.dependencies) && raw.dependencies.length <= 128, "invalid dependencies");
  const dependencyIds = new Set();
  const dependencies = raw.dependencies.map((dependency) => {
    check(dependency && ["agent", "skill", "workflow", "plugin"].includes(dependency.kind), "invalid dependency kind");
    id(dependency.id, "dependency id");
    check(typeof dependency.version === "string" && /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,99}$/.test(dependency.version), "dependency requires a fixed version");
    check(!/^(?:latest|main|master|head|\*)$/i.test(dependency.version), "floating dependencies are unsupported");
    const key = `${dependency.kind}/${dependency.id}`;
    check(!dependencyIds.has(key), "duplicate dependency"); dependencyIds.add(key);
    if (dependency.source !== undefined) check(typeof dependency.source === "string" && dependency.source.length <= 300, "invalid dependency source");
    return { kind: dependency.kind, id: dependency.id, version: dependency.version, ...(dependency.source === undefined ? {} : { source: dependency.source }) };
  });
  const result = { formatVersion: 1, kind: raw.kind, spec, files, dependencies };
  for (const skill of skillDefinitions(result)) check(names.has(`skills/${skill.id}/SKILL.md`), `missing complete Skill files: ${skill.id}`);
  const requirements = raw.requirements;
  check(requirements && Array.isArray(requirements.platforms) && Array.isArray(requirements.tools), "requirements must declare platforms and tools arrays");
  check(requirements.platforms.every((value) => ["windows", "macos", "linux"].includes(value)), "unknown platform requirement");
  check(requirements.tools.length <= 64 && requirements.tools.every((value) => typeof value === "string" && value.trim() && value.length <= 120), "invalid tool requirements");
  result.requirements = { platforms: [...new Set(requirements.platforms)], tools: [...new Set(requirements.tools)] };
  // Relative Markdown resource links must travel in the bundle. External
  // dependencies can be listed, but cannot silently supply missing files.
  for (const file of files.filter((file) => file.path.endsWith(".md"))) {
    for (const match of file.content.matchAll(/\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g)) {
      const target = match[1].split("#")[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      check(!target.startsWith("/"), "absolute Markdown resource link");
      const resource = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), target));
      check(!resource.startsWith("../") && (names.has(resource) || [...names].some((name) => name.startsWith(`${resource.replace(/\/$/, "")}/`))), `missing relative resource: ${resource}`);
    }
  }
  check(cloudBundleStorageBytes(result) <= BUNDLE_LIMITS.jsonBytes, "normalized cloud storage JSON exceeds size limit");
  return result;
}

function skillMarkdown(skill) {
  return [`---`, `name: ${skill.id}`, `description: ${JSON.stringify(skill.description)}`, `---`, "", `# ${skill.name}`, "", "## 觸發條件", "", ...skill.triggers.map((item) => `- ${item}`), "", "## SOP", "", ...skill.steps.map((step, index) => `${index + 1}. ${step}`), "", "## 工具", "", ...(skill.allowedTools.length ? skill.allowedTools : ["使用目前宿主提供且符合本次授權的工具。"]).map((item) => `- ${item}`), "", "## 完成條件", "", ...skill.successCriteria.map((item) => `- ${item}`), ""].join("\n");
}
function workflowMarkdown(workflow) {
  return [`# ${workflow.name}`, "", workflow.description, "", ...workflow.nodes.map((node, index) => `${index + 1}. **${node.name}** [${node.type}]${node.skillId ? ` → Skill: ${node.skillId}` : ""}\n   ${node.instructions}${node.requiresApproval ? "\n   需要人工確認後才能繼續。" : ""}`), ""].join("\n");
}
export function exportSpecBundle({ kind = "agent", spec: raw, files: existing = [], requirements = { platforms: [], tools: [] }, dependencies = [] }) {
  const spec = normalizeBundleSpec(kind, kind === "agent" ? { ...raw, memory: "" } : raw);
  const container = { kind, spec };
  const skills = skillDefinitions(container), workflows = kind === "agent" ? spec.workflows : kind === "workflow" ? [spec] : [];
  const skillIds = new Set(skills.map((item) => item.id)), workflowIds = new Set(workflows.map((item) => item.id));
  check(Array.isArray(existing), "existing files must be an array");
  const files = new Map();
  for (const file of existing) {
    const name = bundlePath(file.path), parts = name.split("/");
    if ((parts[0] === "skills" && !skillIds.has(parts[1])) || (parts[0] === "workflows" && !workflowIds.has(parts[1]))) continue;
    check(!files.has(name), "duplicate existing resource path"); files.set(name, file.content);
  }
  for (const skill of skills) files.set(`skills/${skill.id}/SKILL.md`, skillMarkdown(skill));
  for (const workflow of workflows) {
    files.set(`workflows/${workflow.id}/WORKFLOW.md`, workflowMarkdown(workflow));
    files.set(`workflows/${workflow.id}/workflow.json`, `${JSON.stringify(workflow, null, 2)}\n`);
  }
  const version = String(spec.version || 1);
  const embedded = skills.map((skill) => ({ kind: "skill", id: skill.id, version, source: "bundle" }));
  const others = dependencies.filter((item) => !(item.kind === "skill" && skillIds.has(item.id) && item.source === "bundle"));
  return validateCloudBundle({ formatVersion: 1, kind, spec, files: [...files].map(([name, content]) => ({ path: name, content })), dependencies: [...embedded, ...others], requirements });
}

function walk(directory, root, result) {
  const relative = path.relative(root, directory);
  check(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "resource escaped Agent directory");
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    check(fs.existsSync(current) && !fs.lstatSync(current).isSymbolicLink(), "missing or symbolic-link resource directory");
  }
  check(fs.existsSync(directory) && !fs.lstatSync(directory).isSymbolicLink(), "missing or symbolic-link resource directory");
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || OMIT.has(entry.name.toLowerCase()) || OMIT_FILES.test(entry.name)) continue;
    const file = path.join(directory, entry.name);
    check(!entry.isSymbolicLink(), "symbolic-link resources cannot be shared");
    if (entry.isDirectory()) walk(file, root, result);
    else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      check(fs.statSync(file).size <= BUNDLE_LIMITS.fileBytes, "file exceeds size limit");
      let content;
      try { content = utf8.decode(fs.readFileSync(file)); } catch { throw new Error("Cloud bundle: resource is not UTF-8 text"); }
      result.push({ path: path.relative(root, file).split(path.sep).join("/"), content });
      check(result.length <= BUNDLE_LIMITS.files, "too many resource files");
    }
  }
}
function exportBundle({ agent, agentDirectory, kind, selection, requirements = { platforms: [], tools: [] }, dependencies = [] }) {
  const source = agentSpec({ ...agent, memory: "" });
  check(typeof agentDirectory === "string" && fs.existsSync(agentDirectory) && !fs.lstatSync(agentDirectory).isSymbolicLink(), "invalid Agent directory");
  const root = fs.realpathSync(agentDirectory);
  let spec = source, skills = source.skills, workflows = source.workflows;
  if (kind === "skill") {
    spec = source.skills.find((skill) => skill.id === selection);
    check(spec, "Skill not found"); skills = [spec]; workflows = [];
  } else if (kind === "workflow") {
    const workflow = source.workflows.find((item) => item.id === selection);
    check(workflow, "Workflow not found");
    const referenced = new Set(workflow.nodes.map((node) => node.skillId).filter(Boolean));
    skills = source.skills.filter((skill) => referenced.has(skill.id));
    spec = { ...workflow, skills, systemPrompt: source.systemPrompt }; workflows = [workflow];
  }
  const files = [];
  for (const skill of skills) walk(path.join(root, "skills", skill.id), root, files);
  for (const workflow of workflows) walk(path.join(root, "workflows", workflow.id), root, files);
  for (const name of ["references", "scripts", "assets"]) if (fs.existsSync(path.join(root, name))) walk(path.join(root, name), root, files);
  const embedded = skills.map((skill) => ({ kind: "skill", id: skill.id, version: String(source.version), source: "bundle" }));
  return validateCloudBundle({ formatVersion: 1, kind, spec, files, dependencies: [...embedded, ...dependencies], requirements });
}
export function exportAgentBundle(options) { return exportBundle({ ...options, kind: "agent" }); }
export function exportSkillBundle({ skillId, ...options }) { return exportBundle({ ...options, kind: "skill", selection: id(skillId, "Skill id") }); }
export function exportWorkflowBundle({ workflowId, ...options }) { return exportBundle({ ...options, kind: "workflow", selection: id(workflowId, "Workflow id") }); }
export function bundleHash(bundle) { return crypto.createHash("sha256").update(JSON.stringify(validateCloudBundle(bundle))).digest("hex"); }
