import fs from 'node:fs';
import path from 'node:path';
export const fixtureUser = '10000000-0000-4000-8000-000000000001';
// Test-only network stub. Production code has no auth bypass or fixture flag.
export function approvedAccountFixture(root) {
  const previous = globalThis.fetch, directory = path.join(root, '.system', 'cloud');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'session.json'), JSON.stringify({ access_token: 'fixture-access', expires_at: Date.now()/1000+3600, user: { id: fixtureUser }, user_verified_at: Date.now() }));
  fs.writeFileSync(path.join(directory, 'legacy-owner.json'), JSON.stringify({ formatVersion: 1, userId: fixtureUser, agentIds: fs.readdirSync(root).filter(id => fs.existsSync(path.join(root,id,'agent.json'))) }));
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return previous(input, options);
    if (url.pathname === '/auth/v1/user') return Response.json({ id: fixtureUser, email: 'fixture@accounts.vixo.invalid', app_metadata: { vixo_username: 'fixture' } });
    if (url.pathname === '/rest/v1/rpc/vixo_my_access') return Response.json({ userId: fixtureUser, status: 'approved', isAdmin: false });
    if (url.pathname === '/rest/v1/vixo_assets') return Response.json([]);
    throw new Error('Unexpected fixture network path: '+url.pathname);
  };
  return () => { globalThis.fetch = previous; };
}
