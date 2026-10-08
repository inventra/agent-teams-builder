import { createWorkbench } from "./workbench.js";
import { icon } from "./icons.js";
import { navigateDashboard, notifyEmbedReady } from "./embed-navigation.mjs";
import { dashboardSessionMode, SYNC_LABELS, visibleLibrary, validateAccountInput, draftBundleTemplate, libraryWithAgentChildren } from "./workbench-model.js";

document.querySelectorAll("[data-ui-icon]").forEach((element) => {
  element.innerHTML = icon(element.dataset.uiIcon);
});
let storedToken = "";
try { storedToken = sessionStorage.getItem("vixo-token") || ""; } catch {}
const token = globalThis.__VIXO_AGENTS_EMBED_TOKEN__ || new URLSearchParams(location.search).get("token") || storedToken;
try { if (token) sessionStorage.setItem("vixo-token", token); } catch {}
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let state = null;
let selected = "library";
let session = null, generation = 0, loading = null, checking = null, libraryKind = "agent", dialogVersion = 0;
let authMode = "login", authBusy = false, syncBusy = false, checkingGeneration = -1;
const $ = (selector) => document.querySelector(selector);
const mode = () => dashboardSessionMode(session);
const usable = () => ["approved", "offline"].includes(mode());
const online = () => mode() === "approved";
let dismissedUpdateSuccess = null;
const workbench = createWorkbench({
  api: (...args) => api(...args), esc: (value) => esc(value), toast: (message) => toast(message),
  play: (agent, workflow) => openRunDialog(agent, workflow),
  schedule: (agent, workflow) => openScheduleDialog(agent, workflow),
  openThread: (threadId) => window.parent.postMessage({ type: "vixo-agents:open-codex-thread", threadId }, "*"),
  onNavigate: () => { if (state) renderNav(); }
});

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]);
const toast = (message) => { const el=document.querySelector("#toast"); el.textContent=message; el.classList.add("show"); setTimeout(()=>el.classList.remove("show"),2600); };

