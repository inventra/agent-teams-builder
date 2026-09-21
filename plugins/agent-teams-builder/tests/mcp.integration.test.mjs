import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP stdio handshake and complete preview/commit/list/prepare flow", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mcp-test-"));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverPath = path.join(here, "..", "src", "server.mjs");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, AGENT_TEAMS_HOME: temporary }
  });
  const client = new Client({ name: "agent-teams-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["agent_commit", "agent_get", "agent_list", "agent_prepare_run", "agent_preview", "agent_run_sdk"]);
    const preview = await client.callTool({
      name: "agent_preview",
      arguments: {
        action: "create",
        spec: {
          id: "social-editor",
          displayName: "社群小編",
          aliases: ["小編"],
          description: "管理社群工作",
          purpose: "依照確認過的流程處理社群任務",
          systemPrompt: "先確認平台與內容，不可未經同意直接發布。",
          memory: "使用繁體中文。",
          skills: [
            {
              id: "find-keywords",
              name: "尋找關鍵字",
              description: "整理社群關鍵字",
              triggers: ["關鍵字"],
              allowedTools: ["WebSearch"],
              steps: ["確認主題", "搜尋資料", "整理關鍵字"],
              successCriteria: ["提供來源", "未發布貼文"]
            },
            {
              id: "draft-facebook-post",
              name: "撰寫 FB 貼文",
              description: "依素材草擬貼文",
              triggers: ["FB 貼文"],
              allowedTools: [],
              steps: ["讀取素材", "草擬貼文", "等待確認"],
              successCriteria: ["貼文可供審核", "未直接發布"]
            }
          ]
        }
      }
    });
    assert.equal(preview.isError, undefined);
    assert.equal(preview.structuredContent.spec.skills.length, 2);
    const committed = await client.callTool({ name: "agent_commit", arguments: { token: preview.structuredContent.token, userConfirmation: "確認建立社群小編" } });
    assert.equal(committed.structuredContent.version, 1);
    const listed = await client.callTool({ name: "agent_list", arguments: {} });
    assert.equal(listed.structuredContent.agents[0].skills.length, 2);
    const prepared = await client.callTool({ name: "agent_prepare_run", arguments: { agent: "小編", task: "幫我找關鍵字" } });
    assert.equal(prepared.structuredContent.skill.id, "find-keywords");
  } finally {
    await client.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
