import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commitPreview, createPreview, getAgent, listAgents, prepareRun } from "../src/store.mjs";

function spec(overrides = {}) {
  return {
    id: "booking",
    displayName: "小美",
    aliases: ["航班查詢機器人"],
    description: "查詢航班的助理",
    purpose: "查詢指定航線與日期的可用航班",
    systemPrompt: "只依照使用者提供的日期與地點查詢，不自行購票。",
    memory: "偏好繁體中文回覆。",
    skills: [{
      id: "search-flights",
      name: "查詢航班",
      description: "查詢出發地到目的地的班機",
      triggers: ["查班機", "航班"],
      allowedTools: ["WebSearch", "WebFetch"],
      steps: ["確認出發地、目的地與日期", "查詢航空公司網站", "整理航班資訊"],
      successCriteria: ["列出可核對的航班編號與時間", "未進行購票"]
    }],
    ...overrides
  };
}

test.beforeEach(() => {
  process.env.AGENT_TEAMS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-teams-test-"));
});

test.afterEach(() => {
  fs.rmSync(process.env.AGENT_TEAMS_HOME, { recursive: true, force: true });
  delete process.env.AGENT_TEAMS_HOME;
});

test("requires preview then explicit commit and writes full Agent structure", () => {
  const preview = createPreview({ action: "create", spec: spec() });
  assert.equal(listAgents().length, 0);
  const saved = commitPreview({ token: preview.token, userConfirmation: "確認，請建立" });
  assert.equal(saved.version, 1);
  assert.equal(getAgent("小美").id, "booking");
  for (const relative of ["agent.json", "AGENT.md", "MEMORY.md", "skills/search-flights/SKILL.md", "history/revisions.jsonl"]) {
    assert.ok(fs.existsSync(path.join(saved.directory, relative)), relative);
  }
  assert.throws(() => commitPreview({ token: preview.token, userConfirmation: "確認，再次提交" }), /already used/);
});

test("updates preserve creation time and increment version", () => {
  const first = createPreview({ action: "create", spec: spec() });
  commitPreview({ token: first.token, userConfirmation: "確認" });
  const original = getAgent("booking");
  const second = createPreview({ action: "update", spec: spec({ purpose: "新版用途" }) });
  commitPreview({ token: second.token, userConfirmation: "確認修改" });
  const updated = getAgent("booking");
  assert.equal(updated.version, 2);
  assert.equal(updated.createdAt, original.createdAt);
  assert.equal(updated.purpose, "新版用途");
});

test("removed skills are archived instead of left active", () => {
  const multi = spec({
    skills: [
      ...spec().skills,
      {
        id: "draft-ticket",
        name: "草擬訂票資料",
        description: "只草擬不送出",
        triggers: ["草擬"],
        allowedTools: [],
        steps: ["整理資料"],
        successCriteria: ["未送出"]
      }
    ]
  });
  const first = createPreview({ action: "create", spec: multi });
  const saved = commitPreview({ token: first.token, userConfirmation: "確認建立" });
  const second = createPreview({ action: "update", spec: spec() });
  commitPreview({ token: second.token, userConfirmation: "確認修改" });
  assert.equal(fs.existsSync(path.join(saved.directory, "skills", "draft-ticket")), false);
  const archived = path.join(saved.directory, "history", "removed-skills");
  assert.ok(fs.readdirSync(archived).some((timestamp) => fs.existsSync(path.join(archived, timestamp, "draft-ticket", "SKILL.md"))));
});

test("rejects traversal and unsupported ids", () => {
  assert.throws(() => createPreview({ action: "create", spec: spec({ id: "../escape" }) }), /kebab-case/);
  assert.throws(() => createPreview({ action: "create", spec: spec({ id: "中文" }) }), /kebab-case/);
});

test("rejects ambiguous confirmation and likely secrets", () => {
  const preview = createPreview({ action: "create", spec: spec() });
  assert.throws(() => commitPreview({ token: preview.token, userConfirmation: "不要建立" }), /not explicitly affirmative/);
  assert.throws(() => createPreview({ action: "create", spec: spec({ memory: "sk-ant-this-is-a-secret-token-123456" }) }), /Potential secret/);
});

test("routes a task to the matching skill for current-host execution", () => {
  const preview = createPreview({ action: "create", spec: spec() });
  commitPreview({ token: preview.token, userConfirmation: "確認" });
  const prepared = prepareRun({ agent: "航班查詢機器人", task: "幫我查班機" });
  assert.equal(prepared.skill.id, "search-flights");
  assert.equal(prepared.execution.mode, "current-host");
  assert.deepEqual(prepared.execution.supportedHosts, ["codex", "claude-code"]);
  assert.match(prepared.execution.instruction, /Do not call a separate model API/);
  assert.equal(prepared.agent.framework.modelApiRequired, false);
});
