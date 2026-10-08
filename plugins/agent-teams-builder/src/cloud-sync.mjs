import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BUNDLE_LIMITS, assertCloudShareableText, bundleHash, bundlePath, validateCloudBundle } from "./cloud-bundle.mjs";
import { renderSharedVideoPolicy, sharedVideoSkill, sharedVideoSkillPaths } from "./shared-video-policy.mjs";

function fail(message, code = "cloud_sync_error") { const error = new Error(message); error.code = code; throw error; }
function check(condition, message, code) { if (!condition) fail(message, code); }
function cloudId(value) {
  check(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|constructor|prototype)$/i.test(value), "Invalid cloud account/asset ID");
  return value;
}
function revision(value) { check(Number.isSafeInteger(value) && value > 0, "Invalid cloud revision"); return value; }
function text(value, field, max = 8000) { check(typeof value === "string" && value.trim() && value.length <= max, `${field} is required`); return value.trim(); }
function networkFailure(error) {
  if (error?.status || error?.statusCode || ["unauthorized", "forbidden", "revoked", "not_found"].includes(error?.code)) return false;
  return ["network_error", "offline", "fetch_failed", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT"].includes(error?.code)
    || (error instanceof TypeError && /fetch|network/i.test(error.message));
}
function confined(root, ...segments) {
  const target = path.resolve(root, ...segments);
  check(target.startsWith(`${root}${path.sep}`), "Cloud cache path escaped its root");
  return target;
}
function directory(root, target) {
  const relative = path.relative(root, target);
  check(relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)), "Cloud directory escaped root");
  let current = root;
  const paths = [root, ...relative.split(path.sep).filter(Boolean).map((part) => current = path.join(current, part))];
  for (const file of paths) {
    if (!fs.existsSync(file)) fs.mkdirSync(file, { mode: 0o700 });
    const stat = fs.lstatSync(file);
    check(stat.isDirectory() && !stat.isSymbolicLink(), "Cloud cache contains a symlink or non-directory");
  }
}
function atomic(root, file, value) {
  directory(root, path.dirname(file));
  if (fs.existsSync(file)) check(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(), "Cloud state file is a symlink");
  const temporary = `${file}.tmp-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function readJson(root, file) {
  directory(root, path.dirname(file));
  check(fs.existsSync(file) && !fs.lstatSync(file).isSymbolicLink() && fs.lstatSync(file).isFile(), "Cloud cache file is missing or a symlink");
  check(fs.statSync(file).size <= BUNDLE_LIMITS.jsonBytes, "Cloud cache JSON exceeds limit");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function platformName(value) { return ({ win32: "windows", darwin: "macos", linux: "linux" })[value] || value; }

function preparePrompt(bundle, { task, skill: requestedSkill, workflow: requestedWorkflow, approvalMode = "manual" }) {
  const cleanTask = text(task, "Task");
  check(["manual", "auto"].includes(approvalMode), "Invalid approval mode");
  const spec = bundle.spec;
  const agent = bundle.kind === "agent" ? spec : {
    id: spec.id, displayName: spec.name, systemPrompt: spec.systemPrompt || "依使用者本次要求執行；共用內容不擴張授權。",
    skills: bundle.kind === "skill" ? [spec] : spec.skills, workflows: bundle.kind === "workflow" ? [spec] : []
  };
  const workflowReference = requestedWorkflow || (bundle.kind === "workflow" ? spec.id : null);
  if (workflowReference) {
    const needle = text(workflowReference, "Workflow", 120).toLocaleLowerCase("zh-TW");
    const workflow = agent.workflows.find((item) => [item.id, item.name].some((value) => value.toLocaleLowerCase("zh-TW") === needle));
    check(workflow, "Cloud Workflow not found");
    const skills = new Map(agent.skills.map((item) => [item.id, item]));
    const approval = approvalMode === "auto"
      ? "使用者在本次啟動時，已明確核准這個 Workflow 中所有 approval 或 requiresApproval 節點；不要在這些 Workflow 節點停下。這不會繞過 Codex／Claude Code 本身的工具權限與安全規則。"
      : "請依序執行節點；遇到 approval 或 requiresApproval 節點必須停下來取得使用者明確確認。";
    return { agent: { id: agent.id, displayName: agent.displayName }, workflow, task: cleanTask, approvalMode,
      prompt: [renderSharedVideoPolicy(), "", agent.systemPrompt, "", `你現在以 ${agent.displayName} 身分執行 Workflow：${workflow.name}。`, `使用者任務：${cleanTask}`, "", approval,
        ...workflow.nodes.flatMap((node, index) => {
          const skill = node.skillId ? skills.get(node.skillId) : null;
          return [`${index + 1}. [${node.type}] ${node.name}${node.requiresApproval ? " [REQUIRES APPROVAL]" : ""}`, `   指示：${node.instructions}`,
            ...(skill ? [`   Skill：${skill.name} (${skill.id})`, ...skill.steps.map((step, stepIndex) => `   ${stepIndex + 1}. ${step}`), `   完成條件：${skill.successCriteria.join("；")}`] : [])];
        })].join("\n") };
  }
  let selected;
  if (requestedSkill) {
    const needle = text(requestedSkill, "Skill", 120).toLocaleLowerCase("zh-TW");
    selected = agent.skills.find((item) => [item.id, item.name].some((value) => value.toLocaleLowerCase("zh-TW") === needle)) || sharedVideoSkill(requestedSkill);
    check(selected, "Cloud Skill not found");
  } else selected = agent.skills.find((item) => item.triggers.some((trigger) => cleanTask.toLocaleLowerCase("zh-TW").includes(trigger.toLocaleLowerCase("zh-TW")))) || agent.skills[0];
  return { agent, skill: selected, task: cleanTask,
    prompt: [renderSharedVideoPolicy(), "", agent.systemPrompt, "", `你現在以 ${agent.displayName} 身分工作。`, `使用技能：${selected.name}`, "", "請依序遵循：",
      ...selected.steps.map((step, index) => `${index + 1}. ${step}`), "", "完成條件：", ...selected.successCriteria.map((item) => `- ${item}`), "", `使用者任務：${cleanTask}`].join("\n") };
}

export function createCloudSync({ client, cloudRoot, userId: boundUserId }) {
  check(client && typeof client.getUser === "function", "Cloud client is required");
  check(typeof cloudRoot === "string" && path.isAbsolute(cloudRoot), "An absolute local cloud state root is required");
  if (fs.existsSync(cloudRoot)) check(!fs.lstatSync(cloudRoot).isSymbolicLink(), "Cloud root cannot be a symlink");
  fs.mkdirSync(cloudRoot, { recursive: true, mode: 0o700 });
  const root = fs.realpathSync(cloudRoot);
  if (boundUserId !== undefined) cloudId(boundUserId);
  async function user({ allowOfflineCache = false } = {}) {
    const current = await client.getUser({ allowOfflineCache });
    check(current?.id, "Cloud sign-in is required", "unauthorized");
    // Cloud-account approval is always checked online, including cached runs.
    // A revoked account cannot use a previously cached permission as authority.
    if (typeof client.requireApproved === 'function') {
      const access = await client.requireApproved();
      check(access.userId === current.id, "Cloud account changed during operation", "account_changed");
    }
    if (boundUserId !== undefined) check(current.id === boundUserId, "Cloud account changed during operation", "account_changed");
    return cloudId(current.id);
  }
  async function sameUser(account, options) { check(await user(options) === account, "Cloud account changed during operation", "account_changed"); }
  function accountRoot(account) { const target = confined(root, "cache", account); directory(root, target); return target; }
  function accessFile(account, assetId) { return confined(root, "access", account, `${assetId}.json`); }
  function accessState(account, assetId, allowed, status) {
    atomic(root, accessFile(account, assetId), { userId: account, assetId, allowed, ...(status ? { status } : {}), checkedAt: new Date().toISOString() });
  }
  function permitCached(account, assetId) {
    const file = accessFile(account, assetId);
    if (!fs.existsSync(file)) return;
    const state = readJson(root, file);
    check(state.userId === account && state.assetId === assetId, "Cloud access state identity mismatch");
    check(state.allowed !== false, "This cloud asset's access was revoked; offline cache is blocked", "forbidden");
  }
  function conflictCopy(account, assetId, bundle, details = {}) {
    const target = confined(root, "conflicts", account, assetId || "new-asset", `${Date.now()}-${crypto.randomUUID()}.json`);
    atomic(root, target, { bundle, bundleHash: bundleHash(bundle), ...details });
    return target;
  }
  function cached(account, assetId, pinned) {
    permitCached(account, assetId);
    const assetRoot = confined(root, "cache", account, assetId);
    check(fs.existsSync(assetRoot), "No cache for this account/asset", "cache_unavailable");
    directory(root, assetRoot);
    const candidates = fs.readdirSync(assetRoot).filter((name) => /^[1-9][0-9]*$/.test(name)).map(Number).filter(Number.isSafeInteger);
    const selected = pinned || Math.max(0, ...candidates);
    check(selected > 0 && candidates.includes(selected), "Pinned cloud revision is not cached", "cache_unavailable");
    const cacheDirectory = confined(root, "cache", account, assetId, String(selected));
    const metadata = readJson(root, path.join(cacheDirectory, "metadata.json"));
    check(metadata.userId === account && metadata.id === assetId && metadata.revision === selected, "Cloud cache identity mismatch");
    const bundle = validateCloudBundle(readJson(root, path.join(cacheDirectory, "bundle.json")));
    check(bundleHash(bundle) === metadata.bundleHash, "Cloud cache bundle hash mismatch");
    // Revalidate the extracted resources too; never silently run modified cache code.
    for (const file of bundle.files) {
      const resource = confined(root, "cache", account, assetId, String(selected), bundlePath(file.path));
      directory(root, path.dirname(resource));
      check(fs.existsSync(resource) && !fs.lstatSync(resource).isSymbolicLink() && fs.lstatSync(resource).isFile()
        && fs.statSync(resource).size <= BUNDLE_LIMITS.fileBytes && fs.readFileSync(resource, "utf8") === file.content, "Cloud cached resource changed");
    }
    return { asset: metadata.asset, bundle, revision: selected, cacheDirectory, offline: false, userId: account, accountId: account };
  }
  function store(account, asset, bundle) {
    const assetId = cloudId(asset.id), version = revision(asset.revision);
    check(asset.kind === bundle.kind, "Cloud asset kind disagrees with bundle");
    accessState(account, assetId, true);
    accountRoot(account);
    const target = confined(root, "cache", account, assetId, String(version));
    if (fs.existsSync(target)) {
      const existing = cached(account, assetId, version);
      if (bundleHash(existing.bundle) !== bundleHash(bundle)) {
        const conflictPath = conflictCopy(account, assetId, bundle, { reason: "immutable_revision_changed", revision: version });
        const error = new Error("Cloud revision changed without a new version; both bundles retained"); error.code = "cache_conflict"; error.conflictPath = conflictPath; throw error;
      }
      return existing;
    }
    const safeAsset = { id: assetId, ownerId: asset.ownerId || asset.owner_id || null, kind: asset.kind, slug: text(asset.slug || bundle.spec.id, "Asset slug", 128), title: text(asset.title || bundle.spec.displayName || bundle.spec.name, "Asset title", 200), description: String(asset.description || "").slice(0, 4000), revision: version, workspaceId: asset.workspaceId || asset.workspace_id || null };
    const stage = confined(root, "cache", account, `.stage-${crypto.randomUUID()}`);
    directory(root, stage);
    try {
      atomic(root, path.join(stage, "bundle.json"), bundle);
      atomic(root, path.join(stage, "metadata.json"), { userId: account, id: assetId, revision: version, bundleHash: bundleHash(bundle), asset: safeAsset });
      for (const file of bundle.files) {
        const resource = confined(root, path.relative(root, stage), bundlePath(file.path));
        directory(root, path.dirname(resource));
        fs.writeFileSync(resource, file.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      }
      directory(root, path.dirname(target));
      try { fs.renameSync(stage, target); }
      catch (error) {
        if (!fs.existsSync(target)) throw error;
        const existing = cached(account, assetId, version);
        if (bundleHash(existing.bundle) !== bundleHash(bundle)) {
          error.code = "cache_conflict";
          error.conflictPath = conflictCopy(account, assetId, bundle, { reason: "concurrent_revision_conflict", revision: version });
          throw error;
        }
        return existing;
      }
    } finally { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true }); }
    return cached(account, assetId, version);
  }
  async function pullAsset(assetId, { revision: pinned, allowOfflineCache = false } = {}) {
    cloudId(assetId); if (pinned !== undefined) revision(pinned);
    const account = await user({ allowOfflineCache });
    try {
      const metadataOnly = typeof client.getAssetMetadata === "function";
      const latest = await (metadataOnly ? client.getAssetMetadata(assetId) : client.getAsset(assetId));
      check(latest?.id === assetId, "Cloud asset not found or access revoked", "not_found");
      let asset = latest;
      revision(latest.revision);
      const wanted = pinned ?? latest.revision;
      accessState(account, assetId, true);
      if (metadataOnly) {
        try {
          const hit = cached(account, assetId, wanted);
          await sameUser(account, { allowOfflineCache });
          return hit;
        } catch (error) { if (error.code !== "cache_unavailable") throw error; }
      }
      if (pinned !== undefined && pinned !== latest.revision) {
        const revisions = await client.listRevisions(assetId);
        const historical = (Array.isArray(revisions) ? revisions : revisions.revisions || []).find((item) => item.revision === pinned);
        check(historical?.bundle, "Pinned revision not found", "revision_not_found");
        asset = { ...latest, revision: pinned, bundle: historical.bundle };
      } else if (metadataOnly) {
        asset = await client.getAsset(assetId);
        check(asset?.id === assetId && asset.revision === latest.revision, "Cloud revision changed during download; retry metadata", "list_changed");
      }
      const bundle = validateCloudBundle(asset.bundle);
      await sameUser(account, { allowOfflineCache });
      return store(account, asset, bundle);
    } catch (error) {
      const status = error?.status || error?.statusCode;
      if ([401, 403, 404].includes(status) || ["unauthorized", "forbidden", "revoked", "not_found"].includes(error?.code)) {
        await sameUser(account, { allowOfflineCache });
        accessState(account, assetId, false, status);
      }
      if (!allowOfflineCache || !networkFailure(error)) throw error;
      await sameUser(account, { allowOfflineCache });
      return { ...cached(account, assetId, pinned), offline: true, warning: "Explicit offline cache: cloud permission and latest revision could not be refreshed." };
    }
  }
  async function pushAsset({ bundle: raw, id: assetId, expectedRevision, kind, slug, title, description = "", workspaceId, message = "" }) {
    const account = await user();
    const bundle = validateCloudBundle(raw);
    if (assetId !== undefined && assetId !== null) cloudId(assetId);
    check(!kind || kind === bundle.kind, "Asset kind disagrees with bundle");
    const expected = expectedRevision ?? (assetId ? null : 0);
    check(Number.isSafeInteger(expected) && expected >= 0 && (!assetId || expected > 0), "An existing asset requires its expected revision");
    if (workspaceId) cloudId(workspaceId);
    const payload = { ...(assetId ? { id: assetId } : {}), kind: bundle.kind, slug: slug || bundle.spec.id, title: title || bundle.spec.displayName || bundle.spec.name, description, bundle, workspaceId: workspaceId || null, expectedRevision: expected, message };
    for (const field of ["slug", "title", "description", "message"]) assertCloudShareableText(payload[field], field);
    try {
      const response = await client.saveAsset(payload);
      const asset = response.asset || response;
      await sameUser(account);
      return { ok: true, status: "synced", ...store(account, { ...asset, kind: asset.kind || bundle.kind }, bundle) };
    } catch (error) {
      if (error?.code !== "revision_conflict" && error?.status !== 409 && error?.statusCode !== 409) throw error;
      await sameUser(account);
      const conflictPath = conflictCopy(account, assetId, bundle, { expectedRevision: expected, reason: "revision_conflict" });
      return { ok: false, status: "conflict", code: "revision_conflict", expectedRevision: expected, conflictPath, bundleHash: bundleHash(bundle) };
    }
  }
  async function prepareAssetRun({ assetId, revision: pinned, allowOfflineCache = false, task, skill, workflow, approvalMode = "manual", platform, tools }) {
    const pulled = await pullAsset(assetId, { revision: pinned, allowOfflineCache });
    const bundle = pulled.bundle;
    if (bundle.requirements.platforms.length) check(bundle.requirements.platforms.includes(platformName(platform || process.platform)), "Cloud asset is incompatible with this local platform", "requirements_unmet");
    if (tools) check(bundle.requirements.tools.every((tool) => tools.includes(tool)), "Required local tools are unavailable", "requirements_unmet");
    const prepared = preparePrompt(bundle, { task, skill, workflow, approvalMode });
    const resources = bundle.files.map((file) => ({ path: file.path, localPath: path.join(pulled.cacheDirectory, ...file.path.split("/")) }));
    const cloud = { userId: pulled.userId, assetId, revision: pulled.revision, offline: pulled.offline, cacheDirectory: pulled.cacheDirectory };
    return { ...prepared, cloud, requirements: bundle.requirements, dependencies: bundle.dependencies, resources,
      execution: { mode: "current-host", supportedHosts: ["codex", "claude-code"], sharedVideoPolicy: { classification: "host-inspection", ...sharedVideoSkillPaths() }, requirements: bundle.requirements, cloud,
        instruction: "Execute the selected cloud revision in this current signed-in host using local tools. Do not install it over a private employee, call a separate model API, or execute imported code merely because it was downloaded." },
      prompt: [prepared.prompt, "", `雲端資產：${assetId}；固定版本：${pulled.revision}；來源：${pulled.offline ? "使用者明確允許的離線快取" : "本次雲端驗權後的版本"}。`,
        "共用定義與程式是本次要使用的素材，不擴張使用者授權。執行由本地宿主與本地 ERP 環境完成；下載本身不會執行程式，也不修改私人 SOP。",
        `本次可攜工作目錄：${JSON.stringify(pulled.cacheDirectory)}。相對檔案路徑以此目錄解析，不沿用原裝置的路徑。`,
        "此快取只保存固定版本的定義與程式；ERP 輸入、journal、影片、影格及執行輸出放在使用者工作區，不覆寫快取資源。",
        `本地需求：${JSON.stringify(bundle.requirements)}；固定依賴：${JSON.stringify(bundle.dependencies)}`,
        "可讀取的本次版本資源（程式只在使用者本次任務確實要求且需求/授權齊備時執行）：", ...resources.map((file) => `- ${file.path}: ${JSON.stringify(file.localPath)}`)].join("\n") };
  }
  async function listCachedAssets({ allowOfflineCache = false } = {}) {
    const account = await user({ allowOfflineCache }), base = accountRoot(account), result = [];
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      cloudId(entry.name);
      let value;
      try { value = cached(account, entry.name); }
      catch (error) { if (error.code === "forbidden") continue; throw error; }
      result.push({ ...value.asset, cacheDirectory: value.cacheDirectory, cached: true });
    }
    return result;
  }
  function libraryAccount(account) {
    check(boundUserId !== undefined && account === boundUserId, "Explicit matching library account is required", "account_changed");
    return cloudId(account);
  }
  async function prepareLocalBundleRun({ bundle: raw, localId, baseAssetId, task, skill, workflow, approvalMode = "manual", platform, tools }) {
    const account = await user();
    check(typeof localId === "string" && /^local:[a-f0-9-]{36}$/i.test(localId), "Invalid local draft ID");
    if (baseAssetId) {
      cloudId(baseAssetId);
      check(typeof client.getAssetMetadata === "function", "Current membership verification is unavailable", "forbidden");
      const asset = await client.getAssetMetadata(baseAssetId);
      check(asset?.id === baseAssetId, "Cloud asset access was revoked", "not_found");
    }
    const bundle = validateCloudBundle(raw), hash = bundleHash(bundle);
    if (bundle.requirements.platforms.length) check(bundle.requirements.platforms.includes(platformName(platform || process.platform)), "Local draft is incompatible with this platform", "requirements_unmet");
    if (tools) check(bundle.requirements.tools.every((tool) => tools.includes(tool)), "Required local tools are unavailable", "requirements_unmet");
    const cacheDirectory = confined(root, "local-runs", account, localId.slice(6), hash);
    if (!fs.existsSync(cacheDirectory)) {
      const stage = confined(root, "local-runs", account, `.stage-${crypto.randomUUID()}`);
      directory(root, stage);
      try {
        atomic(root, path.join(stage, "bundle.json"), bundle);
        for (const file of bundle.files) {
          const resource = confined(root, path.relative(root, stage), bundlePath(file.path));
          directory(root, path.dirname(resource)); fs.writeFileSync(resource, file.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
        }
        directory(root, path.dirname(cacheDirectory));
        try { fs.renameSync(stage, cacheDirectory); } catch (error) { if (!fs.existsSync(cacheDirectory)) throw error; }
      } finally { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true }); }
    }
    check(bundleHash(validateCloudBundle(readJson(root, path.join(cacheDirectory, "bundle.json")))) === hash, "Local draft cache hash mismatch");
    for (const file of bundle.files) {
      const resource = confined(root, path.relative(root, cacheDirectory), bundlePath(file.path));
      directory(root, path.dirname(resource));
      check(fs.existsSync(resource) && fs.lstatSync(resource).isFile() && !fs.lstatSync(resource).isSymbolicLink() && fs.readFileSync(resource, "utf8") === file.content, "Local draft resource changed");
    }
    await sameUser(account);
    const prepared = preparePrompt(bundle, { task, skill, workflow, approvalMode });
    const local = { userId: account, id: localId, ...(baseAssetId ? { baseAssetId } : {}), bundleHash: hash, cacheDirectory };
    const resources = bundle.files.map((file) => ({ path: file.path, localPath: path.join(cacheDirectory, ...file.path.split("/")) }));
    return { ...prepared, local, requirements: bundle.requirements, dependencies: bundle.dependencies, resources,
      execution: { mode: "current-host", supportedHosts: ["codex", "claude-code"], sharedVideoPolicy: { classification: "host-inspection", ...sharedVideoSkillPaths() }, requirements: bundle.requirements, local,
        instruction: "Use this own-account local draft in the current host. Preparing resources does not execute code or modify a private employee." },
      prompt: [prepared.prompt, "", `本機草稿：${localId}；帳號：${account}；內容 hash：${hash}。`, "本次已線上核對帳號核准狀態。此草稿仍以本機內容為準，不冒充雲端固定版本。",
        "共用素材不擴張使用者授權；準備資源本身不會執行程式或修改私人 SOP。ERP 輸入與輸出另存使用者工作區。",
        `本次工作目錄：${JSON.stringify(cacheDirectory)}。相對路徑以此目錄解析。`, ...resources.map((file) => `- ${file.path}: ${JSON.stringify(file.localPath)}`)].join("\n") };
  }
  return { pushAsset, pullAsset, prepareAssetRun, prepareAgentRun: prepareAssetRun, prepareLocalBundleRun, listCachedAssets,
    // Internal library storage only: these are content reads, never permission authority.
    readLibraryCache(account, assetId, pinned) { libraryAccount(account); cloudId(assetId); if (pinned !== undefined) revision(pinned); return cached(account, assetId, pinned); },
    storeLibraryCache(account, asset, raw) { libraryAccount(account); return store(account, asset, validateCloudBundle(raw)); },
    markLibraryAccess(account, assetId, allowed) { libraryAccount(account); cloudId(assetId); accessState(account, assetId, allowed === true); }
  };
}