function friendlyError(error) {
  return ({invalid_credentials:"帳號或密碼不正確。",username_unavailable:"這個帳號已有人使用，請選擇其他帳號。",account_already_bound:"此身分已設定帳號，請使用原帳號登入。",account_bind_in_progress:"帳號正在設定中。請先試用剛設定的帳號密碼登入，或聯絡管理員。",account_bind_unconfirmed:"帳號設定結果待確認，請先用剛設定的帳密登入。",account_bound_session_unavailable:"帳號已設定，請用剛設定的帳號密碼登入。",account_registered_session_unavailable:"帳號已建立，請用剛註冊的帳號密碼登入。",account_registration_unconfirmed:"註冊結果待確認，請先用剛註冊的帳號密碼登入。",account_already_connected:"目前已連線。請先登出；新帳號不會帶入原本的資料。",account_pending:"帳號正在等待管理員核准。",account_disabled:"帳號已停用，請聯絡管理員。",access_unconfirmed:"暫時無法確認帳號權限，請重新連線。",network_error:"連線暫時中斷，請重新確認連線。",revision_conflict:"版本已改變，請重新開啟詳情確認。",stale_operation:""})[error.code] ?? error.message ?? "操作未完成，請再試一次。";
}
const stale = () => Object.assign(new Error("已切換帳號或頁面"), {code:"stale_operation"});
async function api(path, options={}) {
  const stamp = generation, identity = session?.user?.id;
  const authPath = path.startsWith("/api/session") || /^\/api\/cloud\/(login|register|setup-account|disconnect)$/.test(path);
  if (!authPath && !usable()) throw stale();
  if (!authPath && !online() && !/^\/api\/(state|library(?:\/item|\/preview|\/commit)?)(?:\?|$)/.test(path)) throw new Error("離線時只能編輯此帳號的本機草稿。");
  const response = await fetch(path, { ...options, headers: { ...headers, ...(options.headers||{}) } });
  const body = await response.json();
  if (stamp !== generation || identity !== session?.user?.id) throw stale();
  if (!response.ok) {
    const error = Object.assign(new Error(body.error?.message || body.error || `HTTP ${response.status}`), {code:body.code || body.error?.code,status:response.status});
    if ((usable() && response.status === 401) || ["account_pending","account_disabled","access_unconfirmed","session_changed"].includes(error.code)) {
      clearPrivate(); session = null; renderGate("正在重新確認帳號…"); void checkSession(true);
    }
    throw error;
  }
  return body;
}
const post = (path, body={}) => api(path,{method:"POST",body:JSON.stringify(body)});
function clearPrivate() {
  generation++; dialogVersion++; state=null; loading=null; selected="library";
  document.querySelectorAll("dialog").forEach(dialog => {if(dialog.open) dialog.close();});
  document.querySelectorAll("#run-form,#schedule-form").forEach(form => form.reset());
  for (const id of ["agent-nav","content","summary","library-dialog-body","library-dialog-title","account-name","sync-status","page-title","page-subtitle","update-banner","host-status"]) $("#"+id).replaceChildren();
  $("#run-form").elements.agent.value=""; $("#run-form").elements.workflow.value="";
  $("#schedule-form").elements.agentId.value=""; $("#schedule-form").elements.workflowId.value="";
  $("#run-form").elements.projectId.replaceChildren();
  $("#update-banner").hidden=true; $(".shell").hidden=true; $("#toast").textContent="";
  workbench.reset();
}
function credentialsForm(kind, id="auth-form") {
  const setup = kind === "setup", register = kind === "register";
  return `<form id="${id}" class="account-form" autocomplete="on">${register?'<label>姓名<input name="displayName" autocomplete="name" maxlength="80" required></label>':""}<label>帳號<input name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" pattern="[a-z][a-z0-9_-]{2,31}" minlength="3" maxlength="32" placeholder="例如 kevin_wu" required></label><p class="form-note">3–32 個小寫英文字母、數字、底線或連字號，以英文字母開頭。</p><label>密碼<input name="password" type="password" autocomplete="${setup||register?"new-password":"current-password"}" maxlength="72" ${setup||register?'minlength="12"':""} required></label>${setup||register?'<p class="form-note">至少12個字元，建議使用英文字母、數字與符號。</p><label>再次輸入密碼<input name="confirmation" type="password" autocomplete="new-password" minlength="12" maxlength="72" required></label>':""}<p class="form-error" role="alert"></p><button class="primary" type="submit">${setup?"設定帳號密碼":register?"註冊並送交審核":"登入"}</button></form>`;
}
function bindCredentials(kind,id="auth-form") {
  const form=$("#"+id);
  form.addEventListener("submit",async event => {
    event.preventDefault(); if(authBusy) return;
    const values=Object.fromEntries(new FormData(form)); values.username=values.username.trim().toLowerCase();
    const validation=validateAccountInput(values,kind); if(validation){form.querySelector(".form-error").textContent=validation;return;}
    form.querySelectorAll('input[type="password"]').forEach(input=>input.value="");
    authBusy=true; const button=form.querySelector('button[type="submit"]');button.disabled=true;
    try {
      const body={username:values.username,password:values.password};if(kind==="register")body.displayName=values.displayName.trim();
      await post("/api/cloud/"+({login:"login",register:"register",setup:"setup-account"})[kind],body);
      clearPrivate(); notifySession(); await checkSession(true);
    } catch(error) {if(error.code!=="stale_operation") form.querySelector(".form-error").textContent=friendlyError(error);}
    finally {delete values.password;delete values.confirmation;authBusy=false;button.disabled=false;}
  });
}
function renderGate(message="") {
  const gate=$("#session-gate");gate.hidden=false;$(".shell").hidden=true;
  const current=mode();gate.dataset.mode=message?"checking":current;
  if(message){gate.innerHTML=`<div class="gate-card"><div class="eyebrow">VIXO AGENT TEAMS</div><h1>${esc(message)}</h1><button id="retry-session" class="secondary">重新檢查</button></div>`;$("#retry-session").onclick=()=>checkSession(true);return;}
  if(["pending","disabled","unverified"].includes(current)) {
    gate.innerHTML=`<div class="gate-card"><div class="eyebrow">VIXO AGENT TEAMS</div><h1>${current==="pending"?"等待管理員核准":current==="disabled"?"帳號已停用":"需要重新確認權限"}</h1><p>${current==="pending"?"註冊完成。Kevin 管理員核准後，即可使用自己的 Agent、Skill 與 Workflow。加入團隊後才會看見該團隊資料。":"請聯絡管理員或重新檢查帳號狀態。"}</p>${session?.user?.accountConfigured===false?'<details><summary>設定帳號密碼</summary><p>為目前身分設定帳密，保留原本的資料。</p>'+credentialsForm("setup","gate-setup")+'</details>':""}<div class="gate-actions"><button id="retry-session" class="primary">重新檢查</button><button id="gate-logout" class="secondary">登出</button></div></div>`;
    $("#retry-session").onclick=()=>checkSession(true);$("#gate-logout").onclick=logout;
    if($("#gate-setup"))bindCredentials("setup","gate-setup");return;
  }
  gate.innerHTML=`<div class="gate-card"><div class="eyebrow">VIXO AGENT TEAMS</div><h1>${authMode==="register"?"申請 VIXO 帳號":"登入 VIXO"}</h1><p>${authMode==="register"?"新同仁可自行註冊，待管理員核准後使用。":"登入後，在這台裝置使用自己的本機與雲端 Agent、Skill、Workflow。"}</p>${credentialsForm(authMode)}<button id="auth-toggle" class="text-button">${authMode==="register"?"已有帳號？返回登入":"新同仁？註冊帳號"}</button><p class="gate-help">既有已連線的外掛請先設定帳號密碼，保留原本資料。忘記密碼請從已連線裝置或聯絡管理員處理。</p><a id="advanced-connect" href="/cloud.html?token=${encodeURIComponent(token)}">進階裝置連線</a></div>`;
  bindCredentials(authMode);$("#auth-toggle").onclick=()=>{if(!authBusy){authMode=authMode==="login"?"register":"login";renderGate();}};
  $("#advanced-connect").onclick=event=>{event.preventDefault();navigateDashboard("/cloud.html",{token});};
}
async function logout() {
  clearPrivate();session=null;renderGate("正在登出…");
  try {await post("/api/cloud/disconnect");renderGate();notifySession();}catch(error){renderGate("登出未完成，請重新檢查連線");toast(friendlyError(error));}
}
let sessionChannel;
try {sessionChannel=new BroadcastChannel("vixo-cloud-connection");sessionChannel.onmessage=()=>{clearPrivate();session=null;renderGate("正在確認帳號…");void checkSession(true);};} catch {}
function notifySession(){try{sessionChannel?.postMessage({type:"identity-changed"});}catch{}}
async function checkSession(force=false, refreshMetadata=force) {
  if(checking && checkingGeneration===generation)return checking;
  checkingGeneration=generation;
  const task=(async()=>{
    try {
      const next=await api("/api/session"+(force?"?force=1":""));
      const changed=next.user?.id!==session?.user?.id || dashboardSessionMode(next)!==mode() || next.user?.accountConfigured!==session?.user?.accountConfigured;
      if(changed)clearPrivate();
      session=next;
      if(!usable()){if(changed || $("#session-gate").dataset.mode!==mode())renderGate();return;}
      $("#session-gate").replaceChildren();$("#session-gate").hidden=true;$(".shell").hidden=false;
      renderAccount();await load();
      if(refreshMetadata&&online())void synchronize(false);
    }catch(error){if(error.code!=="stale_operation"){clearPrivate();session=null;renderGate("暫時無法確認帳號，請重新檢查連線");}}
  })();checking=task;try{await task;}finally{if(checking===task)checking=null;}
}
function renderAccount() {
  $("#account-name").textContent=session.user.username || (session.access?.isAdmin?"Kevin 管理員":"已連線的 VIXO 裝置");
  $("#account-button").textContent=session.user.accountConfigured===false?"設定帳號密碼":"帳號設定";
  $("#sync-now").disabled=!online()||syncBusy;$("#open-cloud").disabled=!online();
  const sync=state?.sync||session.sync||{};
  $("#sync-status").textContent=!online()?"離線：僅可編輯本機草稿":`${syncBusy?"正在同步 · ":""}${sync.pendingCount||0} 項待同步 · ${sync.conflictCount||0} 項衝突${sync.lastSyncedAt?" · 上次 "+new Date(sync.lastSyncedAt).toLocaleString("zh-TW"):""}${sync.error?" · "+(sync.error.message||sync.error):""}`;
}
async function synchronize(manual=true) {
  if(!online()||syncBusy)return;syncBusy=true;renderAccount();
  try{await post("/api/sync",{force:true});if(manual)toast("已啟動同步，完成後會更新狀態");await load();}
  catch(error){if(error.code!=="stale_operation"&&manual)toast(friendlyError(error));}
  finally{syncBusy=false;if(usable())renderAccount();}
}

