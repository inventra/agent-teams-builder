const PAGES = new Set(['/', '/cloud.html']);

function embedRequestId(windowObject) {
  const requestId = windowObject.__VIXO_AGENTS_EMBED_REQUEST_ID__;
  return windowObject.parent !== windowObject && typeof requestId === 'string' && requestId.length > 0
    ? requestId : null;
}

export function navigateDashboard(path, { token = '', windowObject = globalThis.window } = {}) {
  if (!PAGES.has(path)) throw new TypeError('Unsupported Dashboard navigation path');
  const requestId = embedRequestId(windowObject);
  if (requestId) {
    // The opaque Codex frame is populated by its parent; it cannot navigate the
    // loopback document itself. Only the page and correlation ID cross this bridge.
    windowObject.parent.postMessage({ type: 'vixo-agents:navigate', path, requestId }, '*');
    return;
  }
  windowObject.location.assign(path + (token ? `?token=${encodeURIComponent(token)}` : ''));
}

export function notifyEmbedReady({ windowObject = globalThis.window } = {}) {
  const requestId = embedRequestId(windowObject);
  if (requestId) windowObject.parent.postMessage({ type: 'vixo-agents:ready', requestId }, '*');
}
