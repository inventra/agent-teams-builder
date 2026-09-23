#!/usr/bin/env node
import {
  daemonMain,
  embedStatus,
  runOnce,
  startEmbed,
  stopEmbed,
} from "../src/codex-embed.mjs";

const args = process.argv.slice(2);
const command = args[0] || "open";
const portIndex = args.indexOf("--port");
const explicitPort = portIndex >= 0 ? Number(args[portIndex + 1]) : null;
const shouldOpen = args.includes("--open") || command === "open" || command === "once";

try {
  let result;
  if (command === "daemon") result = await daemonMain({ explicitPort, shouldOpen });
  else if (command === "stop") result = await stopEmbed();
  else if (command === "status") result = await embedStatus();
  else if (command === "once") result = await runOnce({ explicitPort, open: shouldOpen });
  else result = await startEmbed({ explicitPort, open: shouldOpen });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`VIXO Codex embed failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