function renderNav() {
  const nav=document.querySelector("#agent-nav");
  nav.innerHTML=`<button class="nav-item ${selected==="library"?"active":""}" data-id="library"><div class="nav-heading">資料庫</div><span class="nav-description">本機與雲端 · Agent / Skill / Workflow</span></button>`+(online()?`<button class="nav-item ${selected==="all"?"active":""}" data-id="all"><div class="nav-heading">${icon("team")}員工總覽</div><span class="nav-description">${state.agents.length} 位員工</span></button>`+state.agents.map(agent=>`<button class="nav-item ${selected===agent.id?"active":""}" data-id="${esc(agent.id)}"><div class="nav-heading">${icon("user")}${esc(agent.displayName)}</div><span class="nav-description">${agent.skills.length} Skills · ${(agent.workflows||[]).length} Workflows</span></button>`).join(""):"");
  const docsNav = selected === "docs" ? [
    ["skins", "L0　介面樣式"], ["home", "L1　首頁總覽"], ["office", "像素辦公室"],
    ["functions", "L2　功能層"], ["system", "L3　系統層"], ["runs", "執行中心"]
  ].map(([view,label])=>'<button class="nav-item docs-sub '+(workbench.view===view?"active":"")+'" data-view="'+view+'"><div class="nav-heading">'+icon(view)+label+'</div></button>').join("") : "";
  if(online()) nav.insertAdjacentHTML("beforeend", '<button class="nav-item '+(selected==="docs"?"active":"")+'" data-id="docs"><div class="nav-heading">'+icon("docs")+'Docs</div><span class="nav-description">首頁與像素工作台</span></button>'+docsNav);
  nav.querySelectorAll("button").forEach(button=>button.onclick=()=>{
    if(button.dataset.view){selected="docs";workbench.navigate(button.dataset.view);}
    else selected=button.dataset.id;
    render();
  });
}

function renderUpdate() {
  const banner=document.querySelector("#update-banner"), update=state.update;
  if(!update){banner.hidden=true;return;}
  const operation=update.operation;
  if(operation?.status==="running"||operation?.status==="queued"){
    banner.hidden=false;banner.className="update-banner running";banner.innerHTML=`<div><strong>正在更新 VIXO Agents…</strong><p>Plugin、頁面與 Skills 更新完成後會自動重新啟動，約需 1–3 分鐘。</p></div><span class="update-spinner" aria-hidden="true"></span>`;return;
  }
  if(operation?.status==="failed"){
    banner.hidden=false;banner.className="update-banner failed";banner.innerHTML=`<div><strong>上次更新沒有完成</strong><p>${esc(operation.error||"請重新執行更新。")}</p></div><button class="secondary apply-update">重試更新</button>`;return;
  }
  if(operation?.status==="succeeded"&&operation.revision===update.currentRevision&&!update.available&&dismissedUpdateSuccess!==operation.revision){
    banner.hidden=false;banner.className="update-banner success";banner.innerHTML=`<div><strong>已更新完成</strong><p>目前版本 ${esc(update.currentVersion)}，Plugin、頁面與 Skills 已同步。</p></div><button class="banner-close" aria-label="關閉">${icon("close")}</button>`;return;
  }
  if(update.available){
    const latest=update.latestVersion?`v${update.latestVersion}`:`${update.latestRevision.slice(0,12)}`;
    banner.hidden=false;banner.className="update-banner available";banner.innerHTML=`<div><span class="update-pill">NEW</span><strong>VIXO Agents 有新版 ${esc(latest)}</strong><p>按一次即可一起更新 Plugin、操作頁面、Skills 與執行功能。</p></div><button class="primary apply-update">立即更新</button>`;return;
  }
  banner.hidden=true;
}

