import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";

const cdpPort = Number.parseInt(process.env.VIXO_CODEX_CDP_PORT || "", 10);

async function evaluate(target, expression) {
  const socket = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const result = await new Promise((resolve, reject) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id !== 1) return;
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    socket.send(JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression, awaitPromise: true, returnByValue: true },
    }));
  });
  socket.close();
  return result.result?.value;
}

test("Taskboard and VIXO sidebar entries keep a stable order", {
  skip: Number.isInteger(cdpPort) ? false : "set VIXO_CODEX_CDP_PORT to run the live Codex integration test",
}, async () => {
  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  const target = targets.find((item) => item.type === "page" && item.url === "app://-/index.html");
  assert.ok(target, "Codex main renderer is available");

  const result = await evaluate(target, `new Promise((resolve) => {
    const vixo = document.getElementById("vixo-agents-sidebar-entry");
    const taskboard = document.getElementById("codex-taskboard-entry");
    if (!vixo || !taskboard || vixo.parentElement !== taskboard.parentElement) {
      resolve({ error: "sidebar entries missing or have different parents" });
      return;
    }
    const parent = vixo.parentElement;
    const order = () => Array.from(parent.children)
      .filter((node) => node === taskboard || node === vixo)
      .map((node) => node.id)
      .join(">");
    const orders = [order()];
    const observer = new MutationObserver(() => orders.push(order()));
    observer.observe(parent, { childList: true });
    setTimeout(() => {
      observer.disconnect();
      const transitions = orders.reduce(
        (count, item, index) => count + (index > 0 && item !== orders[index - 1] ? 1 : 0),
        0,
      );
      resolve({ orders, transitions });
    }, 1_500);
  })`);

  assert.equal(result?.error, undefined, result?.error);
  assert.deepEqual([...new Set(result.orders)], ["codex-taskboard-entry>vixo-agents-sidebar-entry"]);
  assert.equal(result.transitions, 0, `sidebar order changed ${result.transitions} times`);
});
