import { query } from "@anthropic-ai/claude-agent-sdk";
import { prepareRun, agentTeamsRoot } from "./store.mjs";

export async function runWithClaudeAgentSdk(input) {
  const prepared = prepareRun(input);
  if (process.env.AGENT_TEAMS_SDK_MOCK === "1") {
    return {
      mode: "sdk-mock",
      agent: prepared.agent.displayName,
      skill: prepared.skill.name,
      result: `MOCK:${prepared.task}`,
      messages: 1
    };
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_USE_BEDROCK && !process.env.CLAUDE_CODE_USE_VERTEX && !process.env.CLAUDE_CODE_USE_FOUNDRY && !process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS) {
    throw new Error("Anthropic Claude Agent SDK requires ANTHROPIC_API_KEY or a supported cloud-provider configuration. Use host mode if no SDK credential is configured.");
  }
  const allowedTools = prepared.skill.allowedTools.length
    ? prepared.skill.allowedTools
    : ["Read", "Glob", "Grep", "WebSearch", "WebFetch"];
  const text = [];
  let messages = 0;
  for await (const message of query({
    prompt: prepared.prompt,
    options: {
      cwd: agentTeamsRoot(),
      allowedTools,
      permissionMode: "default",
      settingSources: ["user", "project"],
      maxTurns: 30
    }
  })) {
    messages += 1;
    if (message?.type === "assistant" && Array.isArray(message.message?.content)) {
      for (const block of message.message.content) if (block?.type === "text") text.push(block.text);
    }
    if (message?.type === "result" && typeof message.result === "string") text.push(message.result);
  }
  return {
    mode: "sdk",
    agent: prepared.agent.displayName,
    skill: prepared.skill.name,
    result: text.join("\n").trim(),
    messages
  };
}