function workflowCard(agent, workflow) {
  const hostAvailable=online()&&(state.hosts.codex||state.hosts.claude);
  return `<article class="workflow"><div class="workflow-top"><div><h4>${esc(workflow.name)}</h4><p>${esc(workflow.description)}</p></div><div class="actions"><button class="secondary schedule" data-agent="${esc(agent.id)}" data-workflow="${esc(workflow.id)}" ${hostAvailable?"":"disabled"}>${icon("calendar")} 排程</button><button class="primary play" data-agent="${esc(agent.id)}" data-workflow="${esc(workflow.id)}" ${hostAvailable?"":"disabled"}>${icon("play")} Play</button></div></div><div class="nodes">${workflow.nodes.map(node=>`<div class="node ${esc(node.type)}"><span class="node-type">${esc(node.type)}</span><strong>${esc(node.name)}</strong><small>${esc(node.skillId?`Skill · ${node.skillId}`:node.instructions)}</small>${node.requiresApproval?'<span class="tag">需確認</span>':''}</div>`).join("")}</div></article>`;
}

function employeeCard(agent) {
  return `<article class="employee"><div class="employee-head"><div class="employee-title"><div class="avatar">${esc(agent.displayName.slice(0,1))}</div><div><h3>${esc(agent.displayName)}</h3><p>${esc(agent.description)}</p><span class="tag">${esc(agent.id)}</span><span class="tag">v${esc(agent.version)}</span></div></div></div><div class="employee-body"><div class="eyebrow">SKILLS</div><div class="skills">${agent.skills.map(skill=>`<span class="skill">${esc(skill.name)}</span>`).join("")}</div><div class="eyebrow">WORKFLOWS</div>${(agent.workflows||[]).length?(agent.workflows||[]).map(workflow=>workflowCard(agent,workflow)).join(""):'<p>尚未建立 Workflow。請在 Session 中說「替這位員工加上 Workflow」。</p>'}</div></article>`;
}

function renderRuns() {
  if (!state.runs.length) return "";
  const labels={"dispatching":"正在建立 Codex 任務","opened-in-codex":"已建立 Codex 任務","running":"執行中","waiting-input":"等待輸入","waiting-approval":"等待核准","completed":"已完成","failed":"失敗","rejected":"已拒絕"};
  return `<section class="runs"><div class="eyebrow">RECENT RUNS</div><div class="employee"><div class="employee-body">${state.runs.slice(0,8).map(run=>{
    const detail=run.lastMessage?`<p class="run-message">${esc(run.lastMessage)}</p>`:"";
    let controls="";
    if(run.status==="waiting-input") controls=run.resumable?`<button class="secondary reply-run" data-run="${esc(run.id)}">回覆並繼續</button>`:`<span class="legacy-note">舊版紀錄無法續跑，請重新 Play</span>`;
    if(run.status==="waiting-approval") controls=run.resumable?`<button class="secondary reject-run" data-run="${esc(run.id)}">拒絕</button><button class="primary approve-run" data-run="${esc(run.id)}">核准並繼續</button>`:`<span class="legacy-note">舊版紀錄無法續跑，請重新 Play</span>`;
    if(run.status==="opened-in-codex"&&run.threadId) controls=`<button class="primary open-native-thread" data-thread="${esc(run.threadId)}">在 Codex 開啟</button>`;
    return `<div class="run"><div><strong>${esc(run.agentName||run.agentId)} · ${esc(run.workflowName||run.workflowId)}</strong><p>${esc(run.host)}${run.projectName?` · ${esc(run.projectName)}`:""} · ${esc(new Date(run.startedAt).toLocaleString())}${run.approvalMode==="auto"?" · 本次自動核准":""}</p>${run.pendingNodeName?`<p>待核准：${esc(run.pendingNodeName)}</p>`:""}${detail}</div><div class="run-side"><span class="status ${esc(run.status)}">${esc(labels[run.status]||run.status)}</span><div class="run-actions">${controls}</div></div></div>`;
  }).join("")}</div></div></section>`;
}

function openRunDialog(agent, workflow) {
  if(!online()) return toast("請連線並確認帳號權限後再執行。");
  if (!state.hosts.codex && !state.hosts.claude) return toast("尚未連結可用的執行宿主");
  configureRunForm();
  const form=document.querySelector("#run-form");
  form.elements.agent.value=agent;form.elements.workflow.value=workflow;
  form.elements.host.value=state.hosts.codex?"codex":"claude";form.elements.host.onchange?.();
  document.querySelector("#run-dialog").showModal();
}

function openScheduleDialog(agent, workflow) {
  if(!online()) return toast("請連線並確認帳號權限後再執行。");
  if (!state.hosts.codex && !state.hosts.claude) return toast("尚未連結可用的執行宿主");
  const form=document.querySelector("#schedule-form");
  form.elements.agentId.value=agent;form.elements.workflowId.value=workflow;
  form.elements.host.value=state.hosts.codex?"codex":"claude";
  document.querySelector("#schedule-dialog").showModal();
}

