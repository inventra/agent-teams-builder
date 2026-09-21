#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureAgentTeamsRoot, getAgent, listAgents, prepareRun } from "../src/store.mjs";
import { runWithClaudeAgentSdk } from "../src/sdk-runner.mjs";

const command = process.argv[2] || "help";
const args = process.argv.slice(3);

function output(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function packageVersion(name) {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const packagePath = path.join(here, "..", "node_modules", name, "package.json");
    return JSON.parse(fs.readFileSync(packagePath, "utf8")).version;
  } catch { return null; }
}

if (command === "doctor") {
  const root = ensureAgentTeamsRoot();
  output({
    ok: true,
    root,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    claudeAgentSdk: packageVersion("@anthropic-ai/claude-agent-sdk"),
    mcpSdk: packageVersion("@modelcontextprotocol/sdk"),
    sdkCredentialConfigured: Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_USE_BEDROCK || process.env.CLAUDE_CODE_USE_VERTEX || process.env.CLAUDE_CODE_USE_FOUNDRY || process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS),
    agentCount: listAgents().length
  });
} else if (command === "list") {
  output({ root: ensureAgentTeamsRoot(), agents: listAgents() });
} else if (command === "get") {
  output(getAgent(args.join(" ")));
} else if (command === "prepare") {
  output(prepareRun({ agent: args[0], task: args.slice(1).join(" ") }));
} else if (command === "run") {
  output(await runWithClaudeAgentSdk({ agent: args[0], task: args.slice(1).join(" ") }));
} else {
  process.stdout.write("Agent Teams CLI\n\nCommands: doctor | list | get <agent> | prepare <agent> <task> | run <agent> <task>\n");
}
