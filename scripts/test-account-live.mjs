// Explicit operator-run live test. Every write is limited to the isolated QA
// identity below or new identities invited into its newly created QA workspace.
// Do not run against an end user's session. Never log API bodies or credentials.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { createCloudClient } from '../plugins/agent-teams-builder/web/cloud-client.mjs';

const QA_ID = '80f233b3-8d76-4949-a038-e46fa55ddb8c';
// Optional additional guard; never publish an actual end user's UUID in source.
const PROTECTED_OWNER_ID = process.env.VIXO_PROTECTED_OWNER_ID;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'output/account-verification');
const sessionPath = path.join(root, 'output/cloud-verification/qa.session.json');
const credentialPath = path.join(output, 'qa-credentials.json');
const reportPath = path.join(output, 'live-report.json');
const passed = [];
let activeCheck = 'validate isolated QA session';
let reportReady = false;

function writePrivate(file, value) {
  if (fs.existsSync(file)) assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
function readPrivate(file) {
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(file).isFile(), true);
  fs.chmodSync(file, 0o600);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function mark(label) {
  passed.push(label);
  if (reportReady) writePrivate(reportPath, { passed });
  console.log(`PASS ${label}`);
}
function credentials() {
  return { username: `qa_${randomBytes(10).toString('hex')}`, password: `Qa!${randomBytes(24).toString('base64url')}` };
}
function assertCredentials(value) {
  assert.equal(typeof value?.username, 'string');
  assert.match(value.username, /^qa_[a-z0-9_-]{3,28}$/);
  assert.equal(typeof value.password, 'string');
  assert.ok([...value.password].length >= 12);
  assert.ok(new TextEncoder().encode(value.password).length <= 72);
}
function assertIdentity(user, expected) {
  assert.ok(user?.id);
  assert.notEqual(user.id, PROTECTED_OWNER_ID);
  assert.equal(user.id, expected);
}
function privateSnapshot(rows) {
  for (const row of rows) {
    assert.equal(row.owner_id, QA_ID);
    assert.equal(row.workspace_id, null);
    assert.ok(Number.isInteger(row.revision) && row.revision > 0);
  }
  return rows.map(({ id, revision }) => ({ id, revision })).sort((a, b) => a.id.localeCompare(b.id));
}

async function run() {
  assert.ok(process.env.VIXO_QA_SESSION_FILE);
  assert.equal(path.resolve(process.env.VIXO_QA_SESSION_FILE), sessionPath);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'plugins/agent-teams-builder/web/cloud-config.json'), 'utf8'));
  // Pin the QA project too; an accidental config change must not run these writes elsewhere.
  assert.equal(new URL(config.url).origin, 'https://rbyjxnklfepeevoehtjn.supabase.co');
  function harness(initial = null, file = null) {
    let session = initial;
    let verified = false;
    const client = createCloudClient({ ...config, getSession: () => session, saveSession: value => {
      session = value;
      if (verified && file) writePrivate(file, value);
    } });
    return { client, session: () => session, persistVerified() { verified = true; if (file) writePrivate(file, session); } };
  }
  let primary = harness(readPrivate(sessionPath), sessionPath);
  const initialUser = await primary.client.getUser();
  assertIdentity(initialUser, QA_ID);
  primary.persistVerified();
  mark('session belongs to the isolated QA identity');

  if (fs.existsSync(output)) assert.equal(fs.lstatSync(output).isSymbolicLink(), false);
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  fs.chmodSync(output, 0o700);
  reportReady = true;
  writePrivate(reportPath, { passed });
  const existingCredentials = fs.existsSync(credentialPath);
  let saved;
  if (existingCredentials) {
    saved = readPrivate(credentialPath);
    assert.equal(saved.formatVersion, 1);
    assert.equal(saved.qaUserId, QA_ID);
    assertCredentials(saved.primary);
    assert.ok(Array.isArray(saved.runs));
  } else {
    // Never generate replacement credentials for an already configured identity.
    assert.equal(initialUser.accountConfigured, false);
    saved = { formatVersion: 1, qaUserId: QA_ID, primary: credentials(), runs: [] };
    writePrivate(credentialPath, saved);
  }
  const save = () => writePrivate(credentialPath, saved);
  activeCheck = 'snapshot existing QA private assets';
  const before = privateSnapshot(await primary.client.listAssets({ workspaceId: null }));
  assert.ok(before.length > 0, 'QA fixture must already have private assets');
  mark('existing QA private assets captured without modification');

  activeCheck = 'bind or reuse credentials on the same QA identity';
  if (initialUser.accountConfigured) {
    assert.equal(initialUser.username, saved.primary.username);
    const resumed = harness(null, sessionPath);
    await resumed.client.signInWithPassword(saved.primary);
    assertIdentity(await resumed.client.getUser(), QA_ID);
    resumed.persistVerified();
    primary = resumed;
    mark('saved credentials reused without resetting the account');
  } else {
    // Persisted credentials are reused after an interrupted pre-binding run.
    // setupAccount deliberately has no automatic write retry.
    await primary.client.setupAccount(saved.primary);
    const bound = await primary.client.getUser();
    assertIdentity(bound, QA_ID);
    assert.equal(bound.username, saved.primary.username);
    assert.equal(bound.accountConfigured, true);
    mark('account binding preserves the original QA UUID');
  }
  assert.deepEqual(privateSnapshot(await primary.client.listAssets({ workspaceId: null })), before);
  mark('account binding preserves private asset IDs and revisions');

  activeCheck = 'fresh client password login and failed login preservation';
  const fresh = harness();
  await fresh.client.signInWithPassword(saved.primary);
  assertIdentity(await fresh.client.getUser(), QA_ID);
  assert.deepEqual(privateSnapshot(await fresh.client.listAssets({ workspaceId: null })), before);
  mark('fresh password login restores the same identity and assets');
  const sessionBeforeWrongPassword = JSON.stringify(fresh.session());
  await assert.rejects(fresh.client.signInWithPassword({ username: saved.primary.username, password: credentials().password }), { code: 'invalid_credentials' });
  assert.equal(JSON.stringify(fresh.session()), sessionBeforeWrongPassword);
  assertIdentity(await fresh.client.getUser(), QA_ID);
  mark('wrong password cannot replace an existing session');

  const record = { id: randomBytes(8).toString('hex'), rebindAttempt: credentials(), collision: credentials(), concurrent: [credentials(), credentials()] };
  saved.runs.push(record); save();
  async function latestToken(target, expected) {
    assertIdentity(await target.client.getUser(), expected);
    // getUser may refresh. Never use the token from the initial session file.
    const token = target.session()?.access_token;
    assert.equal(typeof token, 'string'); assert.ok(token);
    return token;
  }
  async function rawAccount(body, token) {
    const response = await fetch(`${config.url}/functions/v1/vixo-account`, {
      method: 'POST', headers: { apikey: config.key, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }
  activeCheck = 'reject rebinding of a configured account';
  await assert.rejects(primary.client.setupAccount(record.rebindAttempt), { status: 409, code: 'account_already_bound' });
  const rebound = await rawAccount(record.rebindAttempt, await latestToken(primary, QA_ID));
  assert.equal(rebound.status, 409); assert.equal(rebound.body?.code, 'account_already_bound');
  mark('configured accounts reject client and direct API rebinding');

  activeCheck = 'reject unauthorized and extra-field account requests';
  const unauthenticated = await rawAccount(record.rebindAttempt);
  assert.equal(unauthenticated.status, 401);
  const extraField = await rawAccount({ ...record.rebindAttempt, userId: QA_ID }, await latestToken(primary, QA_ID));
  assert.equal(extraField.status, 400); assert.equal(extraField.body?.code, 'invalid_request');
  mark('account API rejects unauthorized requests and extra userId fields');

  activeCheck = 'create isolated QA workspace and invited identities';
  const workspace = await primary.client.createWorkspace(`VIXO 帳密驗證 ${record.id}（隔離 QA）`);
  const workspaceRow = (await primary.client.listWorkspaces()).find(row => row.id === workspace.id);
  assert.equal(workspaceRow?.owner_id, QA_ID);
  record.workspaceId = workspace.id; save();
  async function invitedIdentity(label) {
    const invite = await primary.client.createInvite(workspace.id, 'viewer');
    const target = harness(null, path.join(output, `${record.id}-${label}.session.json`));
    await target.client.pairDevice(invite.code);
    const user = await target.client.getUser();
    assert.match(user?.id || '', /^[a-f0-9-]{36}$/i);
    assert.notEqual(user.id, QA_ID); assert.notEqual(user.id, PROTECTED_OWNER_ID);
    assert.equal(user.accountConfigured, false);
    assert.equal((await target.client.listWorkspaces()).some(row => row.id === workspace.id), true);
    target.persistVerified();
    return { target, id: user.id };
  }
  const collision = await invitedIdentity('collision');
  record.collision.userId = collision.id; save();
  mark('new QA identity is invited only into the QA workspace');

  activeCheck = 'reject duplicate username then bind a unique username';
  await assert.rejects(collision.target.client.setupAccount({ username: saved.primary.username, password: record.collision.password }), { status: 409, code: 'username_unavailable' });
  const afterCollision = await collision.target.client.getUser();
  assertIdentity(afterCollision, collision.id); assert.equal(afterCollision.accountConfigured, false);
  await collision.target.client.setupAccount(record.collision);
  assertIdentity(await collision.target.client.getUser(), collision.id);
  const collisionFresh = harness();
  await collisionFresh.client.signInWithPassword(record.collision);
  assertIdentity(await collisionFresh.client.getUser(), collision.id);
  mark('duplicate username is rejected and a unique username succeeds');

  activeCheck = 'durable claim allows exactly one concurrent binding';
  const concurrent = await invitedIdentity('concurrent');
  assert.notEqual(concurrent.id, collision.id);
  record.concurrentUserId = concurrent.id; save();
  const token = await latestToken(concurrent.target, concurrent.id);
  const responses = await Promise.all(record.concurrent.map(value => rawAccount(value, token)));
  assert.deepEqual(responses.map(value => value.status).sort(), [200, 409]);
  const winner = responses.findIndex(value => value.status === 200);
  const loser = responses[1 - winner];
  assert.ok(['account_bind_in_progress', 'account_already_bound'].includes(loser.body?.code));
  assertIdentity(responses[winner].body?.user, concurrent.id);
  record.concurrentWinner = winner; save();
  const concurrentFresh = harness(null, path.join(output, `${record.id}-concurrent.session.json`));
  await concurrentFresh.client.signInWithPassword(record.concurrent[winner]);
  assertIdentity(await concurrentFresh.client.getUser(), concurrent.id);
  concurrentFresh.persistVerified();
  mark('concurrent setup returns exactly one success and one durable rejection');

  activeCheck = 'verify original QA credentials and assets remain unchanged';
  const finalLogin = harness(null, sessionPath);
  await finalLogin.client.signInWithPassword(saved.primary);
  assertIdentity(await finalLogin.client.getUser(), QA_ID);
  finalLogin.persistVerified();
  assert.deepEqual(privateSnapshot(await finalLogin.client.listAssets({ workspaceId: null })), before);
  mark('original QA account and private revisions remain unchanged after all checks');
}

try { await run(); }
catch {
  // Avoid assertion diffs, request bodies, API messages and stack traces: any
  // of them could contain the random credentials or a session response.
  if (reportReady) { try { writePrivate(reportPath, { passed }); } catch {} }
  console.error(`Live account verification stopped during: ${activeCheck}. Sensitive details were suppressed.`);
  process.exitCode = 1;
}