function bindActions() {
  document.querySelectorAll(".apply-update").forEach(button=>button.onclick=async()=>{if(!confirm("要立即更新 VIXO Agents 嗎？更新時頁面會短暫重新啟動。"))return;button.disabled=true;try{await api("/api/update/apply",{method:"POST",body:"{}"});toast("已開始更新，完成後會自動重新連線");await load();}catch(error){button.disabled=false;toast(error.message);}});
  document.querySelectorAll(".banner-close").forEach(button=>button.onclick=()=>{dismissedUpdateSuccess=state.update?.operation?.revision||"dismissed";document.querySelector("#update-banner").hidden=true;});
  document.querySelectorAll(".play").forEach(button=>button.onclick=()=>{
    openRunDialog(button.dataset.agent,button.dataset.workflow);
  });
  document.querySelectorAll(".schedule").forEach(button=>button.onclick=()=>{
    openScheduleDialog(button.dataset.agent,button.dataset.workflow);
  });
  document.querySelectorAll(".reply-run").forEach(button=>button.onclick=async()=>{const message=prompt("回覆 Agent 需要的資料：");if(!message)return;try{await api(`/api/runs/${encodeURIComponent(button.dataset.run)}/reply`,{method:"POST",body:JSON.stringify({message})});toast("已回覆，Workflow 繼續執行");await load();}catch(error){toast(error.message);}});
  document.querySelectorAll(".approve-run").forEach(button=>button.onclick=async()=>{const message=prompt("核准說明：","我確認核准這個節點，請繼續執行。");if(!message)return;try{await api(`/api/runs/${encodeURIComponent(button.dataset.run)}/approve`,{method:"POST",body:JSON.stringify({message})});toast("已核准，Workflow 繼續執行");await load();}catch(error){toast(error.message);}});
  document.querySelectorAll(".reject-run").forEach(button=>button.onclick=async()=>{if(!confirm("確定拒絕並停止這次 Workflow？"))return;try{await api(`/api/runs/${encodeURIComponent(button.dataset.run)}/reject`,{method:"POST",body:JSON.stringify({message:"使用者在 Dashboard 拒絕核准"})});toast("已拒絕這次執行");await load();}catch(error){toast(error.message);}});
  document.querySelectorAll(".open-native-thread").forEach(button=>button.onclick=()=>window.parent.postMessage({type:"vixo-agents:open-codex-thread",threadId:button.dataset.thread},"*"));
}

function configureRunForm() {
  const form=document.querySelector("#run-form"), host=form.elements.host, mode=form.elements.executionMode, project=form.elements.projectId;
  const embedded=window.parent!==window;
  const nativeOption=mode.querySelector('option[value="codex-app"]');
  nativeOption.disabled=!embedded;
  if(!embedded&&mode.value==="codex-app")mode.value="background";
  project.innerHTML=(state.codexProjects||[]).map(item=>`<option value="${esc(item.id)}" ${item.selected?"selected":""}>${esc(item.name)} — ${esc(item.workspacePath)}</option>`).join("");
  const refresh=()=>{
    const codex=host.value==="codex", native=codex&&mode.value==="codex-app";
    document.querySelector("#execution-mode-field").hidden=!codex;
    document.querySelector("#codex-project-field").hidden=!native;
    document.querySelector("#codex-project-note").hidden=!native;
    project.required=native;
    if(native&&!(state.codexProjects||[]).length){mode.value="background";refresh();toast("Codex 尚未設定可選專案，已改用背景執行");}
  };
  host.onchange=refresh;mode.onchange=refresh;refresh();
}

function render() {
  if(!state||!usable())return;
  renderAccount();
  renderNav();
  renderUpdate();
  if(selected==="library" || !online()){renderLibrary();return;}
  const agents=selected==="all"?state.agents:state.agents.filter(agent=>agent.id===selected);
  const skillCount=state.agents.reduce((sum,agent)=>sum+agent.skills.length,0), workflowCount=state.agents.reduce((sum,agent)=>sum+(agent.workflows||[]).length,0), scheduled=state.schedules.filter(item=>item.enabled).length;
  document.querySelector("#summary").innerHTML=[[state.agents.length,"已訓練員工"],[skillCount,"Skills"],[workflowCount,"Workflows"],[scheduled,"自動排程"]].map(([n,label])=>`<div class="metric"><b>${n}</b><span>${label}</span></div>`).join("");
  const selectedAgent=state.agents.find(agent=>agent.id===selected);document.querySelector("#page-title").textContent=selectedAgent?selectedAgent.displayName:"員工總覽";
  document.querySelector("#page-subtitle").textContent=selectedAgent?selectedAgent.purpose:"把訓練結果、技能與執行流程放在同一個畫面。";
  document.querySelector("#content").innerHTML=agents.length?agents.map(employeeCard).join("")+renderRuns():'<div class="empty"><h2>還沒有員工</h2><p>在 Codex 或 Claude Code 完成一段流程後，說「幫我變成一個員工」。</p></div>';
  document.querySelector("#host-status").textContent=[state.hosts.codex&&"Codex",state.hosts.claude&&"Claude Code"].filter(Boolean).join(" + ")||"未連結宿主";
  if(!document.querySelector("#run-dialog").open)configureRunForm();
  bindActions();
  const docs=selected==="docs";
  document.querySelector("main>header").hidden=docs;
  document.querySelector("#summary").hidden=docs;
  document.querySelector("#content").hidden=docs;
  if(docs){if(!workbench.active)workbench.open(state);}
  else workbench.close();
}

