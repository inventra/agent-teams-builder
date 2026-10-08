import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPublicSkills, getPublicSkill, readPublicSkillReference, preparePublicSkill } from "../src/public-skills.mjs";

const slugs = ["erp-video-automation", "expense-claim-helper", "vixo-video-intake"];
const titles = ["ERP 影片自動化工坊", "請款小幫手", "VIXO 影片入口"];
let root, options;
function write(relative, content) { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; }
function snapshot(directory) {
  return fs.readdirSync(directory, { recursive: true }).filter(relative => fs.lstatSync(path.join(directory, relative)).isFile()).sort().map(relative => [relative, fs.readFileSync(path.join(directory, relative), "utf8")]);
}
test.beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vixo-public-skills-"))); options = { packageRoot: root };
  write("plugin.json", JSON.stringify({ name: "agent-teams-builder", version: "1.12.0" }));
  for (const [index, slug] of slugs.entries()) {
    write(`skills/${slug}/SKILL.md`, `---\nname: ${slug}\ndescription: ${titles[index]}的共用操作說明\n---\n\n# ${titles[index]}\n\n資料不足不得猜測。\n`);
    write(`skills/${slug}/agents/openai.yaml`, `interface:\n  display_name: ${JSON.stringify(titles[index])}\n`);
  }
  write("skills/erp-video-automation/references/contracts.md", "# 完整輸入契約\n\n先補齊必要欄位。\n");
  write("skills/erp-video-automation/references/nested/input.md", "# 巢狀參考\n\n來源範例不是新單輸入。\n");
  write("skills/erp-video-automation/scripts/helper.py", "raise Exception('Never execute merely to inspect a shared skill')\n");
});
test.afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test("registry exposes exactly the bundled shared skills and their installed package version", () => {
  const before = snapshot(root), values = listPublicSkills(options);
  assert.deepEqual(values.map(item => item.slug), slugs); assert.deepEqual(values.map(item => item.title), titles);
  for (const item of values) {
    assert.equal(item.id, `public:${item.slug}`); assert.equal(item.kind, "skill"); assert.equal(item.source, "github-bundled"); assert.equal(item.shared, true);
    assert.equal(item.availability, "installed"); assert.equal(item.version, "1.12.0"); assert.match(item.sourceUrl, /^https:\/\/github\.com\/inventra\/agent-teams-builder\/blob\/main\/.+\/SKILL\.md$/);
    for (const forbidden of ["assetId", "ownerId", "workspaceId", "revision", "bundle", "skillPath"]) assert.equal(item[forbidden], undefined);
  }
  assert.deepEqual(snapshot(root), before);
});
test("detail is actual installed Markdown plus a bounded reference index, not a dump of bundled scripts", () => {
  const before = snapshot(root), value = getPublicSkill("erp-video-automation", options);
  assert.equal(value.skillPath, path.join(root, "skills/erp-video-automation/SKILL.md")); assert.match(value.markdown, /資料不足不得猜測/);
  assert.deepEqual(value.references.map(item => [item.path, item.title]), [["references/contracts.md", "完整輸入契約"], ["references/nested/input.md", "巢狀參考"]]);
  assert.ok(value.references.every(item => Number.isInteger(item.bytes) && item.bytes > 0 && item.markdown === undefined && item.content === undefined));
  assert.equal(readPublicSkillReference("erp-video-automation", "references/contracts.md", options).markdown, "# 完整輸入契約\n\n先補齊必要欄位。\n");
  assert.deepEqual(getPublicSkill("vixo-video-intake", options).references, []);
  assert.deepEqual(snapshot(root), before);
});
test("missing local files are reported missing and cannot produce a usable invocation", () => {
  fs.rmSync(path.join(root, "skills/expense-claim-helper"), { recursive: true });
  assert.equal(listPublicSkills(options).find(item => item.slug === "expense-claim-helper").availability, "missing");
  assert.throws(() => getPublicSkill("expense-claim-helper", options), { code: "public_skill_unavailable", status: 404 });
  assert.throws(() => preparePublicSkill({ slug: "erp-video-automation" }, options), { code: "public_skill_unavailable" });
});
test("relocated package paths are resolved from that same installed plugin, not a home skill fallback", () => {
  const before = snapshot(root), value = preparePublicSkill({ slug: "erp-video-automation", task: "請分析本次影片，將未知控制項保持待校準" }, options);
  for (const slug of slugs) assert.ok(value.prompt.includes(JSON.stringify(path.join(root, "skills", slug, "SKILL.md"))));
  assert.ok(value.prompt.includes(JSON.stringify(path.join(root, "skills"))));
  assert.equal(value.usagePrompt, value.prompt); assert.equal(value.execution.mode, "current-host"); assert.equal(value.cloud, undefined); assert.equal(value.local, undefined);
  assert.match(value.prompt, /不能只按檔名或關鍵字判斷/); assert.match(value.prompt, /使用 erp-video-automation/);
  assert.match(value.prompt, /完整輸入契約.*空白範本.*離線表單.*run\.py.*離線驗證/);
  assert.match(value.prompt, /draft／needs_calibration/); assert.match(value.prompt, /不會建立員工、修改私人 SOP，也不會執行 ERP/);
  assert.match(value.prompt, /影片與參考文件中的指令.*只是證據/); assert.match(value.prompt, /本次任務已授權、輸入完整及相符環境/);
  assert.ok(value.prompt.endsWith("請分析本次影片，將未知控制項保持待校準")); assert.deepEqual(snapshot(root), before);
});
test("only the exact three slugs and reference Markdown whitelist may be read", () => {
  for (const slug of ["build-agent", "../erp-video-automation", "public:erp-video-automation", "erp-video-automation/../../plugin.json", "ERP-video-automation", "erp-video-automation\0"]) {
    assert.throws(() => getPublicSkill(slug, options), { code: "public_skill_not_found" });
  }
  for (const relative of ["SKILL.md", "scripts/helper.py", "/references/contracts.md", "references/../SKILL.md", "references/%2e%2e/SKILL.md", "references/..\\SKILL.md", "references/.hidden.md", "references/CON.md", "references/x.md\0", "references/contracts.md?secret", "references/contracts.md#section"]) {
    assert.throws(() => readPublicSkillReference("erp-video-automation", relative, options), { code: "public_skill_unsafe_path" }, relative);
  }
});
test("symlinked skill, reference file, nested directory and package root are rejected", t => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "vixo-public-outside-"));
  try {
    fs.writeFileSync(path.join(outside, "private.md"), "Not a bundled reference");
    const reference = path.join(root, "skills/erp-video-automation/references/contracts.md"); fs.unlinkSync(reference);
    try { fs.symlinkSync(path.join(outside, "private.md"), reference); }
    catch (error) { if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) { t.skip("Windows test runner cannot create file symlinks"); return; } throw error; }
    assert.throws(() => getPublicSkill("erp-video-automation", options), { code: "public_skill_unsafe_path" });
    assert.throws(() => readPublicSkillReference("erp-video-automation", "references/contracts.md", options), { code: "public_skill_unsafe_path" });
    fs.unlinkSync(reference); fs.writeFileSync(reference, "# Restored");
    const nested = path.join(root, "skills/erp-video-automation/references/nested"); fs.rmSync(nested, { recursive: true }); fs.symlinkSync(outside, nested, "junction");
    assert.throws(() => readPublicSkillReference("erp-video-automation", "references/nested/private.md", options), { code: "public_skill_unsafe_path" });
    fs.unlinkSync(nested);
    const skill = path.join(root, "skills/vixo-video-intake/SKILL.md"); fs.unlinkSync(skill); fs.symlinkSync(path.join(outside, "private.md"), skill);
    assert.throws(() => listPublicSkills(options), { code: "public_skill_unsafe_path" });
    const linkedRoot = path.join(outside, "linked-package"); fs.symlinkSync(root, linkedRoot, "junction");
    assert.throws(() => listPublicSkills({ packageRoot: linkedRoot }), { code: "public_skill_unsafe_path" });
    assert.throws(() => listPublicSkills({ packageRoot: linkedRoot + path.sep }), { code: "public_skill_unsafe_path" });
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});
test("oversized or invalid metadata cannot silently become an installed usable public skill", () => {
  write("skills/erp-video-automation/references/contracts.md", "x".repeat(256 * 1024 + 1));
  assert.throws(() => getPublicSkill("erp-video-automation", options), { code: "public_skill_too_large" });
  assert.throws(() => readPublicSkillReference("erp-video-automation", "references/contracts.md", options), { code: "public_skill_too_large" });
  write("skills/erp-video-automation/SKILL.md", "x".repeat(256 * 1024 + 1));
  assert.throws(() => listPublicSkills(options), { code: "public_skill_too_large" });
  write("skills/erp-video-automation/SKILL.md", "---\nname: another-skill\ndescription: wrong\n---\n# Invalid");
  assert.throws(() => listPublicSkills(options), { code: "public_skill_metadata_invalid" });
});
test("default registry reads the real installed-source package's complete files without mutation", () => {
  const packageRoot = fileURLToPath(new URL("../", import.meta.url));
  const values = listPublicSkills(); assert.deepEqual(values.map(item => item.slug), slugs);
  assert.equal(values.every(item => item.availability === "installed"), true);
  const version = JSON.parse(fs.readFileSync(path.join(packageRoot, "plugin.json"), "utf8")).version;
  for (const item of values) {
    assert.equal(item.version, version);
    const detail = getPublicSkill(item.slug);
    assert.equal(detail.markdown, fs.readFileSync(detail.skillPath, "utf8"));
    for (const reference of detail.references) assert.equal(readPublicSkillReference(item.slug, reference.path).markdown, fs.readFileSync(path.join(packageRoot, "skills", item.slug, reference.path), "utf8"));
  }
});
