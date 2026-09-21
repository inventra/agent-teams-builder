import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commitPreview, createPreview, ensureAgentTeamsRoot, getAgent, listAgents, prepareRun } from "./store.mjs";

const skillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  triggers: z.array(z.string()),
  allowedTools: z.array(z.string()).optional(),
  steps: z.array(z.string()),
  successCriteria: z.array(z.string())
});

const agentSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  aliases: z.array(z.string()).optional(),
  description: z.string(),
  purpose: z.string(),
  systemPrompt: z.string(),
  memory: z.string().optional(),
  skills: z.array(skillSchema)
});

function result(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

function safe(handler) {
  return async (input) => {
    try { return result(await handler(input)); }
    catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }
  };
}

export function buildServer() {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const version = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
  const server = new McpServer({ name: "agent-teams-builder", version });
  server.registerTool("agent_preview", {
    title: "Preview Agent creation or update",
    description: "Validate and preview a complete Agent definition. This does not create or modify the Agent. Show the preview to the user and ask for explicit confirmation before calling agent_commit.",
    inputSchema: { action: z.enum(["create", "update"]), spec: agentSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  }, safe(createPreview));
  server.registerTool("agent_commit", {
    title: "Commit confirmed Agent preview",
    description: "Persist a previously previewed Agent only after the user explicitly confirms the displayed SOP. Pass the preview token and the user's confirmation text verbatim.",
    inputSchema: { token: z.string(), userConfirmation: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  }, safe(commitPreview));
  server.registerTool("agent_list", {
    title: "List local Agent Teams",
    description: "List Agents stored under the user's Downloads/Agent Teams directory.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, safe(() => ({ root: ensureAgentTeamsRoot(), agents: listAgents() })));
  server.registerTool("agent_get", {
    title: "Read one Agent",
    description: "Get an Agent by English id, Chinese display name, or exact alias.",
    inputSchema: { agent: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, safe(({ agent }) => getAgent(agent)));
  server.registerTool("agent_prepare_run", {
    title: "Prepare current-host execution",
    description: "Resolve an Agent and Skill and return the exact prompt/SOP for execution by the current Codex or Claude Code session. The plugin never calls a separate model API.",
    inputSchema: { agent: z.string(), task: z.string(), skill: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, safe(prepareRun));
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  ensureAgentTeamsRoot();
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
