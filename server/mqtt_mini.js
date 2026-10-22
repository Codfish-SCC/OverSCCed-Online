/* Minimal MQTT 3.1.1 client over WebSocket — for the Node test harness only.
 * Implements just enough of the mqtt.js interface for MQTTNet:
 * connect(url,opts) -> {on, subscribe, publish, end, reconnect, options, connected} */
"use strict";

function MQTTMini(url, opts) {
  opts = opts || {};
  const listeners = {};
  const em = {
    options: { will: null },
    connected: false,
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return em; },
    once(ev, fn) {
      const w = function (...a) { em.removeListener(ev, w); fn(...a); };
      return em.on(ev, w);
    },
    removeListener(ev, fn) {
      listeners[ev] = (listeners[ev] || []).filter(f => f !== fn);
      return em;
    },
    emit(ev, ...args) { for (const f of listeners[ev] || []) f(...args); },
    end() { ended = true; try { ws && ws.close(); } catch (e) {} },
    reconnect() { em.connected = false; em.emit("close"); connectWS(); },
    subscribe(topic, qos, cb) {
      subs.push({ topic, qos: (qos && qos.qos) || 0 });
      whenReady(() => sendSubscribe(topic, (qos && qos.qos) || 0, cb));
      return em;
    },
    unsubscribe(topic) { whenReady(() => sendUnsubscribe(topic)); return em; },
    publish(topic, payload, options) {
      options = options || {};
      const buf = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
      whenReady(() => sendPublish(topic, buf, options.qos || 0, !!options.retain));
      return em;
    },
  };

  let ws = null;
  let ended = false;
  let nextPid = 1;
  let pingTimer = null;
  const subs = [];
  const pendingOps = [];
  const pendingSubs = {};   // pid -> {topic, cb}
  function whenReady(fn) {
    if (em.connected) fn();
    else pendingOps.push(fn);
  }

  function frameHeader(first, len) {
    const out = [first];
    let l = len;
    do {
      let b = l % 128; l = Math.floor(l / 128);
      if (l > 0) b |= 0x80;
      out.push(b);
    } while (l > 0);
    return Buffer.from(out);
  }
  function utf8(s) {
    const b = Buffer.from(s, "utf8");
    return Buffer.concat([Buffer.from([b.length >> 8, b.length & 0xff]), b]);
  }
  function packet(first, body) {
    return Buffer.concat([frameHeader(first, body.length), body]);
  }

  function connectWS() {
    ws = new WebSocket(url, ["mqtt"]);   // EMQX requires the mqtt subprotocol
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      if (process.env.DEBUG_MQTT) console.log("[ws-open2]", opts.clientId);
      const vh = Buffer.concat([
        utf8("MQTT"), Buffer.from([4, 0x02, 0, 30]),   // level 4, clean session, keepalive 30
        utf8(opts.clientId || "mini-" + Math.random().toString(36).slice(2)),
      ]);
      ws.send(packet(0x10, vh));
      pingTimer = setInterval(() => { try { ws.send(packet(0xC0, Buffer.alloc(0))); } catch (e) {} }, 15000);
    };
    ws.onmessage = (ev) => {
      let data = Buffer.from(ev.data);
      while (data.length >= 2) {
        const first = data[0];
        let idx = 1, len = 0, mult = 1;
        do {
          if (idx >= data.length) return;
          len += (data[idx] & 0x7f) * mult; mult *= 128; idx++;
        } while (data[idx - 1] & 0x80);
        if (data.length < idx + len) return;
        const body = data.slice(idx, idx + len);
        data = data.slice(idx + len);
        handleFrame(first, body);
      }
    };
    ws.onclose = (e) => {
      clearInterval(pingTimer);
      em.connected = false;
      if (process.env.DEBUG_MQTT) console.log("[ws-close]", e && e.code);
      em.emit("close");
      if (!ended) setTimeout(connectWS, 2000);   // auto-reconnect like mqtt.js
    };
    ws.onerror = (e) => { if (process.env.DEBUG_MQTT) console.log("[ws-error]", e && e.message || "err"); em.emit("error", e); };
  }

  function handleFrame(first, body) {
    const type = first & 0xf0;
    if (type === 0x20) {            // CONNACK
      em.connected = true;
      const ops = pendingOps.splice(0);
      em.emit("connect", {});
      for (const fn of ops) fn();
      for (const s of subs) sendSubscribe(s.topic, s.qos);
      // apply will by reconnecting once
      if (em.options.will) {
        const w = em.options.will;
        em.options.will = null;
        sendWillSet(w);
      }
    } else if (type === 0x30) {     // PUBLISH
      let idx = 0;
      const tl = body.readUInt16BE(idx); idx += 2;
      const topic = body.slice(idx, idx + tl).toString("utf8"); idx += tl;
      const qos = (first >> 1) & 0x3;
      if (qos > 0) idx += 2;        // packet id
      const payload = body.slice(idx);
      em.emit("message", topic, payload);
      if (qos === 1) {
        const pid = body.readUInt16BE(2 + tl);
        ws.send(packet(0x40, Buffer.from([pid >> 8, pid & 0xff])));
      }
    } else if (type === 0x90) {     // SUBACK
      const pid = body.readUInt16BE(0);
      if (pendingSubs[pid]) { const s = pendingSubs[pid]; delete pendingSubs[pid]; if (s.cb) s.cb(); }
    } else if (type === 0xD0) {     // PINGRESP
      /* ignore */
    }
  }

  function sendWillSet(will) {
    // publish retained will placeholder? (broker handles will at CONNECT; here we
    // simply reconnect so the server-side will option takes effect is NOT possible
    // in this mini client — instead the harness sets will via MQTTNet.reconnect)
    em.emit("connect", {});
  }
  function wsReady() { return ws && (ws.readyState === 1 || ws.readyState === 0); }
  function sendSubscribe(topic, qos, cb) {
    if (!wsReady()) { whenReady(() => sendSubscribe(topic, qos, cb)); return; }
    const pid = nextPid++;
    if (cb) pendingSubs[pid] = { topic, cb };
    ws.send(packet(0x82, Buffer.concat([
      Buffer.from([pid >> 8, pid & 0xff]),
      utf8(topic), Buffer.from([qos || 0]),
    ])));
  }
  function sendUnsubscribe(topic) {
    const pid = nextPid++;
    ws.send(packet(0xA2, Buffer.concat([Buffer.from([pid >> 8, pid & 0xff]), utf8(topic)])));
  }
  function sendPublish(topic, payload, qos, retain) {
    if (process.env.DEBUG_MQTT) console.log("[pub]", topic.slice(0, 50), "wsState:", ws && ws.readyState);
    if (!wsReady()) { whenReady(() => sendPublish(topic, payload, qos, retain)); return; }
    const flags = (retain ? 0x01 : 0) | (qos << 1);
    const pid = nextPid++;
    const body = qos > 0
      ? Buffer.concat([utf8(topic), Buffer.from([pid >> 8, pid & 0xff]), payload])   // MQTT: packet id AFTER the topic name
      : Buffer.concat([utf8(topic), payload]);
    ws.send(packet(0x30 | flags, body));
  }

  connectWS();
  return em;
}

module.exports = { connect: MQTTMini };