async function load(){
  if(!usable()||document.hidden)return;if(loading)return loading;
  const stamp=generation;
  const task=(async()=>{try{const next=await api("/api/state");if(stamp!==generation)return;state={agents:[],hosts:{},codexProjects:[],runs:[],schedules:[],library:[],...next};render();if(workbench.active)await workbench.refresh(state);}catch(error){if(error.code!=="stale_operation"){toast(friendlyError(error));if(stamp===generation){clearPrivate();session=null;renderGate("正在重新確認連線…");void checkSession(true);}}}})();
  loading=task;try{await task;}finally{if(loading===task)loading=null;}
}
document.querySelector("#refresh").onclick=load;
document.querySelector("#check-update").onclick=async()=>{const button=document.querySelector("#check-update");button.disabled=true;try{state.update=await api("/api/update/check",{method:"POST",body:"{}"});render();toast(state.update.error?`無法檢查更新：${state.update.error}`:state.update.available?"找到新版，可立即更新":"目前已是最新版");}catch(error){toast(error.message);}finally{button.disabled=false;}};
document.querySelector("#run-form").addEventListener("submit",async event=>{if(event.submitter?.value==="cancel")return;event.preventDefault();const form=new FormData(event.currentTarget);try{const run=await api("/api/runs",{method:"POST",body:JSON.stringify(Object.fromEntries(form))});document.querySelector("#run-dialog").close();if(run.nativeLaunch){window.parent.postMessage({type:"vixo-agents:create-codex-thread",payload:run.nativeLaunch},"*");toast(`正在 ${run.nativeLaunch.projectName} 建立 Codex 任務`);}else toast(`已交給 ${run.host} 執行`);await load();}catch(error){toast(error.message);}});
document.querySelector("#schedule-form").addEventListener("submit",async event=>{if(event.submitter?.value==="cancel")return;event.preventDefault();const form=new FormData(event.currentTarget);try{await api("/api/schedules",{method:"POST",body:JSON.stringify(Object.fromEntries(form))});document.querySelector("#schedule-dialog").close();toast("排程已儲存");await load();}catch(error){toast(error.message);}});
await checkSession(true);
window.addEventListener("message",async event=>{if(event.source!==window.parent)return;const message=event.data;if(message?.type==="vixo-agents:thread-created"){try{await api(`/api/runs/${encodeURIComponent(message.payload.runId)}/native-result`,{method:"POST",body:JSON.stringify({threadId:message.payload.threadId})});await load();}catch(error){toast(error.message);}}if(message?.type==="vixo-agents:thread-create-error"){try{await api(`/api/runs/${encodeURIComponent(message.payload.runId)}/native-result`,{method:"POST",body:JSON.stringify({error:message.payload.error})});}catch{}toast(message.payload.error||"無法建立 Codex 任務");await load();}});
setInterval(()=>{if(!document.hidden)void load();},5000);
setInterval(()=>{if(!document.hidden&&!authBusy)void checkSession(true,false);},30000);
window.addEventListener("focus",()=>{if(!authBusy)void checkSession(true);});
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&!authBusy)void checkSession(true);});
window.addEventListener("offline",()=>{if(usable()){clearPrivate();void checkSession(true);}});
window.addEventListener("online",()=>void checkSession(true));

// The local bearer remains on this origin and is never sent to the cloud portal.
document.getElementById("open-cloud").addEventListener("click", () => { if(!online())return;navigateDashboard("/cloud.html",{token}); });

$("#logout").onclick=logout;
$("#sync-now").onclick=()=>synchronize(true);
$("#account-button").onclick=()=>{
  showDialog("帳號設定",`<p>${esc(session.user.username || (session.access?.isAdmin?"Kevin 管理員":"目前裝置身分"))}</p><p>這台裝置的資料依目前帳號分開保存。外部系統與 ERP 授權需在各裝置設定。</p>${session.user.accountConfigured===false?credentialsForm("setup","account-setup"):'<p>如需更改帳號或密碼，請聯絡管理員。</p>'}${session.legacyImportAvailable?'<p>此裝置有 '+esc(session.legacyCount||0)+' 個尚未匯入的舊版 Agent。</p><button id="legacy-import" class="secondary">檢視匯入確認</button>':""}`);
  if($("#account-setup"))bindCredentials("setup","account-setup");
  if($("#legacy-import"))$("#legacy-import").onclick=()=>{showDialog("匯入舊版本機 Agent",`<p>將此裝置 ${esc(session.legacyCount||0)} 個舊版 Agent 加入目前帳號。匯入後只屬於這個帳號，不會自動與同仁分享。</p><label class="confirmation"><input id="confirm-import" type="checkbox">我確認匯入至目前帳號</label><button id="commit-import" class="primary" disabled>確認匯入</button>`);$("#confirm-import").onchange=event=>$("#commit-import").disabled=!event.target.checked;$("#commit-import").onclick=()=>dialogAction(async()=>{await post("/api/library/import-legacy",{userConfirmation:"確認"});closeDialog();await checkSession(true);});};
};

