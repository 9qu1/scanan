/* cfio（画面側）: socket.io-client の代わり（Cloudflare の Durable Object の cfio サーバーにつなぐ）
 *   各ゲームの public/socket.io/socket.io.js に置く（HTML の <script src="socket.io/socket.io.js"> はそのまま）
 *   つなぎ先: 本番の画面（9qu1.com/〇〇/）は <meta name="cfio-endpoint" content="https://〇〇.nakamido.workers.dev"> の住所、
 *             それ以外（手元・workers.dev で直接）は同じ場所。道は /socket
 *   使える物: io(opts) / socket.on・once・off・emit（最後が関数なら返事つき）・timeout(ms).emit・connect()・open()・disconnect()・close()
 *             socket.connected・disconnected・id・io.on('packet'|'ping'|'reconnect'|'reconnect_attempt'|'reconnect_error'|'open'|'close')
 *             'connect'・'disconnect'（理由: 'io server disconnect'・'io client disconnect'・'transport close'・'ping timeout'）・'connect_error'
 *   つながっていないあいだの emit は、Socket.IO と同じくためておき、つながったら送る
 *   opts: reconnection（既定 true）・reconnectionDelay（1000）・reconnectionDelayMax（5000）・randomizationFactor（0.5）・auth・autoConnect
 */
