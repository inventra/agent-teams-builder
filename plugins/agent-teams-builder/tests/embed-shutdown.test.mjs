// No desktop access: real bridge code runs only against our synthetic HTTP/WS peers.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { stopEmbed } from "../src/codex-embed.mjs";

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function poll(predicate, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (predicate()) return; await pause(20); }
  throw new Error("Isolated bridge did not reach the expected state");
}
async function cleanupChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL"); // Only the exact child created by this test, never a user's process.
  await exited;
}

test("stop acknowledgement must wait for the old bridge process to actually exit", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "vixo-stop-ack-"));
  const oldRoot = process.env.AGENT_TEAMS_HOME;
  process.env.AGENT_TEAMS_HOME = temporary;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import http from "node:http";
    const server=http.createServer((request,response)=>{
      response.writeHead(200,{"content-type":"application/json"});
      response.end(JSON.stringify({stopped:true}));
      server.close();
      // Simulate real cleanup that outlives the launcher's former 3-second cutoff.
      setTimeout(()=>{server.closeAllConnections();process.disconnect();},3400);
    });
    server.listen(0,"127.0.0.1",()=>process.send({port:server.address().port}));
  `], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  try {
    const [message] = await once(child, "message");
    fs.mkdirSync(path.join(temporary, ".system"), { recursive: true });
    fs.writeFileSync(path.join(temporary, ".system", "codex-embed-runtime.json"), JSON.stringify({
      pid: child.pid, controlPort: message.port, controlToken: "isolated-shutdown-token", mode: "codex-sidebar"
    }));
    const result = await stopEmbed();
    assert.equal(child.exitCode, 0, "a stop response is not process termination; the launcher must wait");
    assert.equal(result.stopped, true);
    assert.equal(fs.existsSync(path.join(temporary, ".system", "codex-embed-runtime.json")), false);
  } finally {
    await cleanupChild(child);
    if (oldRoot === undefined) delete process.env.AGENT_TEAMS_HOME; else process.env.AGENT_TEAMS_HOME = oldRoot;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

for (const [blockedRequest, stopMethod] of [
  ["status", "api"], ["initialize", "api"], ["status", "signal"], ["initialize", "signal"], ["status", "fallback"]
]) test("real daemon exits via " + stopMethod + " with a pending synthetic " + blockedRequest + " request", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "vixo-stop-pending-"));
  const oldRoot = process.env.AGENT_TEAMS_HOME;
  const system = path.join(temporary, ".system");
  fs.mkdirSync(system, { recursive: true });
  let statusRequests = 0, pending = false;
  const peer = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") response.end(JSON.stringify({ product: "vixo-agents" }));
    else if (request.url === "/json/list") response.end(JSON.stringify([{
      id: "isolated-renderer", type: "page", url: "app://fixture/index.html",
      webSocketDebuggerUrl: "ws://127.0.0.1:" + peer.address().port + "/fixture"
    }]));
    else response.writeHead(404).end();
  });
  const sockets = new WebSocketServer({ server: peer });
  sockets.on("connection", (socket) => socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    let result = {};
    if (blockedRequest === "initialize" && message.method === "Page.enable") { pending = true; return; }
    if (message.method === "Runtime.evaluate") {
      if (message.params.expression === "window.__vixoAgentsInjection__?.status?.() || null") {
        if (++statusRequests > 1) { pending = true; return; }
        result = { result: { value: { entryVisible: true, pageVisible: false, frameLoaded: false } } };
      } else result = { result: { type: "undefined" } };
    }
    // This peer acknowledges protocol data only; no UI or injected JS is executed.
    socket.send(JSON.stringify({ id: message.id, result }));
  }));
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const port = peer.address().port;
  fs.writeFileSync(path.join(system, "dashboard-runtime.json"), JSON.stringify({
    port, url: "http://127.0.0.1:" + port + "/?token=isolated-dashboard-token"
  }));
  const script = fileURLToPath(new URL("../scripts/vixo-codex-embed.mjs", import.meta.url));
  const child = spawn(process.execPath, [script, "daemon", "--port", String(port)], {
    env: { ...process.env, AGENT_TEAMS_HOME: temporary }, stdio: "ignore"
  });
  try {
    await poll(() => pending);
    const runtime = JSON.parse(fs.readFileSync(path.join(system, "codex-embed-runtime.json")));
    if (stopMethod === "fallback") {
      process.env.AGENT_TEAMS_HOME = temporary;
      fs.writeFileSync(path.join(system, "codex-embed-runtime.json"), JSON.stringify({ ...runtime, controlToken: "isolated-stale-token" }));
      const result = await stopEmbed({ timeoutMs: 1800 });
      assert.equal(result.forced, true);
    } else if (stopMethod === "signal") child.kill("SIGTERM"); // Exact test child only.
    else {
      const response = await fetch("http://127.0.0.1:" + runtime.controlPort + "/stop", {
        method: "POST", headers: { authorization: "Bearer " + runtime.controlToken }
      });
      assert.equal(response.ok, true);
      await response.json();
    }
    await poll(() => child.exitCode !== null, 1800);
    assert.equal(child.exitCode, 0);
    assert.equal(fs.existsSync(path.join(system, "codex-embed-runtime.json")), false);
  } finally {
    await cleanupChild(child);
    if (oldRoot === undefined) delete process.env.AGENT_TEAMS_HOME; else process.env.AGENT_TEAMS_HOME = oldRoot;
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("a stale runtime PID must never signal an unrelated process", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "vixo-stop-stale-pid-"));
  const oldRoot = process.env.AGENT_TEAMS_HOME;
  process.env.AGENT_TEAMS_HOME = temporary;
  const child = spawn(process.execPath, ["-e", 'setInterval(()=>{},1000);process.send({ready:true});'], {
    stdio: ["ignore", "ignore", "ignore", "ipc"]
  });
  try {
    await once(child, "message");
    fs.mkdirSync(path.join(temporary, ".system"), { recursive: true });
    fs.writeFileSync(path.join(temporary, ".system", "codex-embed-runtime.json"), JSON.stringify({ pid: child.pid }));
    await assert.rejects(stopEmbed({ timeoutMs: 100 }), /verify.*VIXO bridge/);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
  } finally {
    await cleanupChild(child);
    if (oldRoot === undefined) delete process.env.AGENT_TEAMS_HOME; else process.env.AGENT_TEAMS_HOME = oldRoot;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
