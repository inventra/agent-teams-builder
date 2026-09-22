const token = new URLSearchParams(location.search).get("token") || sessionStorage.getItem("vixo-token") || "";
if (token) sessionStorage.setItem("vixo-token", token);
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
  return `<section class="runs"><div class="eyebrow">RECENT RUNS</div><div class="employee"><div class="employee-body">${state.runs.slice(0,8).map(run=>`<div class="run"><div><strong>${esc(run.agentName||run.agentId)} · ${esc(run.workflowName||run.workflowId)}</strong><p>${esc(run.host)} · ${esc(new Date(run.startedAt).toLocaleString())}</p></div><span class="status ${esc(run.status)}">${esc(run.status)}</span></div>`).join("")}</div></div></section>`;
}

function bindActions() {
  document.querySelectorAll(".play").forEach(button=>button.onclick=async()=>{
    const task=prompt("這次要交給員工的任務：","執行這個 Workflow"); if(task===null)return;
    button.disabled=true;
    try{const run=await api("/api/runs",{method:"POST",body:JSON.stringify({agent:button.dataset.agent,workflow:button.dataset.workflow,task})});toast(`已交給 ${run.host} 執行`);await load();}catch(error){toast(error.message);}finally{button.disabled=false;}
  });
  document.querySelectorAll(".schedule").forEach(button=>button.onclick=()=>{
    const form=document.querySelector("#schedule-form");form.elements.agentId.value=button.dataset.agent;form.elements.workflowId.value=button.dataset.workflow;
    form.elements.host.value=state.hosts.codex?"codex":"claude";document.querySelector("#schedule-dialog").showModal();
  });
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
document.querySelector("#schedule-form").addEventListener("submit",async event=>{if(event.submitter?.value==="cancel")return;event.preventDefault();const form=new FormData(event.currentTarget);try{await api("/api/schedules",{method:"POST",body:JSON.stringify(Object.fromEntries(form))});document.querySelector("#schedule-dialog").close();toast("排程已儲存");await load();}catch(error){toast(error.message);}});
await load();setInterval(load,5000);