(function (root) {
  'use strict';

  function Emitter() { this._h = {}; }
  Emitter.prototype.on = function (ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; };
  Emitter.prototype.addEventListener = Emitter.prototype.on;
  Emitter.prototype.once = function (ev, fn) {
    var self = this;
    function w() { self.off(ev, w); fn.apply(self, arguments); }
    w._fn = fn;
    return this.on(ev, w);
  };
  Emitter.prototype.off = function (ev, fn) {
    if (!ev) { this._h = {}; return this; }
    if (!fn) { delete this._h[ev]; return this; }
    var l = this._h[ev];
    if (l) this._h[ev] = l.filter(function (f) { return f !== fn && f._fn !== fn; });
    return this;
  };
  Emitter.prototype.removeListener = Emitter.prototype.off;
  Emitter.prototype.removeAllListeners = function (ev) { return this.off(ev); };
  Emitter.prototype._fire = function (ev) {
    var l = this._h[ev];
    if (!l) return;
    var args = Array.prototype.slice.call(arguments, 1);
    l.slice().forEach(function (f) {
      try { f.apply(null, args); } catch (e) { setTimeout(function () { throw e; }); }
    });
  };
  Emitter.prototype.listeners = function (ev) { return (this._h[ev] || []).slice(); };
  Emitter.prototype.hasListeners = function (ev) { return !!(this._h[ev] && this._h[ev].length); };

  var PROD_HOSTS = ['9qu1.com', '9qu1.github.io'];

  function endpoint(url) {
    if (url) return String(url).replace(/\/$/, '');
    var loc = root.location;
    var doc = root.document;
    if (loc && doc && PROD_HOSTS.indexOf(loc.hostname) >= 0) {
      var m = doc.querySelector('meta[name="cfio-endpoint"]');
      if (m && m.content) return m.content.replace(/\/$/, '');
    }
    return loc ? loc.origin : 'http://localhost';
  }

  function Socket(url, opts) {
    Emitter.call(this);
    opts = opts || {};
    this.opts = opts;
    this.base = endpoint(url);
    this.id = undefined;
    this.connected = false;
    this.disconnected = true;
    this.active = false;
    this.auth = opts.auth || {};
    this.io = new Emitter();
    this.io.opts = opts;
    this.io.engine = { transport: { name: 'websocket' } };
    var self = this;
    this.io.reconnection = function (v) { if (v === undefined) return self.opts.reconnection !== false; self.opts.reconnection = v; return self.io; };
    this._ws = null;
    this._sendBuf = [];
    this._ackSeq = 0;
    this._acks = {};
    this._attempts = 0;
    this._rt = null;
    this._wd = null;
    this._lastRx = 0;
    this._pi = 25000;
    this._pt = 20000;
    this._manual = false;
    if (opts.autoConnect !== false) this.connect();
  }
  Socket.prototype = Object.create(Emitter.prototype);
  Socket.prototype.constructor = Socket;

  Socket.prototype.connect = function () {
    if (this.connected || (this._ws && this._ws.readyState <= 1)) return this;
    this._manual = false;
    this.active = true;
    clearTimeout(this._rt);
    this._open();
    return this;
  };
  Socket.prototype.open = Socket.prototype.connect;

  Socket.prototype._open = function () {
    var self = this;
    var url = this.base.replace(/^http/, 'ws') + '/socket?auth=' + encodeURIComponent(JSON.stringify(typeof this.auth === 'function' ? {} : (this.auth || {})));
    var ws;
    try { ws = new root.WebSocket(url); } catch (e) { this._fail(null, e); return; }
    this._ws = ws;
    var opened = false;
    ws.onopen = function () { if (self._ws !== ws) return; self._lastRx = Date.now(); };
    ws.onmessage = function (e) {
      if (self._ws !== ws) return;
      self._lastRx = Date.now();
      self.io._fire('packet', e.data);
      var m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.t === 'open') {
        opened = true;
        self._pi = m.pi || self._pi;
        self._pt = m.pt || self._pt;
        self.io.engine._pingInterval = self._pi; // Socket.IO と同じ名前（試験が見る）
        self.io.engine._pingTimeout = self._pt;
        self.id = m.sid;
        self.connected = true;
        self.disconnected = false;
        var wasRe = self._attempts > 0;
        self._attempts = 0;
        self._watch();
        self.io._fire('open');
        if (wasRe) self.io._fire('reconnect', 1);
        self._fire('connect');
        var buf = self._sendBuf;
        self._sendBuf = [];
        buf.forEach(function (s) { self._raw(s); });
        return;
      }
      self._onMessage(m);
    };
    ws.onclose = ws.onerror = function () {
      if (self._ws !== ws) return;
      if (!opened) self._fail(ws, new Error('websocket error'));
      else self._lost(ws, 'transport close');
    };
  };

  // サーバーからの ping が pingInterval＋pingTimeout とどかなければ、死んだ接続として張りなおす
  Socket.prototype._watch = function () {
    var self = this;
    clearInterval(this._wd);
    this._wd = setInterval(function () {
      if (!self.connected) return;
      if (Date.now() - self._lastRx > self._pi + self._pt) self._lost(self._ws, 'ping timeout');
    }, 1000);
  };

  Socket.prototype._fail = function (ws, err) {
    if (ws && this._ws !== ws) return;
    this._ws = null;
    var e = err instanceof Error ? err : new Error('websocket error');
    e.type = 'TransportError';
    this._fire('connect_error', e);
    if (this._attempts > 0) this.io._fire('reconnect_error', e);
    this._schedule();
  };

  Socket.prototype._lost = function (ws, reason) {
    if (ws && this._ws !== ws) return;
    var w = this._ws;
    this._ws = null;
    if (w) { w.onopen = w.onmessage = w.onclose = w.onerror = null; try { w.close(); } catch (e) { /* もう閉じている */ } }
    clearInterval(this._wd);
    var was = this.connected;
    this.connected = false;
    this.disconnected = true;
    this.id = undefined;
    this._failAcks();
    this.io._fire('close', reason);
    if (was) this._fire('disconnect', reason);
    if (reason === 'io server disconnect' || reason === 'io client disconnect') { this.active = false; return; }
    this._schedule();
  };

  Socket.prototype._schedule = function () {
    var o = this.opts;
    if (o.reconnection === false || this._manual) { this.active = false; return; }
    var self = this;
    clearTimeout(this._rt);
    var base = o.reconnectionDelay != null ? o.reconnectionDelay : 1000;
    var max = o.reconnectionDelayMax != null ? o.reconnectionDelayMax : 5000;
    var rf = o.randomizationFactor != null ? o.randomizationFactor : 0.5;
    var d = Math.min(max, base * Math.pow(2, this._attempts));
    if (rf) { var dev = Math.random() * rf * d; d = Math.floor(Math.random() * 2) === 0 ? d - dev : d + dev; }
    d = Math.min(max, Math.max(0, d));
    this._attempts++;
    this._rt = setTimeout(function () {
      if (self._manual) return;
      self.io._fire('reconnect_attempt', self._attempts);
      self._open();
    }, d);
  };

  Socket.prototype._failAcks = function () { this._acks = {}; };

  Socket.prototype._raw = function (s) {
    if (!this._ws || this._ws.readyState !== 1) return false;
    try { this._ws.send(s); return true; } catch (e) { return false; }
  };

  Socket.prototype._onMessage = function (m) {
    var self = this;
    if (m.t === 'ping') { this.io._fire('ping'); this._raw('{"t":"pong"}'); return; }
    if (m.t === 'pong') return;
    if (m.t === 'x') { this._lost(this._ws, 'io server disconnect'); return; }
    if (m.t === 'ack') {
      var cb = this._acks[m.id];
      if (cb) { delete this._acks[m.id]; cb.apply(null, Array.isArray(m.a) ? m.a : []); }
      return;
    }
    if (m.t === 'e') {
      var args = Array.isArray(m.a) ? m.a.slice() : [];
      if (m.id != null) {
        var sent = false;
        args.push(function () {
          if (sent) return;
          sent = true;
          self._raw(JSON.stringify({ t: 'ack', id: m.id, a: Array.prototype.slice.call(arguments) }));
        });
      }
      this._fire.apply(this, [m.ev].concat(args));
    }
  };

  Socket.prototype.emit = function (ev) {
    if (ev === 'connect' || ev === 'disconnect' || ev === 'connect_error') { this._fire.apply(this, arguments); return this; }
    var args = Array.prototype.slice.call(arguments, 1);
    var msg = { t: 'e', ev: ev, a: args };
    if (typeof args[args.length - 1] === 'function') {
      var cb = args.pop();
      var id = ++this._ackSeq;
      this._acks[id] = cb;
      msg.id = id;
    }
    var s = JSON.stringify(msg);
    if (this.connected) this._raw(s);
    else this._sendBuf.push(s);
    return this;
  };
  Socket.prototype.send = function () { return this.emit.apply(this, ['message'].concat(Array.prototype.slice.call(arguments))); };

  // 返事つきで送り、ms のあいだに返事がなければ cb(err)
  Socket.prototype.timeout = function (ms) {
    var self = this;
    return {
      emit: function (ev) {
        var args = Array.prototype.slice.call(arguments, 1);
        var cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
        if (!cb) return self.emit.apply(self, [ev].concat(args));
        var done = false;
        var t = setTimeout(function () { if (!done) { done = true; cb(new Error('operation has timed out')); } }, ms);
        return self.emit.apply(self, [ev].concat(args, [function () {
          if (done) return;
          done = true;
          clearTimeout(t);
          cb.apply(null, [null].concat(Array.prototype.slice.call(arguments)));
        }]));
      },
    };
  };

  Socket.prototype.disconnect = function () {
    this._manual = true;
    clearTimeout(this._rt);
    if (this._ws) {
      if (this.connected) this._raw('{"t":"bye"}');
      this._lost(this._ws, 'io client disconnect');
    } else {
      this.active = false;
    }
    this._sendBuf = [];
    return this;
  };
  Socket.prototype.close = Socket.prototype.disconnect;
  Socket.prototype.compress = function () { return this; };
  Object.defineProperty(Socket.prototype, 'volatile', { get: function () { return this; } });

  function io(url, opts) {
    if (url && typeof url === 'object') { opts = url; url = undefined; }
    return new Socket(url, opts || {});
  }
  io.Socket = Socket;
  io.protocol = 'cfio-1';
  io.connect = io;
  // HTTP の API の前につける住所（本番の画面は通信の Worker・手元は ''＝同じ場所）: fetch(io.apiBase() + '/api/genres')
  io.apiBase = function () {
    var e = endpoint();
    return root.location && e === root.location.origin ? '' : e;
  };

  root.io = io;
  if (typeof module !== 'undefined' && module.exports) module.exports = { io: io, Socket: Socket };
})(typeof self !== 'undefined' ? self : globalThis);
