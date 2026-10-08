import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { commitPreview, createPreview, ensureAgentTeamsRoot, getAgent, listAgents, prepareRun, prepareWorkflowRun } from "./store.mjs";
import { cloudStatus, cloudClient, cloudSync, listSourceAgents, getSourceAgent, prepareSourceRun, previewSourceAgent, commitSourcePreview, previewLocalPublish, libraryState, syncLibrary, previewLibraryEntry, resolveLibraryConflict, enableLibrarySync, requireAccount, assertAccount } from './cloud-service.mjs';

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
  skills: z.array(skillSchema),
  workflows: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    triggers: z.array(z.string()).optional(),
    nodes: z.array(z.object({
      id: z.string(),
      name: z.string(),
      type: z.enum(["skill", "tool", "approval", "manual"]),
      skillId: z.string().nullable().optional(),
      instructions: z.string(),
      requiresApproval: z.boolean().optional()
    }))
  })).optional()
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
    inputSchema: { action: z.enum(["create", "update"]), spec: agentSchema, cloudAssetId: z.string().optional(), expectedRevision: z.number().int().positive().optional(), workspaceId: z.string().nullable().optional(), syncMode: z.enum(["local-only", "cloud"]).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  }, safe(previewSourceAgent));
  server.registerTool("agent_commit", {
    title: "Commit confirmed Agent preview",
    description: "Persist a previously previewed Agent only after the user explicitly confirms the displayed SOP. Pass the preview token and the user's confirmation text verbatim.",
    inputSchema: { token: z.string(), userConfirmation: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  }, safe(commitSourcePreview));
  server.registerTool("agent_list", {
    title: "List VIXO Agent Teams",
    description: "Sign in first. List this approved account’s merged local drafts and authorized cloud Agents from the local library, with background version synchronization.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, safe(async () => {
    const state = await requireAccount({ allowOffline: true }), agents = await listSourceAgents();
    assertAccount(state.user.id);
    return { ...state, agents };
  }));
  server.registerTool("agent_get", {
    title: "Read one Agent",
    description: "Get an Agent by English id, Chinese display name, or exact alias.",
    inputSchema: { agent: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, safe(({ agent }) => getSourceAgent(agent)));
  server.registerTool("agent_prepare_run", {
    title: "Prepare current-host execution",
    description: "Resolve an Agent and Skill and return the exact prompt/SOP for execution by the current Codex or Claude Code session. The plugin never calls a separate model API.",
    inputSchema: { agent: z.string(), task: z.string(), skill: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, safe((input) => prepareSourceRun(input)));
  server.registerTool("workflow_prepare_run", {
    title: "Prepare a Workflow for host-native execution",
    description: "Resolve one saved Workflow and return its ordered node plan and exact prompt for Codex or Claude Code. No model API is called.",
    inputSchema: { agent: z.string(), workflow: z.string(), task: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, safe((input) => prepareSourceRun(input, true)));
  server.registerTool('cloud_status', { title: 'VIXO cloud connection', description: 'Read this device cloud connection status without returning credentials.', inputSchema: {}, annotations: { readOnlyHint: true } }, safe(cloudStatus));
  server.registerTool('cloud_list', { title: 'List shared cloud content', description: 'List authorized Agent, Skill and Workflow cloud packages.', inputSchema: {}, annotations: { readOnlyHint: true } }, safe(libraryState));
  server.registerTool('cloud_preview_publish', {
    title: 'Preview local content for cloud publication', description: 'Package a local Agent or one Skill/Workflow with dependencies. Show the full preview and obtain explicit confirmation before agent_commit. Personal memory and run data are excluded.',
    inputSchema: { agent: z.string(), kind: z.enum(['agent', 'skill', 'workflow']).default('agent'), skillId: z.string().optional(), workflowId: z.string().optional(), workspaceId: z.string().nullable().optional(), id: z.string().optional(), expectedRevision: z.number().int().nonnegative().optional() }
  }, safe(previewLocalPublish));
  server.registerTool('cloud_prepare_run', {
    title: 'Prepare a cloud Agent, Skill or Workflow', description: 'Verify current cloud permissions, reuse an unchanged verified local version or download a changed version, and return a host-native execution prompt. Execute prepared.prompt in the current session. This does not grant extra ERP or external action permissions.',
    inputSchema: { assetId: z.string(), revision: z.number().int().positive().optional(), task: z.string(), skill: z.string().optional(), workflow: z.string().optional() }, annotations: { readOnlyHint: true }
  }, safe((input) => cloudSync().prepareAssetRun(input)));
  server.registerTool('cloud_create_device_code', { title: 'Connect another personal device', description: 'Create a one-time ten-minute code for the SAME personal cloud identity on another device. Use only when the user asks to connect their own device; do not use this for coworker sharing.', inputSchema: {} }, safe(() => cloudClient().createDeviceCode()));
  server.registerTool('cloud_create_workspace', { title: 'Create a VIXO team space', description: 'Create a team sharing space owned by the currently connected identity.', inputSchema: { name: z.string() } }, safe(({ name }) => cloudClient().createWorkspace(name)));
  server.registerTool('cloud_create_invite', { title: 'Invite a coworker', description: 'Create a team invitation code. viewer can use/copy; editor can also publish shared versions. Return the code to the user; do not send messages to others.', inputSchema: { workspaceId: z.string(), role: z.enum(['viewer', 'editor']).default('viewer') } }, safe(({ workspaceId, role }) => cloudClient().createInvite(workspaceId, role)));
  server.registerTool('library_sync', { title: 'Synchronize the local VIXO library', description: 'After sign-in, compare cloud revisions and flush previously confirmed local changes. Conflicting or uncertain writes are preserved; this never silently overwrites them.', inputSchema: {}, annotations: { destructiveHint: false } }, safe(() => syncLibrary({ force: true })));
  server.registerTool('library_preview', { title: 'Preview a local Agent, Skill or Workflow edit', description: 'Validate and display the entire portable bundle before saving. Obtain explicit confirmation of content and sharing scope before library_commit.', inputSchema: { id: z.string().optional(), bundle: z.record(z.string(), z.unknown()), title: z.string().optional(), description: z.string().optional(), workspaceId: z.string().nullable().optional(), syncMode: z.enum(["local-only", "cloud"]).optional() } }, safe(previewLibraryEntry));
  server.registerTool('library_enable_sync', { title: 'Enable cloud synchronization for a local draft', description: 'Show the complete local bundle and private/team scope, then require explicit confirmation before enabling upload. Pass both current bundleHash and localHash to prevent stale approval.', inputSchema: { id: z.string(), expectedHash: z.string(), expectedLocalHash: z.string(), userConfirmation: z.string() } }, safe(enableLibrarySync));
  server.registerTool('library_commit', { title: 'Save a confirmed local edit', description: 'Persist the confirmed preview locally. New items default to local-only; only explicitly enabled cloud items queue background synchronization. Report saved-local or queued accurately.', inputSchema: { token: z.string(), userConfirmation: z.string() } }, safe(commitSourcePreview));
  server.registerTool('library_resolve', { title: 'Resolve a reviewed synchronization conflict', description: 'After showing both versions and receiving explicit confirmation, keep the cloud version or save the local work as a separate copy. No force overwrite.', inputSchema: { id: z.string(), resolution: z.enum(['remote', 'copy']), userConfirmation: z.string(), expectedHash: z.string(), remoteRevision: z.number().int().positive().nullable().optional() } }, safe(resolveLibraryConflict));
  server.registerTool("dashboard_open", {
    title: "Open the VIXO Agents Dashboard",
    description: "Start the local visual Agent, Skill, Workflow, run, and schedule dashboard, then open it in the user's browser.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  }, safe(() => {
    const script = path.join(packageRoot, "scripts", "vixo-agents-dashboard.mjs");
    const run = spawnSync(process.execPath, [script, "open"], { encoding: "utf8", env: process.env, windowsHide: true });
    if (run.status !== 0) throw new Error((run.stderr || run.stdout || "Unable to open VIXO Agents Dashboard").trim());
    return JSON.parse(run.stdout);
  }));
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  ensureAgentTeamsRoot();
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
