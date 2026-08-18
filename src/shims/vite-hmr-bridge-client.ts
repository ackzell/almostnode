/**
 * Browser-side Vite HMR WebSocket bridge.
 *
 * The real `@vite/client` connects over a native WebSocket to the Vite dev
 * server's port. Service workers cannot proxy WebSockets, so that connection
 * can never reach a virtual server inside almostnode. This shim replaces
 * `window.WebSocket` for connections whose subprotocol is `'vite-hmr'` (the
 * HMR transport) or `'vite-ping'` (vite's preflight/reconnect ping) and
 * tunnels them over a BroadcastChannel to the container's `ws` WebSocketServer
 * (see `src/shims/ws.ts`), where Vite's real HMR pipeline runs. All other
 * WebSocket connections fall through to the browser's native implementation
 * untouched.
 *
 * This code is served as the first lines of the `/@vite/client` module (see
 * `src/vite-hmr-inject.ts`), so it runs before the client module itself.
 */
export const VITE_HMR_BRIDGE_CLIENT = `
(function () {
  if (typeof window === 'undefined') return;
  if (window.__almostnodeViteHmrBridge) return;
  try { Object.defineProperty(window, '__almostnodeViteHmrBridge', { value: true }); } catch (e) {}

  var NativeWebSocket = window.WebSocket;
  if (!NativeWebSocket || typeof BroadcastChannel === 'undefined') return;

  function hmrLog() {
    if (!window.__ALMOSTNODE_HMR_DIAG__) return;
    try { console.log.apply(console, ['[almostnode-hmr]'].concat(Array.prototype.slice.call(arguments))); } catch (e) {}
  }

  var CHANNEL = 'vite-hmr-bridge';
  var BRIDGED_PROTOCOLS = ['vite-hmr', 'vite-ping'];
  var CONNECTING = 0;
  var OPEN = 1;
  var CLOSING = 2;
  var CLOSED = 3;

  function _makeCloseEvent(init) {
    if (typeof CloseEvent === 'function') {
      return new CloseEvent('close', {
        code: init.code || 1000,
        reason: init.reason || '',
        wasClean: init.wasClean !== false
      });
    }
    var evt = new Event('close');
    evt.code = init.code || 1000;
    evt.reason = init.reason || '';
    evt.wasClean = init.wasClean !== false;
    return evt;
  }

  function ViteHmrWebSocket(url, protocols) {
    var protoArr = Array.isArray(protocols) ? protocols : (protocols ? [protocols] : []);
    var bridged = null;
    for (var i = 0; i < BRIDGED_PROTOCOLS.length; i++) {
      if (protoArr.indexOf(BRIDGED_PROTOCOLS[i]) !== -1) {
        bridged = BRIDGED_PROTOCOLS[i];
        break;
      }
    }
    if (!bridged) {
      return new NativeWebSocket(url, protocols);
    }

    this.url = String(url);
    this.readyState = CONNECTING;
    this.protocol = bridged;
    this.binaryType = 'blob';
    this.bufferedAmount = 0;
    this.extensions = '';
    this.CONNECTING = CONNECTING;
    this.OPEN = OPEN;
    this.CLOSING = CLOSING;
    this.CLOSED = CLOSED;

    this._listeners = {};
    this._bc = null;
    this._opened = false;
    this._onMessageBound = this._onMessage.bind(this);
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;

    var self = this;
    var id = 'bridge-' + Math.random().toString(36).slice(2) + Date.now();
    this._id = id;

    var bc;
    try {
      bc = new BroadcastChannel(CHANNEL);
    } catch (e) {
      bc = null;
    }
    if (!bc) {
      setTimeout(function () {
        self._dispatch('error', new Event('error'));
        self._fail('BroadcastChannel unavailable', 1006);
      }, 0);
      return;
    }
    this._bc = bc;
    bc.addEventListener('message', this._onMessageBound);

    setTimeout(function () {
      if (!self._opened && self.readyState !== CLOSED) {
        try { bc.postMessage({ type: 'disconnect', clientId: id }); } catch (e) {}
        self._fail('No HMR server reached', 1006);
      }
    }, 4000);

    try { hmrLog('bridge connect', bridged, this.url); } catch (e) {}
    bc.postMessage({ type: 'connect', clientId: id, url: this.url, protocol: bridged });
  }

  ViteHmrWebSocket.prototype._onMessage = function (event) {
    var data = event.data;
    if (!data || data.targetClient !== this._id) return;
    try { hmrLog('bridge client recv', data.type, data.type === 'message' ? String(data.payload).slice(0, 100) : ''); } catch (e) {}

    if (data.type === 'connected') {
      if (this.readyState === CONNECTING) {
        this.readyState = OPEN;
        this._opened = true;
        this._dispatch('open', new Event('open'));
      }
    } else if (data.type === 'message') {
      var evt = typeof MessageEvent === 'function'
        ? new MessageEvent('message', { data: data.payload })
        : { type: 'message', data: data.payload };
      this._dispatch('message', evt);
    } else if (data.type === 'close') {
      if (this.readyState !== CLOSED) {
        this.readyState = CLOSED;
        this._dispatch('close', _makeCloseEvent(data));
        this._closeBc();
      }
    }
  };

  ViteHmrWebSocket.prototype._fail = function (reason, code) {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this._dispatch('close', _makeCloseEvent({ code: code, reason: reason, wasClean: false }));
    this._closeBc();
  };

  ViteHmrWebSocket.prototype._closeBc = function () {
    if (this._bc) {
      try { this._bc.removeEventListener('message', this._onMessageBound); } catch (e) {}
      try { this._bc.close(); } catch (e) {}
      this._bc = null;
    }
  };

  ViteHmrWebSocket.prototype.send = function (data) {
    if (this.readyState !== OPEN) {
      throw new Error('WebSocket is not open');
    }
    var payload = typeof data === 'string' ? data : String(data);
    this._bc.postMessage({ type: 'message', clientId: this._id, payload: payload });
  };

  ViteHmrWebSocket.prototype.close = function (code, reason) {
    if (this.readyState === CLOSED || this.readyState === CLOSING) return;
    this.readyState = CLOSING;
    if (this._bc) {
      try {
        this._bc.postMessage({
          type: 'disconnect',
          clientId: this._id,
          code: code || 1000,
          reason: reason || ''
        });
      } catch (e) {}
    }
    var self = this;
    setTimeout(function () {
      if (self.readyState !== CLOSED) {
        self.readyState = CLOSED;
        self._dispatch('close', _makeCloseEvent({ code: code || 1000, reason: reason || '', wasClean: true }));
        self._closeBc();
      }
    }, 0);
  };

  ViteHmrWebSocket.prototype.addEventListener = function (type, fn) {
    var list = this._listeners[type] || (this._listeners[type] = []);
    list.push(fn);
  };

  ViteHmrWebSocket.prototype.removeEventListener = function (type, fn) {
    var list = this._listeners[type];
    if (!list) return;
    var i = list.length;
    while (i--) {
      if (list[i] === fn) { list.splice(i, 1); return; }
    }
  };

  ViteHmrWebSocket.prototype.dispatchEvent = function (evt) {
    this._dispatch(evt.type, evt);
    return true;
  };

  ViteHmrWebSocket.prototype._dispatch = function (type, evt) {
    var list = this._listeners[type];
    if (list) {
      for (var i = 0; i < list.length; i++) {
        try { list[i].call(this, evt); } catch (e) { setTimeout(function () { throw e; }, 0); }
      }
    }
    var prop = this['on' + type];
    if (typeof prop === 'function') {
      try { prop.call(this, evt); } catch (e) { setTimeout(function () { throw e; }, 0); }
    }
  };

  ViteHmrWebSocket.CONNECTING = CONNECTING;
  ViteHmrWebSocket.OPEN = OPEN;
  ViteHmrWebSocket.CLOSING = CLOSING;
  ViteHmrWebSocket.CLOSED = CLOSED;

  try {
    window.WebSocket = ViteHmrWebSocket;
  } catch (e) {}
})();
`;