function renderLibrary() {
  workbench.close();
  $("main>header").hidden=false;$("#summary").hidden=false;$("#content").hidden=false;
  $("#page-title").textContent="我的資料庫";
  $("#page-subtitle").textContent=online()?"本機與雲端的 Agent、Skill、Workflow。修改先存本機，再同步到同一個帳號。":"離線草稿模式：可以預覽與儲存本機修改，重新連線後才能同步或執行。";
  const entries=visibleLibrary(libraryWithAgentChildren(state.library,state.agents),session), rows=entries.filter(row=>row.kind===libraryKind);
  $("#summary").innerHTML=[...['agent','skill','workflow'].map(kind=>[entries.filter(row=>row.kind===kind).length,{agent:"Agents",skill:"Skills",workflow:"Workflows"}[kind]]),[entries.filter(row=>row.syncState==="pending").length,"待同步"]].map(([n,label])=>`<div class="metric"><b>${n}</b><span>${label}</span></div>`).join("");
  $("#content").innerHTML=`<div class="library-toolbar"><div class="library-tabs" role="tablist" aria-label="資料類型">${['agent','skill','workflow'].map(kind=>`<button role="tab" aria-selected="${kind===libraryKind}" data-library-kind="${kind}">${{agent:"Agent",skill:"Skill",workflow:"Workflow"}[kind]}</button>`).join("")}</div><button id="new-draft" class="primary">新增本機草稿</button></div><div class="library-grid">${rows.map(row=>`<article class="library-card"><div class="library-badges"><span class="tag">${row.id.startsWith("cloud:")?"雲端":row.id.startsWith("legacy:")?"原有本機":"本機"}${row.workspaceId?" · 團隊":" · 個人"}</span><span class="tag sync-${esc(row.syncState)}">${esc(SYNC_LABELS[row.syncState]||row.syncState||"僅在本機")}</span></div><h2>${esc(row.title||row.slug)}</h2><p>${esc(row.description||"尚無說明")}</p><small>${row.parentId?"隸屬 "+esc(row.parentTitle)+" · ":""}${esc(row.slug)}${row.revision?" · v"+esc(row.revision):""}</small><button class="secondary open-library-item" data-id="${esc(row.parentId||row.id)}">${row.parentId?"查看所屬 Agent":["conflict","uncertain","error"].includes(row.syncState)?"檢視版本衝突":"查看完整內容"}</button></article>`).join("")||'<div class="empty"><h2>尚無這類資料</h2><p>可以建立本機草稿，或同步已有的雲端資料。</p></div>'}</div>`;
  $("#host-status").textContent=online()?([state.hosts.codex&&"Codex",state.hosts.claude&&"Claude Code"].filter(Boolean).join(" + ")||"未連結執行宿主"):"離線草稿模式";
  $("#check-update").disabled=!online();bindActions();
  document.querySelectorAll("[data-library-kind]").forEach(button=>button.onclick=()=>{libraryKind=button.dataset.libraryKind;renderLibrary();});
  document.querySelectorAll(".open-library-item").forEach(button=>button.onclick=()=>openLibraryItem(button.dataset.id));
  $("#new-draft").onclick=()=>openDraftEditor();
}
function showDialog(title,html) {
  dialogVersion++;$("#library-dialog-title").textContent=title;$("#library-dialog-body").innerHTML=html;
  if(!$("#library-dialog").open)$("#library-dialog").showModal();return dialogVersion;
}
function closeDialog(){dialogVersion++;$("#library-dialog").close();$("#library-dialog-body").replaceChildren();$("#library-dialog-title").textContent="";}
$("#close-library-dialog").onclick=closeDialog;
$("#library-dialog").addEventListener("cancel",event=>{event.preventDefault();closeDialog();});
async function dialogAction(fn) {
  const stamp=dialogVersion;
  const buttons=[...$("#library-dialog-body").querySelectorAll("button")];const disabled=buttons.map(button=>button.disabled);buttons.forEach(button=>button.disabled=true);
  try{await fn();}catch(error){if(error.code!=="stale_operation"&&stamp===dialogVersion){let p=$("#dialog-error");if(!p){p=document.createElement("p");p.id="dialog-error";p.className="form-error";p.setAttribute("role","alert");$("#library-dialog-body").append(p);}p.textContent=friendlyError(error);}}
  finally{if(stamp===dialogVersion)buttons.forEach((button,i)=>button.disabled=disabled[i]);}
}
const bundleView = (bundle) => `<pre class="bundle-preview">${esc(JSON.stringify(bundle,null,2))}</pre>`;
async function openLibraryItem(id) {
  const stamp=showDialog("正在載入完整內容…","<p>正在讀取本機副本。</p>");
  await dialogAction(async()=>{
    const {entry,remote}=await api("/api/library/item?id="+encodeURIComponent(id));if(stamp!==dialogVersion)return;
    if(!online()&&!entry.id.startsWith("local:"))throw new Error("離線時只能開啟本機草稿。");
    if(!entry.bundle) {
      showDialog(entry.title||entry.slug,`<p>${esc(entry.description)}</p><p class="conflict-note" role="status">${esc(entry.error||"這份內容尚未符合雲端套件格式，請整理後再同步。")}</p><h3>原有本機內容（唯讀）</h3><p>仍可從員工總覽使用既有本機流程。此頁暫不提供套件編輯或同步。</p>${entry.agent?bundleView(entry.agent):""}${entry.legacy?'<button id="view-legacy-agent" class="secondary">查看所屬本機 Agent</button>':""}`);
      if($("#view-legacy-agent"))$("#view-legacy-agent").onclick=()=>{closeDialog();selected=state.agents.some(agent=>agent.id===entry.id)?entry.id:"all";render();};
      return;
    }
    const needsResolution=["conflict","uncertain","error"].includes(entry.syncState);
    showDialog(entry.title||entry.slug,`<p>${esc(entry.description)}</p><p>${esc(SYNC_LABELS[entry.syncState]||"本機副本")} · ${esc(entry.kind)}${entry.revision?" · v"+esc(entry.revision):""}</p>${needsResolution?`<p class="conflict-note">${entry.syncState==="uncertain"?"同步結果尚未確認，請先重試同步；原先的雲端寫入可能已完成，另存副本可能保留兩份。":"此版本尚未同步成功。請檢查本機與可取得的雲端內容，選擇保留方式。"}</p><div class="conflict-columns"><section><h3>目前本機</h3>${bundleView(entry.bundle)}</section><section><h3>雲端候選 v${esc(remote?.revision||"未知")}</h3>${remote?bundleView(remote.bundle):"<p>無法取得雲端候選，請重新同步。</p>"}</section></div><label class="confirmation"><input id="confirm-conflict" type="checkbox">我已檢查目前可取得的版本並確認以下處理</label><div class="actions"><button id="resolve-remote" class="secondary" disabled>採用雲端版本</button><button id="resolve-copy" class="primary" disabled>將本機版本另存副本</button></div>`:`${bundleView(entry.bundle)}<div class="actions"><button id="edit-draft" class="primary">編輯本機草稿</button>${online()?'<button id="prepare-library" class="secondary">取得執行提示</button>':""}</div>`}`);
    if($("#edit-draft"))$("#edit-draft").onclick=()=>openDraftEditor(entry);
    if($("#prepare-library"))$("#prepare-library").onclick=()=>dialogAction(async()=>{const result=await post("/api/library/prepare",{id:entry.id});showDialog("在目前的 Codex Session 執行",`<p>請將完整提示交給目前 Codex Session 執行。外部系統授權需在這台裝置確認。</p><pre class="bundle-preview">${esc(result.prepared?.prompt||result.prompt||JSON.stringify(result,null,2))}</pre>`);});
    if($("#confirm-conflict")) {
      $("#confirm-conflict").onchange=event=>{for(const name of ['remote','copy'])$("#resolve-"+name).disabled=!event.target.checked||!online()||(name==='remote'&&!remote);};
      for(const resolution of ['remote','copy'])$("#resolve-"+resolution).onclick=()=>dialogAction(async()=>{if(!$("#confirm-conflict").checked)return;await post("/api/library/resolve",{id:entry.id,resolution,userConfirmation:"確認",expectedHash:entry.bundleHash,expectedRevision:entry.revision,remoteRevision:remote?.revision??null});closeDialog();toast("版本處理已儲存，請查看同步狀態");await load();});
    }
  });
}
function openDraftEditor(entry=null, saved=null) {
  if(entry&&!entry.bundle)return toast("這份本機內容目前僅供檢視，請整理成完整套件後再編輯同步。");
  const bundle=saved?.bundle||entry?.bundle||draftBundleTemplate(libraryKind);
  showDialog(entry?"編輯本機草稿":"新增本機草稿",`<p>編輯完整 JSON bundle，先預覽再確認儲存。檔案以文字內容保存，不包含密碼、Token 或私人記憶。</p><form id="draft-form"><label>名稱<input name="title" value="${esc(saved?.title||entry?.title||"")}" required maxlength="200"></label><label>識別名稱<input name="slug" value="${esc(saved?.slug||entry?.slug||bundle.spec?.id||"")}" required></label><label>說明<textarea name="description" rows="2">${esc(saved?.description||entry?.description||"")}</textarea></label><label>完整 Bundle JSON<textarea id="draft-json" name="bundle" class="code-editor" spellcheck="false" rows="18" required>${esc(JSON.stringify(bundle,null,2))}</textarea></label><p class="form-error" role="alert"></p><button class="primary" type="submit">預覽完整內容</button></form>`);
  $("#draft-form").onsubmit=async event=>{
    event.preventDefault();const form=event.currentTarget;let values=Object.fromEntries(new FormData(form));
    try{values.bundle=JSON.parse(values.bundle);}catch{form.querySelector(".form-error").textContent="JSON 格式有誤，請檢查括號、逗號與引號。";return;}
    const stamp=dialogVersion;
    await dialogAction(async()=>{
      const preview=await post("/api/library/preview",{...values,kind:values.bundle.kind,...(entry?.id?{id:entry.id}:{})});if(stamp!==dialogVersion)return;
      const row=preview.entry;
      showDialog("確認完整草稿",`<h3>${esc(row.title)}</h3><p>${esc(row.description)}</p><p>${esc(row.kind)} · ${esc(row.slug)}</p>${bundleView(row.bundle)}<label class="confirmation"><input id="confirm-draft" type="checkbox">我已閱讀完整 SOP、檔案、需求與確認點，確認儲存此版本</label><div class="actions"><button id="back-to-editor" class="secondary">返回修改</button><button id="commit-draft" class="primary" disabled>確認儲存到本機</button></div>`);
      $("#back-to-editor").onclick=()=>openDraftEditor(entry,values);
      $("#confirm-draft").onchange=event=>$("#commit-draft").disabled=!event.target.checked;
      $("#commit-draft").onclick=()=>dialogAction(async()=>{if(!$("#confirm-draft").checked)return;await post("/api/library/commit",{token:preview.token,userConfirmation:"確認"});closeDialog();toast("已儲存在本機，等待同步");await load();if(online())void synchronize(false);});
    });
  };
}

// Notify only after bootstrap and every interactive handler have been installed.
notifyEmbedReady();
