import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commitPreview, createPreview, ensureAgentTeamsRoot, getAgent, listAgents, prepareRun } from "./store.mjs";
import { runWithClaudeAgentSdk } from "./sdk-runner.mjs";

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
  const server = new McpServer({ name: "agent-teams-builder", version: "1.0.4" });
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
    title: "Prepare host execution",
    description: "Resolve an Agent and Skill and return the exact prompt/SOP for execution with the current host session's tools.",
    inputSchema: { agent: z.string(), task: z.string(), skill: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, safe(prepareRun));
  server.registerTool("agent_run_sdk", {
    title: "Run through Anthropic Claude Agent SDK",
    description: "Execute a saved Agent with the Anthropic Claude Agent SDK. Requires ANTHROPIC_API_KEY or supported provider credentials. Prefer agent_prepare_run when the current host must provide Computer Use or Browser tools.",
    inputSchema: { agent: z.string(), task: z.string(), skill: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  }, safe(runWithClaudeAgentSdk));
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  ensureAgentTeamsRoot();
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
