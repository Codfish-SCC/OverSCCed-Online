/* OverSCCed MQTT host-mode transport.
 * The room creator's browser runs the authoritative rules engine (Game).
 * A public MQTT broker (default wss://broker.emqx.io:8084/mqtt) relays messages.
 * Works in browsers (global MQTTNet) and in Node for testing (module.exports).
 *
 * Topic layout (v1):
 *   overscced/v1/{code}/meta            retained room info {token, hostName, players}
 *   overscced/v1/{code}-{token}/room    lobby view broadcast
 *   overscced/v1/{code}-{token}/state   public game state broadcast
 *   overscced/v1/{code}-{token}/priv/{name}   private prompt for one player
 *   overscced/v1/{code}-{token}/welcome/{name}  seat/color info for one player
 *   overscced/v1/{code}-{token}/join    {name, spectator}
 *   overscced/v1/{code}-{token}/act/{name}      action message from a player
 *   overscced/v1/{code}-{token}/gone/{name}     last-will on disconnect
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MQTTNet = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MAX_PLAYERS = 6, MAX_SPECTATORS = 4, RECONNECT_GRACE_MS = 90 * 1000;

  function MQTTNet(opts) {
    if (typeof bootLog === "function") bootLog("mqtt_host.js loaded");
    this.opts = opts || {};
    this.onMessage = opts.onMessage || function () {};
    this.brokerUrl = opts.brokerUrl || "wss://broker-cn.emqx.io:8084/mqtt";
    this.BROKERS = [
      "wss://broker-cn.emqx.io:8084/mqtt",   // EMQX China (TLS)
      "wss://broker.emqx.io:8084/mqtt",     // EMQX global (TLS)
      "ws://broker-cn.emqx.io:8083/mqtt",   // EMQX China (no TLS)
      "ws://broker.emqx.io:8083/mqtt",      // EMQX global (no TLS)
      "wss://test.mosquitto.org:8081/mqtt", // mosquitto (TLS)
    ];
    this.brokerIdx = 0;
    this.Game = opts.Game;
    this.BOARD_TILES = opts.BOARD_TILES;
    this.CARDS = opts.CARDS;
    this.client = null;
    this.connected = false;
    this.me = null;          // {name, seat, spectator, host, color}
    this.room = null;        // local room state (host only)
    this.code = null;
    this.token = null;
    this.myName = null;
    this.session = null;     // {code, token, name, spectator, host} for rejoin
    this.seq = 0;
    this._lastStateSeq = null;
    this._lastRoomSeq = null;
    this._connect();
  }

  /* ---------- MQTT plumbing ---------- */
  MQTTNet.prototype._connect = function () {
    const self = this;
    let mqtt = typeof root !== "undefined" && root.mqtt ? root.mqtt
      : (typeof window !== "undefined" && window.mqtt ? window.mqtt : null);
    if (!mqtt && typeof require === "function") mqtt = this.opts.mqtt;
    if (!mqtt) throw new Error("mqtt client library not found");
    this.brokerUrl = this.BROKERS[this.brokerIdx];
    if (typeof bootLog === "function") bootLog("trying relay " + (this.brokerIdx + 1) + "/" + this.BROKERS.length + "…");
    this.client = mqtt.connect(this.brokerUrl, {
      clientId: "overscced-" + Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36),
      clean: true,
      connectTimeout: 15000,
      reconnectPeriod: 2000,
    });
    this.client.on("connect", function () {
      if (typeof bootLog === "function") bootLog("connected ✓");
      self.connected = true;
      self.opts.onConn && self.opts.onConn();
      self._afterConnect();
    });
    this.client.on("reconnect", function () { self.opts.onConn && self.opts.onConn(); });
    this.client.on("close", function () {
      self.connected = false;
      self.opts.onDrop && self.opts.onDrop();
      self._nextBroker();
    });
    this.client.on("offline", function () { self.connected = false; self.opts.onDrop && self.opts.onDrop(); });
    this.client.on("error", function (e) {
      self.opts.onDrop && self.opts.onDrop(e);
      self._nextBroker();
    });
    this.client.on("message", function (topic, payload) {
      if (process.env.DEBUG_MQTT && typeof process !== "undefined") console.log("[raw]", self.myName || "?", topic.slice(0, 60));
      self._onTopic(topic, payload);
    });
  };

  MQTTNet.prototype._afterConnect = function () {
    // re-attach to a previous room after reconnect
    if (this.session) {
      const s = this.session;
      this.code = s.code; this.token = s.token;
      if (!this._attached) this._attached = true;
      if (s.host) {
        this._subscribeRoom();
        this._publishMeta();
      } else {
        this._subscribeRoom();
        if (!s._joinedOnce) { s._joinedOnce = true; this._publish("join", { name: s.name, spectator: !!s.spectator }); }
      }
    }
  };

  MQTTNet.prototype._nextBroker = function () {
    const self = this;
    if (this._brokerTimer) return;
    this._brokerTimer = setTimeout(function () {
      self._brokerTimer = null;
      if (self.connected) return;
      self.brokerIdx = (self.brokerIdx + 1) % self.BROKERS.length;
      self.brokerUrl = self.BROKERS[self.brokerIdx];
      if (typeof bootLog === "function") bootLog("trying relay " + (self.brokerIdx + 1) + "/" + self.BROKERS.length + "…");
      try { self.client.end(true); } catch (e) {}
      self._connect();
    }, 1500);
  };
  MQTTNet.prototype._base = function () { return "overscced/v1/" + this.code + "-" + this.token; };
  MQTTNet.prototype._metaTopic = function (code) { return "overscced/v1/" + code + "/meta"; };
  MQTTNet.prototype._subscribeRoom = function (cb) {
    this.client.subscribe(this._base() + "/#", { qos: 0 }, cb);
  };
  MQTTNet.prototype._publish = function (sub, obj, retained) {
    this.client.publish(this._base() + "/" + sub, JSON.stringify(obj), { qos: 1, retain: !!retained });
  };
  MQTTNet.prototype._publishMeta = function () {
    this.client.publish(this._metaTopic(this.code), JSON.stringify({
      token: this.token,
      host: this.room ? this.room.host : (this.me && this.me.name),
      players: this.room ? this.room.players.length : 0,
      started: !!(this.room && this.room.game),
      ts: Date.now(),
    }), { qos: 1, retain: true });
  };

  /* ---------- host: create room ---------- */
  MQTTNet.prototype.create = function (name) {
    const self = this;
    name = this._clean(name);
    const tryCode = function (attempt) {
      const code = String(Math.floor(Math.random() * 9000) + 1000);
      const metaTopic = self._metaTopic(code);
      let settled = false;
      const to = setTimeout(function () {
        // no retained meta arrived -> code is free, claim it
        settled = true;
        self.client.unsubscribe(metaTopic);
        self._startHost(code, name);
      }, 900);
      const handler = function (t) {
        if (t !== metaTopic || settled) return;
        settled = true;
        clearTimeout(to);
        self.client.unsubscribe(metaTopic);
        self.client.removeListener("message", handler);
        if (attempt < 30) tryCode(attempt + 1);
        else self._emit("err", "server busy, try again");
      };
      self.client.on("message", handler);
      self.client.subscribe(metaTopic);
    };
    // wait one tick so a retained "taken" meta would have arrived before claim
    setTimeout(function () { tryCode(0); }, 250);
  };

  MQTTNet.prototype._startHost = function (code, name) {
    const self = this;
    this.code = code;
    this.token = Math.random().toString(36).slice(2, 10);
    this.session = { code, token: this.token, name, spectator: false, host: true };
    this._attached = true;
    this.me = { name, seat: 0, spectator: false, host: true, color: this._color(0) };
    this.room = {
      code, token: this.token, host: name,
      players: [{ name, seat: 0, color: this._color(0), online: true }],
      spectators: [], game: null,
    };
    this._subscribeRoom();
    this._publishMeta();
    // last will: if the host dies, clear the room meta (reconnect to apply)
    this.client.options.will = {
      topic: this._metaTopic(code), payload: "", qos: 1, retain: true,
    };
    this.client.reconnect();
    this._emit("welcome", { you: { name, seat: 0, spectator: false, host: true, color: this._color(0) } });
    this._broadcastRoom();
  };

  /* ---------- client: join / spectate ---------- */
  MQTTNet.prototype.join = function (code, name, spectator) {
    const self = this;
    name = this._clean(name);
    const metaTopic = this._metaTopic(code);
    let attempts = 0;
    let timer = null;
    const handler = function (t, payload) {
      if (t !== metaTopic) return;
      let text = "";
      try {
        text = typeof TextDecoder !== "undefined" ? new TextDecoder().decode(payload) : payload.toString();
      } catch (e) { return; }
      if (!text) return;
      let meta = null;
      try { meta = JSON.parse(text); } catch (e) { return; }
      if (!meta || !meta.token) return;
      if (!meta.ts || Date.now() - meta.ts > 90000) return;   // stale room
      clearInterval(timer);
      self.client.unsubscribe(metaTopic);
      self.client.removeListener("message", handler);
      self.code = code;
      self.token = meta.token;
      self.myName = name;
      self.session = { code, token: meta.token, name, spectator: !!spectator, host: false };
      self._attached = true;
      // publish join only after the room subscription is active (no lost replies)
      self._subscribeRoom(function () {
        self._publish("join", { name, spectator: !!spectator });
      });
    };
    this.client.on("message", handler);
    timer = setInterval(function () {
      self.client.subscribe(metaTopic);   // re-request the retained meta
      if (++attempts >= 8) {
        clearInterval(timer);
        self.client.unsubscribe(metaTopic);
        self.client.removeListener("message", handler);
        self._emit("err", "room not found");
      }
    }, 1500);
  };

  MQTTNet.prototype.leave = function () {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    if (this.me) this._publish("leave/" + this.me.name, { name: this.me.name });
    if (this.room) this._clearMeta();
    this.session = null; this.me = null; this.room = null;
    this._attached = false;
    if (this.client) { try { this.client.end(); } catch (e) {} }
  };

  MQTTNet.prototype._clearMeta = function () {
    this.client.publish(this._metaTopic(this.code), "", { qos: 0, retain: true });
  };

  /* ---------- host: game control ---------- */
  MQTTNet.prototype.start = function () {
    const room = this.room;
    if (!room) return this._emit("err", "not in a room");
    if (this.me.name !== room.host) return this._emit("err", "only the host can start");
    if (room.game) return this._emit("err", "already started");
    if (room.players.length < 4) return this._emit("err", "need 4–6 players to start");
    if (room.players.some(function (p) { return !p.online; })) return this._emit("err", "wait for all players to be online");
    const names = room.players.slice().sort(function (a, b) { return a.seat - b.seat; }).map(function (p) { return p.name; });
    const self = this;
    const g = new this.Game(this.BOARD_TILES);
    room.game = g;
    g.setup(names);
    g.onLog = function () { self._sync(); };
    g.onEvent = function () {};
    g.onPhase = function () { self._sync(); };
    this._sync();
  };

  /* ---------- shared protocol (ported from server.js) ---------- */
  MQTTNet.prototype._deliverState = function (st) {
    if (this._lastStateSeq != null && st.seq <= this._lastStateSeq) return;
    this._lastStateSeq = st.seq;
    this._emit("state", { state: st });
  };
  MQTTNet.prototype._deliverRoom = function (rv) {
    if (this._lastRoomSeq != null && rv.seq <= this._lastRoomSeq) return;
    this._lastRoomSeq = rv.seq;
    this._emit("room", { room: rv });
  };
  MQTTNet.prototype._deliverPrivate = function (p) {
    if (p._seq != null && this._lastStateSeq != null && p._seq < this._lastStateSeq) return;
    if (p._pid != null) {
      if (this._lastPrivPid === p._pid) return;   // same prompt already delivered
      this._lastPrivPid = p._pid;
    }
    this._emit("private", { pending: p });
  };
  MQTTNet.prototype._sync = function () {
    const room = this.room;
    if (!room || !room.game) return;
    const seq = ++this.seq;
    const pend = room.game.pending;
    if (pend && !pend._pid) pend._pid = seq;
    const state = this._buildState(room);
    state.seq = seq;
    this._publish("state", state);
    this._deliverState(state);   // host UI
    for (const m of [...room.players, ...room.spectators]) {
      const priv = this._privateView(room, m);
      if (priv) { priv._seq = seq; this._publish("priv/" + m.name, priv); }
    }
    const hostPriv = this._privateView(room, this.me);
    if (hostPriv) this._deliverPrivate(hostPriv);   // host UI
  };

  MQTTNet.prototype._buildState = function (room) {
    const g = room.game;
    const cur = g.phase === "over" ? null : g.current();
    const standings = g.phase === "over"
      ? [...g.players].sort((a, b) => b.coins - a.coins || a.finishOrder - b.finishOrder)
          .map(p => ({ name: p.name, coins: p.coins, finishOrder: p.finishOrder, charId: p.charId }))
      : null;
    return {
      phase: g.phase,
      turn: cur ? cur.name : null,
      turnCount: g.turnCount,
      deckCount: g.deck.length,
      winner: g.winner ? g.winner.name : null,
      players: g.players.map(p => ({
        name: p.name, charId: p.charId, coins: p.coins, pos: p.pos,
        finished: p.finished, finishOrder: p.finishOrder,
        heldMercy: p.heldMercy, skipNextTurn: p.skipNextTurn,
        ultimateUsed: p.ultimateUsed,
      })),
      rolloff: g.phase === "rolloff" ? g.rolloff.map(r => ({ name: r.name, rolls: r.rolls, done: r.done })) : null,
      lastRoll: g.phase === "move-prompt" ? g.lastRoll : null,
      skillOptions: g.phase === "skill" && cur
        ? g.skillOptions().map(o => ({ id: o.id, label: o.label, targets: g.skillTargets(o.id).map(t => t.name) }))
        : null,
      log: g.logLines.slice(0, 60),
      standings,
      rolloffTieNames: g.pending && g.pending.kind === "rolloff-reroll" ? g.pending.names : null,
    };
  };

  MQTTNet.prototype._privateView = function (room, member) {
    const g = room.game;
    const p = g.pending;
    if (!p) return null;
    if (p.kind === "hostile-choice") {
      if (member.name !== p.target) return null;
      return { kind: "hostile-choice", target: p.target, options: p.options };
    }
    const cur = g.phase === "over" ? null : g.current();
    if (!cur || member.name !== cur.name) return null;
    const out = { kind: p.kind, _pid: p._pid };
    if (p.kind === "yuan-peek") {
      const card = this.CARDS.find(c => c.id === p.card);
      out.card = card ? { name: card.name, deck: card.deck, effect: card.effect } : null;
    } else if (p.kind === "card") {
      out.card = { name: p.card.name, deck: p.card.deck, effect: p.card.effect, needsTarget: !!p.card.needsTarget };
      if (p.card.needsTarget) out.targets = g.boardPlayers().filter(o => o !== cur).map(o => o.name);
    } else if (p.options) {
      out.options = p.options;
    }
    if (p.kind === "park-win") { out.dice = p.dice; out.total = p.total; }
    if (p.kind === "wu-toll") { out.target = p.target; }
    return out;
  };

  MQTTNet.prototype._handleAction = function (member, msg) {
    const room = this.room;
    const g = room && room.game;
    if (!g) return this._emit("err", "game not started");
    if (g.phase === "over") return this._emit("err", "game over");
    const cur = g.phase === "over" ? null : g.current();
    const needCurrent = () => {
      if (!cur) { this._emit("err", "no current player"); return false; }
      if (member.name !== cur.name) { this._emit("err", "not your turn"); return false; }
      return true;
    };
    switch (msg.a) {
      case "roll":
        if (!needCurrent()) return;
        if (g.phase !== "roll") return this._emit("err", "cannot roll now");
        if (typeof msg.guess === "number" && msg.guess >= 1 && msg.guess <= 6) g.setParkGuess(msg.guess);
        g.roll(); this._sync(); return;
      case "move":
        if (!needCurrent()) return;
        if (g.phase !== "move-prompt") return this._emit("err", "cannot move now");
        g.afterRollMove(g.lastRoll.total); this._sync(); return;
      case "reroll":
        if (!needCurrent()) return;
        if (g.phase !== "move-prompt") return this._emit("err", "cannot re-roll now");
        g.reroll(); this._sync(); return;
      case "rolloffAgain":
        if (g.phase !== "rolloff") return this._emit("err", "not in roll-off");
        g.rerollTie(); this._sync(); return;
      case "choice": {
        const p = g.pending;
        if (!p) return this._emit("err", "nothing to choose");
        if (p.kind === "hostile-choice") {
          if (member.name !== p.target) return this._emit("err", "this choice belongs to " + p.target);
          g.hostileChoice(String(msg.id)); this._sync(); return;
        }
        if (!needCurrent()) return;
        if (p.kind === "trap") g.trapChoice(String(msg.id));
        else if (p.kind === "park-flip") g.parkFlipChoice(String(msg.id));
        else if (p.kind === "park-win") g.parkWinChoice(String(msg.id));
        else if (p.kind === "wu-toll") g.wuTollChoice(String(msg.id));
        else return this._emit("err", "unknown choice kind");
        this._sync(); return;
      }
      case "cardApply":
        if (!needCurrent()) return;
        g.resolveCard(null); this._sync(); return;
      case "cardTarget": {
        if (!needCurrent()) return;
        const target = g.players.find(p => p.name === msg.target);
        if (!target) return this._emit("err", "unknown target");
        g.resolveCard(target); this._sync(); return;
      }
      case "yuanChoice":
        if (!needCurrent()) return;
        g.yuanChoice(!!msg.keep); this._sync(); return;
      case "skill": {
        if (!needCurrent()) return;
        if (g.phase !== "skill") return this._emit("err", "not skill phase");
        const valid = g.skillOptions().some(o => o.id === String(msg.id));
        if (!valid) return this._emit("err", "skill not available");
        const targets = g.skillTargets(String(msg.id));
        let target = null;
        if (targets.length) {
          if (!msg.target || !targets.some(t => t.name === msg.target)) return this._emit("err", "bad target");
          target = g.players.find(p => p.name === msg.target);
        }
        g.useSkill(String(msg.id), target); this._sync(); return;
      }
      case "endTurn":
        if (!needCurrent()) return;
        if (g.phase !== "skill") return this._emit("err", "cannot end turn now");
        g.endTurn(); this._sync(); return;
      default:
        return this._emit("err", "unknown action " + msg.a);
    }
  };

  /* ---------- topic router ---------- */
  MQTTNet.prototype._onTopic = function (topic, payload) {
    if (process.env.DEBUG_MQTT && typeof process !== "undefined") console.log("[topic]", (this.room ? "HOST" : "CLI:" + this.myName), topic.slice(0, 60));
    let text = "";
    try {
      text = typeof TextDecoder !== "undefined"
        ? new TextDecoder().decode(payload)
        : payload.toString();
    } catch (e) { return; }
    const base = this._base();
    if (topic === base + "/state") return this._emit("state", { state: JSON.parse(text) });
    if (topic.indexOf(base + "/priv/") === 0) return this._emit("private", { pending: JSON.parse(text) });
    if (topic === base + "/room") {
      try { return this._emit("room", JSON.parse(text)); }
      catch (e) { console.log("[BAD-ROOM]", topic, "hex:", Buffer.from(text).toString("hex").slice(0, 80)); throw e; }
    }
    if (topic.indexOf(base + "/welcome/") === 0) {
      const target = topic.slice((base + "/welcome/").length);
      if (target !== this.myName) return;
      return this._emit("welcome", { you: JSON.parse(text) });
    }
    if (topic === base + "/err/" + this.myName) return this._emit("err", JSON.parse(text).msg);
    // host-only topics
    if (!this.room) return;
    const room = this.room;
    if (topic === base + "/join") {
      let m; try { m = JSON.parse(text); } catch (e) { return; }
      return this._onJoin(m);
    }
    if (topic.indexOf(base + "/act/") === 0) {
      const name = topic.slice((base + "/act/").length);
      const member = room.players.find(p => p.name === name);
      if (process.env.DEBUG_MQTT && typeof process !== "undefined") console.log("[act]", name, text.slice(0, 60));
      if (!member) return this._emit("err", "not in room");
      if (!member.online) { member.online = true; this._broadcastRoom(); }
      let msg; try { msg = JSON.parse(text); } catch (e) { return; }
      try { return this._handleAction(member, msg); }
      catch (e) { console.error("[host-action-error]", e && e.stack || e); }
    }
    if (topic.indexOf(base + "/gone/") === 0) {
      const name = topic.slice((base + "/gone/").length);
      const member = room.players.find(p => p.name === name);
      if (member) { member.online = false; this._broadcastRoom(); this._sync(); }
      return;
    }
    if (topic.indexOf(base + "/leave/") === 0) {
      const name = topic.slice((base + "/leave/").length);
      room.players = room.players.filter(p => p.name !== name);
      room.spectators = room.spectators.filter(s => s.name !== name);
      this._broadcastRoom();
      if (!room.players.length && !room.spectators.length) this._clearMeta();
      return;
    }
  };

  MQTTNet.prototype._onJoin = function (m) {
    const room = this.room;
    if (!room) return;
    if (room.game && !room.players.some(p => p.name === m.name) && !room.spectators.some(s => s.name === m.name)) {
      this._publish("err/" + m.name, { msg: "game already started" });
      return;
    }
    const existing = room.players.find(p => p.name === m.name);
    if (existing) {
      existing.online = true;
      this._publish("welcome/" + m.name, { name: m.name, seat: existing.seat, spectator: false, host: room.host === m.name, color: existing.color });
      this._broadcastRoom();
      if (room.game) this._sync();
      return;
    }
    const specExisting = room.spectators.find(s => s.name === m.name);
    if (specExisting) {
      specExisting.online = true;
      this._publish("welcome/" + m.name, { name: m.name, seat: -1, spectator: true, host: false, color: "#888" });
      this._broadcastRoom();
      if (room.game) this._sync();
      return;
    }
    if (room.players.some(p => p.name === m.name) || room.spectators.some(s => s.name === m.name)) return;
    if (m.spectator) {
      if (room.spectators.length >= MAX_SPECTATORS) { this._publish("err/" + m.name, { msg: "spectator seats full" }); return; }
      room.spectators.push({ name: m.name, online: true });
      this._publish("welcome/" + m.name, { name: m.name, seat: -1, spectator: true, host: false, color: "#888" });
    } else {
      if (room.game) { this._publish("err/" + m.name, { msg: "game already started" }); return; }
      if (room.players.length >= MAX_PLAYERS) { this._publish("err/" + m.name, { msg: "player seats full" }); return; }
      const seat = room.players.length;
      room.players.push({ name: m.name, seat, color: this._color(seat), online: true });
      this._publish("welcome/" + m.name, { name: m.name, seat, spectator: false, host: false, color: this._color(seat) });
    }
    this._broadcastRoom();
    this._publishMeta();
  };

  MQTTNet.prototype._broadcastRoom = function () {
    const room = this.room;
    if (!room) return;
    const seq = ++this.seq;
    const view = {
      seq, code: room.code,
      host: room.host,
      players: room.players.map(p => ({ name: p.name, seat: p.seat, color: p.color, online: !!p.online })),
      spectators: room.spectators.map(s => ({ name: s.name, online: !!s.online })),
      started: !!room.game,
    };
    this._publish("room", { room: view });
    this._deliverRoom(view);   // host UI
  };

  /* ---------- helpers ---------- */
  MQTTNet.prototype.act = function (obj) {
    if (this.session && !this.session.host) this._publish("act/" + this.myName, obj);
    else if (this.room && this.me) {
      const member = this.room.players.find(p => p.name === this.me.name);
      if (member) this._handleAction(member, obj);
    }
  };
  MQTTNet.prototype._emit = function (type, payload) {
    const obj = { t: type };
    if (type === "err") obj.msg = payload;
    else Object.assign(obj, payload);
    this.onMessage(obj);
  };
  MQTTNet.prototype._clean = function (s) {
    const n = String(s || "").trim().replace(/\s+/g, " ").slice(0, 20);
    return n || "Player" + Math.floor(Math.random() * 1000);
  };
  MQTTNet.prototype._color = function (seat) {
    return ["#e53935", "#1e88e5", "#43a047", "#8e24aa", "#fb8c00", "#d81b60"][seat % 6];
  };

  return MQTTNet;
});
