let storedToken = "";
try { storedToken = sessionStorage.getItem("vixo-token") || ""; } catch {}
const token = globalThis.__VIXO_AGENTS_EMBED_TOKEN__ || new URLSearchParams(location.search).get("token") || storedToken;
try { if (token) sessionStorage.setItem("vixo-token", token); } catch {}
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let state = null;
let selected = "all";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]);
const toast = (message) => { const el=document.querySelector("#toast"); el.textContent=message; el.classList.add("show"); setTimeout(()=>el.classList.remove("show"),2600); };

async function api(path, options={}) {
  const response = await fetch(path, { ...options, headers: { ...headers, ...(options.headers||{}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function renderNav() {
  const nav=document.querySelector("#agent-nav");
  nav.innerHTML=`<button class="nav-item ${selected==="all"?"active":""}" data-id="all">員工總覽<span>${state.agents.length} 位員工</span></button>`+state.agents.map(agent=>`<button class="nav-item ${selected===agent.id?"active":""}" data-id="${esc(agent.id)}">${esc(agent.displayName)}<span>${agent.skills.length} Skills · ${(agent.workflows||[]).length} Workflows</span></button>`).join("");
  nav.querySelectorAll("button").forEach(button=>button.onclick=()=>{selected=button.dataset.id;render();});
}

function workflowCard(agent, workflow) {
  const hostAvailable=state.hosts.codex||state.hosts.claude;
  return `<article class="workflow"><div class="workflow-top"><div><h4>${esc(workflow.name)}</h4><p>${esc(workflow.description)}</p></div><div class="actions"><button class="secondary schedule" data-agent="${esc(agent.id)}" data-workflow="${esc(workflow.id)}" ${hostAvailable?"":"disabled"}>排程</button><button class="primary play" data-agent="${esc(agent.id)}" data-workflow="${esc(workflow.id)}" ${hostAvailable?"":"disabled"}>▶ Play</button></div></div><div class="nodes">${workflow.nodes.map(node=>`<div class="node ${esc(node.type)}"><span class="node-type">${esc(node.type)}</span><strong>${esc(node.name)}</strong><small>${esc(node.skillId?`Skill · ${node.skillId}`:node.instructions)}</small>${node.requiresApproval?'<span class="tag">需確認</span>':''}</div>`).join("")}</div></article>`;
}

function employeeCard(agent) {
  return `<article class="employee"><div class="employee-head"><div class="employee-title"><div class="avatar">${esc(agent.displayName.slice(0,1))}</div><div><h3>${esc(agent.displayName)}</h3><p>${esc(agent.description)}</p><span class="tag">${esc(agent.id)}</span><span class="tag">v${esc(agent.version)}</span></div></div></div><div class="employee-body"><div class="eyebrow">SKILLS</div><div class="skills">${agent.skills.map(skill=>`<span class="skill">${esc(skill.name)}</span>`).join("")}</div><div class="eyebrow">WORKFLOWS</div>${(agent.workflows||[]).length?(agent.workflows||[]).map(workflow=>workflowCard(agent,workflow)).join(""):'<p>尚未建立 Workflow。請在 Session 中說「替這位員工加上 Workflow」。</p>'}</div></article>`;
}

function renderRuns() {
  if (!state.runs.length) return "";
  const labels={"running":"執行中","waiting-input":"等待輸入","waiting-approval":"等待核准","completed":"已完成","failed":"失敗","rejected":"已拒絕"};
  return `<section class="runs"><div class="eyebrow">RECENT RUNS</div><div class="employee"><div class="employee-body">${state.runs.slice(0,8).map(run=>{
    const detail=run.lastMessage?`<p class="run-message">${esc(run.lastMessage)}</p>`:"";
    let controls="";
    if(run.status==="waiting-input") controls=run.resumable?`<button class="secondary reply-run" data-run="${esc(run.id)}">回覆並繼續</button>`:`<span class="legacy-note">舊版紀錄無法續跑，請重新 Play</span>`;
    if(run.status==="waiting-approval") controls=run.resumable?`<button class="secondary reject-run" data-run="${esc(run.id)}">拒絕</button><button class="primary approve-run" data-run="${esc(run.id)}">核准並繼續</button>`:`<span class="legacy-note">舊版紀錄無法續跑，請重新 Play</span>`;
    return `<div class="run"><div><strong>${esc(run.agentName||run.agentId)} · ${esc(run.workflowName||run.workflowId)}</strong><p>${esc(run.host)} · ${esc(new Date(run.startedAt).toLocaleString())}${run.approvalMode==="auto"?" · 本次自動核准":""}</p>${run.pendingNodeName?`<p>待核准：${esc(run.pendingNodeName)}</p>`:""}${detail}</div><div class="run-side"><span class="status ${esc(run.status)}">${esc(labels[run.status]||run.status)}</span><div class="run-actions">${controls}</div></div></div>`;
  }).join("")}</div></div></section>`;
}

function bindActions() {
  document.querySelectorAll(".play").forEach(button=>button.onclick=()=>{
    const form=document.querySelector("#run-form");form.elements.agent.value=button.dataset.agent;form.elements.workflow.value=button.dataset.workflow;
    form.elements.host.value=state.hosts.codex?"codex":"claude";document.querySelector("#run-dialog").showModal();
  });
  document.querySelectorAll(".schedule").forEach(button=>button.onclick=()=>{
    const form=document.querySelector("#schedule-form");form.elements.agentId.value=button.dataset.agent;form.elements.workflowId.value=button.dataset.workflow;
    form.elements.host.value=state.hosts.codex?"codex":"claude";document.querySelector("#schedule-dialog").showModal();
  });
  document.querySelectorAll(".reply-run").forEach(button=>button.onclick=async()=>{const message=prompt("回覆 Agent 需要的資料：");if(!message)return;try{await api(`/api/runs/${encodeURIComponent(button.dataset.run)}/reply`,{method:"POST",body:JSON.stringify({message})});toast("已回覆，Workflow 繼續執行");await load();}catch(error){toast(error.message);}});
  document.querySelectorAll(".approve-run").forEach(button=>button.onclick=async()=>{const message=prompt("核准說明：","我確認核准這個節點，請繼續執行。");if(!message)return;try{await api(`/api/runs/${encodeURIComponent(button.dataset.run)}/approve`,{method:"POST",body:JSON.stringify({message})});toast("已核准，Workflow 繼續執行");await load();}catch(error){toast(error.message);}});
  document.querySelectorAll(".reject-run").forEach(button=>button.onclick=async()=>{if(!confirm("確定拒絕並停止這次 Workflow？"))return;try{await api(`/api/runs/${encodeURIComponent(button.dataset.run)}/reject`,{method:"POST",body:JSON.stringify({message:"使用者在 Dashboard 拒絕核准"})});toast("已拒絕這次執行");await load();}catch(error){toast(error.message);}});
}

function render() {
  renderNav();
  const agents=selected==="all"?state.agents:state.agents.filter(agent=>agent.id===selected);
  const skillCount=state.agents.reduce((sum,agent)=>sum+agent.skills.length,0), workflowCount=state.agents.reduce((sum,agent)=>sum+(agent.workflows||[]).length,0), scheduled=state.schedules.filter(item=>item.enabled).length;
  document.querySelector("#summary").innerHTML=[[state.agents.length,"已訓練員工"],[skillCount,"Skills"],[workflowCount,"Workflows"],[scheduled,"自動排程"]].map(([n,label])=>`<div class="metric"><b>${n}</b><span>${label}</span></div>`).join("");
  const selectedAgent=state.agents.find(agent=>agent.id===selected);document.querySelector("#page-title").textContent=selectedAgent?selectedAgent.displayName:"員工總覽";
  document.querySelector("#page-subtitle").textContent=selectedAgent?selectedAgent.purpose:"把訓練結果、技能與執行流程放在同一個畫面。";
  document.querySelector("#content").innerHTML=agents.length?agents.map(employeeCard).join("")+renderRuns():'<div class="empty"><h2>還沒有員工</h2><p>在 Codex 或 Claude Code 完成一段流程後，說「幫我變成一個員工」。</p></div>';
  document.querySelector("#host-status").textContent=[state.hosts.codex&&"Codex",state.hosts.claude&&"Claude Code"].filter(Boolean).join(" + ")||"未連結宿主";
  bindActions();
}

async function load(){try{state=await api("/api/state");render();}catch(error){document.querySelector("#content").innerHTML=`<div class="empty"><h2>無法載入</h2><p>${esc(error.message)}</p></div>`;}}
document.querySelector("#refresh").onclick=load;
document.querySelector("#run-form").addEventListener("submit",async event=>{if(event.submitter?.value==="cancel")return;event.preventDefault();const form=new FormData(event.currentTarget);try{const run=await api("/api/runs",{method:"POST",body:JSON.stringify(Object.fromEntries(form))});document.querySelector("#run-dialog").close();toast(`已交給 ${run.host} 執行`);await load();}catch(error){toast(error.message);}});
document.querySelector("#schedule-form").addEventListener("submit",async event=>{if(event.submitter?.value==="cancel")return;event.preventDefault();const form=new FormData(event.currentTarget);try{await api("/api/schedules",{method:"POST",body:JSON.stringify(Object.fromEntries(form))});document.querySelector("#schedule-dialog").close();toast("排程已儲存");await load();}catch(error){toast(error.message);}});
await load();
try { window.parent.postMessage({ type: "vixo-agents:ready" }, "*"); } catch {}
setInterval(load,5000);
