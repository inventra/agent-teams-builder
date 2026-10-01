import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!process.argv[2] || !process.argv[3]) throw new Error("Usage: node scripts/build-workbench-resources.mjs <mindmap.html> <prototype.html>");
const mindmap = fs.readFileSync(process.argv[2], "utf8");
const prototype = fs.readFileSync(process.argv[3], "utf8");
const match = mindmap.match(/const DEFAULT_TREE=(\{[^\n]+\});/);
if (!match) throw new Error("DEFAULT_TREE JSON not found");
const tree = JSON.parse(match[1]);
const image = prototype.match(/<img id="o-bg" src="(data:image\/webp;base64,[^"]+)"/)?.[1];
if (!image) throw new Error("Office reference image not found");

const delivered = new Map([
  ["n009", "真實 Workflow 待核數量；企業核決規則後續"],
  ["n010", "讀取真實 waiting-approval 紀錄"],
  ["n016", "真實期間執行與結果；原生任務開啟不計成功"],
  ["n017", "讀取完整執行紀錄，不限最近 30 筆"],
  ["n020", "今天／本週／本月真實執行彙總；外部資料尚未串接"],
  ["n021", "本地時區日、週、月範圍"],
  ["n095", "背景 Workflow 核准／拒絕與理由；原生任務回 Codex"],
  ["n096", "沿用 Workflow 核准／拒絕紀錄"],
  ["n105", "真實執行失敗、等待補資料與核准；不推算卡住時數"],
  ["n106", "已知 run 狀態監控，不偽造逐節點進度"],
  ["n107", "檢視錯誤與明確重新 Play；不自動重試外部寫入"],
  ["n125", "唯讀 VIXO Agent 登錄；不混用 LazyOffice"],
  ["n127", "Play、結果摘要、Codex 任務連結；不存在的證據不補造"],
  ["n128", "沿用現有 Workflow 執行引擎"],
  ["n129", "安全執行詳情與摘要"],
  ["n141", "真實 run 狀態、Agent 與等待節點；人員分工監控後續"],
  ["n142", "沿用現有 Workflow 引擎"],
  ["n144", "顯示既有需核准節點；編輯 SOP 仍須 preview/Double Check/commit"],
  ["n147", "每日排程；週排程後續"],
  ["n167", "經典／像素、主題共用資料及持久保存；其他介面後續"],
  ["n168", "卡片增減、排序、縮放及換色"],
  ["n169", "VIXO 獨立偏好儲存"]
]);
const external = /Outlook|Planner|SharePoint|OneDrive|Teams|LINE Notify|LINE Messaging|ERP|鼎新|Entra|Google 同步|身分系統|OAuth|365|資料型態|權限中心/;
const rows = [];
function walk(node, ancestors = [], module = null) {
  const currentModule = module || (ancestors.length === 1 ? node.name : null);
  if (node.id !== "root") {
    const text = node.name + " " + (node.note || "");
    const status = delivered.has(node.id) ? "首版完成" : external.test(text) ? "待串接" : "後續規劃";
    const source = node.id === "n110" ? "LINE Messaging API（取代已停用 LINE Notify）" : node.note || (node.kind === "fn" ? node.name : "下層功能與對應模組");
    rows.push({
      id: node.id, kind: node.kind, module: currentModule, name: node.name,
      path: ancestors.concat(node.name).join(" → "), source, status,
      screen: "Docs › " + currentModule,
      notes: delivered.get(node.id) || (status === "待串接" ? "需正式帳號、權限與資料來源；不得使用示例規則" : "完整保留藍圖；不列入第一版可用功能"),
      acceptance: delivered.has(node.id) ? "workbench API / model / browser regression" : "後續功能驗收；目前檢查狀態揭露"
    });
  }
  for (const child of node.children || []) walk(child, ancestors.concat(node.name), currentModule);
}
walk(tree);
if (rows.length !== 173 || rows.filter((row) => row.kind === "ui").length !== 79) throw new Error("Unexpected mindmap inventory");

function applyFile(relative, contents) {
  const target = path.join(root, relative);
  const existing = fs.existsSync(target);
  const patch = existing
    ? "*** Begin Patch\n*** Delete File: " + target + "\n*** Add File: " + target + "\n" + contents.replace(/\n+$/, "").split("\n").map((line) => "+" + line).join("\n") + "\n*** End Patch\n"
    : "*** Begin Patch\n*** Add File: " + target + "\n" + contents.replace(/\n+$/, "").split("\n").map((line) => "+" + line).join("\n") + "\n*** End Patch\n";
  const result = spawnSync("apply_patch", [], { input: patch, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}
applyFile("plugins/agent-teams-builder/web/office-background.js", "export const officeBackground = " + JSON.stringify(image) + ";\n");
applyFile("plugins/agent-teams-builder/web/workbench-capabilities.json", JSON.stringify({ source: "VIXO 介面 → 基礎功能（可編輯）.html / DEFAULT_TREE", count: rows.length, ui: 79, fn: 94, modules: tree.children.map((node) => ({ id: node.id, name: node.name })), nodes: rows }, null, 2) + "\n");
const columns = ["id", "kind", "module", "name", "status", "screen", "source", "notes", "acceptance"];
const csv = "\uFEFF" + [columns, ...rows.map((row) => columns.map((key) => row[key]))]
  .map((values) => values.map((value) => '"' + String(value).replaceAll('"', '""') + '"').join(",")).join("\n") + "\n";
applyFile("docs/VIXO-Docs-功能對照表.csv", csv);
applyFile("docs/VIXO-Docs-功能對照表.md", "# VIXO Docs 功能對照表\n\n來源：附件內嵌 DEFAULT_TREE；173 個非根節點（79 UI、94 FN）。\n\n「首版完成」只對應備註中的已交付範圍，不代表外部連線或整個上層模組完成。LINE Notify 名稱保留來源，實際規劃改為 LINE Messaging API。\n\n| ID | 類型 | 功能 | 狀態 | 畫面 | 資料來源 | 範圍／驗收 |\n| --- | --- | --- | --- | --- | --- | --- |\n" +
  rows.map((row) => "| " + [row.id, row.kind, row.name, row.status, row.screen, row.source, row.notes + "；" + row.acceptance]
    .map((value) => value.replaceAll("|", "／").replaceAll("\n", " ")).join(" | ") + " |").join("\n") + "\n");
console.log(JSON.stringify({ generatedNodes: rows.length, ui: 79, fn: 94, reusedOfficeImage: true }));
