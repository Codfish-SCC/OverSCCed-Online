/* OverSCCed browser MQTT 3.1.1 client over WebSocket — no third-party code.
 * Exposes window.mqtt = { connect } for MQTTNet. Uses TextEncoder/ArrayBuffer.
 * Tested against broker-cn.emqx.io: QoS 0/1, retained, SUBACK callbacks,
 * auto-reconnect with resubscribe. */
(function () {
  "use strict";

  var te = new TextEncoder(), td = new TextDecoder();

  function utf8(s) {
    var b = te.encode(s);
    var out = new Uint8Array(b.length + 2);
    out[0] = (b.length >> 8) & 0xff; out[1] = b.length & 0xff;
    out.set(b, 2);
    return out;
  }
  function concat() {
    var total = 0, i;
    for (i = 0; i < arguments.length; i++) total += arguments[i].length;
    var out = new Uint8Array(total), off = 0;
    for (i = 0; i < arguments.length; i++) { out.set(arguments[i], off); off += arguments[i].length; }
    return out;
  }
  function frameHeader(first, len) {
    var parts = [first], l = len;
    do {
      var b = l % 128; l = Math.floor(l / 128);
      if (l > 0) b |= 0x80;
      parts.push(b);
    } while (l > 0);
    return Uint8Array.from(parts);
  }
  function packet(first, body) { return concat(frameHeader(first, body.length), body); }

  function MQTTBrowser(url, opts) {
    opts = opts || {};
    var em = {
      options: { will: null },
      connected: false,
      on: on, once: once, removeListener: removeListener, emit: emit,
      end: function () { ended = true; try { ws && ws.close(); } catch (e) {} },
      reconnect: function () { em.connected = false; connectWS(); },
      subscribe: function (topic, qos, cb) {
        subs.push({ topic: topic, qos: (qos && qos.qos) || 0 });
        whenReady(function () { sendSubscribe(topic, (qos && qos.qos) || 0, cb); });
        return em;
      },
      unsubscribe: function (topic) { whenReady(function () { sendUnsubscribe(topic); }); return em; },
      publish: function (topic, payload, options) {
        options = options || {};
        var buf = typeof payload === "string" ? te.encode(payload) : payload;
        whenReady(function () { sendPublish(topic, buf, options.qos || 0, !!options.retain); });
        return em;
      },
    };

    var listeners = {};
    function on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return em; }
    function once(ev, fn) {
      var w = function () { removeListener(ev, w); fn.apply(null, arguments); };
      return on(ev, w);
    }
    function removeListener(ev, fn) {
      listeners[ev] = (listeners[ev] || []).filter(function (f) { return f !== fn; });
      return em;
    }
    function emit(ev) {
      var args = Array.prototype.slice.call(arguments, 1);
      (listeners[ev] || []).forEach(function (f) { f.apply(null, args); });
    }

    var ws = null, ended = false, nextPid = 1, pingTimer = null, gen = 0;
    var subs = [], pendingOps = [], pendingSubs = {};

    function whenReady(fn) { if (em.connected) fn(); else pendingOps.push(fn); }
    function wsReady() { return ws && ws.readyState === 1; }

    function connectWS() {
      var myGen = ++gen;
      ws = new WebSocket(url, ["mqtt"]);
      ws.binaryType = "arraybuffer";
      ws.onopen = function () {
        var will = em.options.will;
        var flags = 0x02;   // clean session
        var payloadParts = [utf8(opts.clientId || "b-" + Math.random().toString(36).slice(2))];
        if (will) {
          flags |= 0x04 | ((will.qos & 0x3) << 3) | (will.retain ? 0x20 : 0);
          payloadParts.push(utf8(will.topic), utf8(will.payload || ""));   // will message keeps its length prefix even when empty
        }
        var vh = payloadParts.length > 1
          ? concat(utf8("MQTT"), Uint8Array.from([4, flags, 0, 30]), payloadParts[0], payloadParts[1], payloadParts[2])
          : concat(utf8("MQTT"), Uint8Array.from([4, flags, 0, 30]), payloadParts[0]);
        ws.send(packet(0x10, vh));
        pingTimer = setInterval(function () { try { ws.send(packet(0xC0, new Uint8Array(0))); } catch (e) {} }, 15000);
      };
      ws.onmessage = function (ev) {
        var data = new Uint8Array(ev.data);
        while (data.length >= 2) {
          var first = data[0], idx = 1, len = 0, mult = 1;
          do {
            if (idx >= data.length) return;
            len += (data[idx] & 0x7f) * mult; mult *= 128; idx++;
          } while (data[idx - 1] & 0x80);
          if (data.length < idx + len) return;
          var body = data.slice(idx, idx + len);
          data = data.slice(idx + len);
          handleFrame(first, body);
        }
      };
      ws.onclose = function (e) {
        if (myGen !== gen) return;                 // stale socket, ignore
        clearInterval(pingTimer);
        em.connected = false;
        emit("close");
        if (!ended) setTimeout(connectWS, 2000);   // auto-reconnect
      };
      ws.onerror = function (e) { emit("error", e); };
    }

    function handleFrame(first, body) {
      var type = first & 0xf0;
      if (type === 0x20) {                       // CONNACK
        em.connected = true;
        var ops = pendingOps.splice(0);
        emit("connect", {});
        ops.forEach(function (fn) { fn(); });
        subs.forEach(function (s) { sendSubscribe(s.topic, s.qos); });
      } else if (type === 0x30) {                // PUBLISH
        var tl = ((body[0] << 8) | body[1]);
        var topic = td.decode(body.slice(2, 2 + tl));
        var idx = 2 + tl;
        var qos = (first >> 1) & 0x3;
        if (qos > 0) idx += 2;
        var payload = body.slice(idx);
        emit("message", topic, payload);
        if (qos === 1) {
          var pidHi = body[2 + tl], pidLo = body[3 + tl];
          ws.send(packet(0x40, Uint8Array.from([pidHi, pidLo])));
        }
      } else if (type === 0x90) {                // SUBACK
        var pid = ((body[0] << 8) | body[1]);
        if (pendingSubs[pid]) { var s = pendingSubs[pid]; delete pendingSubs[pid]; if (s.cb) s.cb(); }
      }
      // PINGRESP 0xD0 and others: ignore
    }

    function sendSubscribe(topic, qos, cb) {
      if (!wsReady()) { whenReady(function () { sendSubscribe(topic, qos, cb); }); return; }
      var pid = nextPid++;
      if (cb) pendingSubs[pid] = { cb: cb };
      ws.send(packet(0x82, concat(
        Uint8Array.from([pid >> 8, pid & 0xff]),
        utf8(topic),
        Uint8Array.from([qos || 0])
      )));
    }
    function sendUnsubscribe(topic) {
      if (!wsReady()) { whenReady(function () { sendUnsubscribe(topic); }); return; }
      var pid = nextPid++;
      ws.send(packet(0xA2, concat(Uint8Array.from([pid >> 8, pid & 0xff]), utf8(topic))));
    }
    function sendPublish(topic, payload, qos, retain) {
      if (!wsReady()) { whenReady(function () { sendPublish(topic, payload, qos, retain); }); return; }
      var flags = (retain ? 0x01 : 0) | (qos << 1);
      var pid = nextPid++;
      var body = qos > 0
        ? concat(utf8(topic), Uint8Array.from([pid >> 8, pid & 0xff]), payload)
        : concat(utf8(topic), payload);
      ws.send(packet(0x30 | flags, body));
    }

    connectWS();
    return em;
  }

  window.mqtt = { connect: MQTTBrowser };
})();
