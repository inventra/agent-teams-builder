import test from 'node:test';
import assert from 'node:assert/strict';
import { navigateDashboard, notifyEmbedReady } from '../plugins/agent-teams-builder/web/embed-navigation.mjs';

function surface({ embedded = true, requestId = 'fixture-frame-1' } = {}) {
  const messages = [], destinations = [];
  const windowObject = {
    location: { assign: value => destinations.push(value) },
    __VIXO_AGENTS_EMBED_REQUEST_ID__: requestId,
    postMessage: (message, origin) => messages.push({ message, origin })
  };
  windowObject.parent = embedded ? { postMessage: (message, origin) => messages.push({ message, origin }) } : windowObject;
  return { windowObject, messages, destinations };
}

test('injected frames request allowlisted navigation without native navigation or bearer exposure', () => {
  const target = surface();
  for (const path of ['/cloud.html', '/']) navigateDashboard(path, { windowObject: target.windowObject, token: 'fixture-local-bearer' });
  assert.deepEqual(target.destinations, []);
  assert.deepEqual(target.messages, ['/cloud.html', '/'].map(path => ({
    message: { type: 'vixo-agents:navigate', path, requestId: 'fixture-frame-1' }, origin: '*'
  })));
  assert.ok(!JSON.stringify(target.messages).includes('fixture-local-bearer'));
});

test('standalone browsers retain encoded local bearer in normal navigation', () => {
  const target = surface({ embedded: false });
  navigateDashboard('/cloud.html', { windowObject: target.windowObject, token: 'fixture +&/token' });
  navigateDashboard('/', { windowObject: target.windowObject, token: 'fixture +&/token' });
  assert.deepEqual(target.destinations, ['/cloud.html?token=fixture%20%2B%26%2Ftoken', '/?token=fixture%20%2B%26%2Ftoken']);
  assert.deepEqual(target.messages, []);
});

test('an unrelated iframe without an injected request ID does not wait on an embed loader', () => {
  for (const requestId of [undefined, '', null]) {
    const target = surface({ requestId: null });
    target.windowObject.__VIXO_AGENTS_EMBED_REQUEST_ID__ = requestId;
    navigateDashboard('/cloud.html', { windowObject: target.windowObject, token: 'fixture' });
    notifyEmbedReady({ windowObject: target.windowObject });
    assert.deepEqual(target.destinations, ['/cloud.html?token=fixture']);
    assert.deepEqual(target.messages, []);
  }
});

test('navigation rejects external URLs, query strings and every non-allowlisted path', () => {
  const target = surface();
  for (const path of ['https://example.invalid/', '//example.invalid/', '/other', '/cloud.html?token=x', '/#x', '/cloud.html/../', '', null]) {
    assert.throws(() => navigateDashboard(path, { windowObject: target.windowObject }), /navigation path/i);
  }
  assert.deepEqual(target.messages, []);
  assert.deepEqual(target.destinations, []);
});

test('ready correlates with the injected request ID and does not notify from standalone pages', () => {
  const target = surface();
  notifyEmbedReady({ windowObject: target.windowObject });
  assert.deepEqual(target.messages, [{ message: { type: 'vixo-agents:ready', requestId: 'fixture-frame-1' }, origin: '*' }]);
  const standalone = surface({ embedded: false });
  notifyEmbedReady({ windowObject: standalone.windowObject });
  assert.deepEqual(standalone.messages, []);
});
