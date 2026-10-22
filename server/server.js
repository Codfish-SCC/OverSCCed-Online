/* OverSCCed room server — zero dependencies (Node only).
 * Serves the static game files AND hosts multiplayer rooms over WebSocket.
 * Run:  node server.js [port]      (default 3000)
 * The server is authoritative: it runs the full rules engine and only
 * accepts legal actions from the player whose turn it is.
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const Game = require("../rules.js").Game;
const CARDS = require("../rules.js").CARDS;

const PORT = parseInt(process.argv[2] || process.env.PORT || "3000", 10);
const ROOT = path.join(__dirname, "..");
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/* ---------------- static file server ---------------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  // block path traversal
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const file = path.join(ROOT, safe);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end("forbidden"); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found: " + urlPath); return; }
    const ext = path.extname(file).toLowerCase();
    const cache = ext === ".html"
      ? "no-cache"
      : "public, max-age=86400, immutable";
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": cache,
    });
    res.end(data);
  });
}

/* ---------------- minimal WebSocket (RFC 6455, server side) ---------------- */
function wsAcceptKey(key) {
  return crypto.createHash("sha1").update(key + GUID).digest("base64");
}

class WS {
  constructor(socket) {
    this.socket = socket;
    this.onmessage = null;
    this.onclose = null;
    this.buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => this._feed(chunk));
    socket.on("error", () => this._close());
    socket.on("end", () => this._close());
  }
  _close() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.destroy(); } catch (e) {}
    if (this.onclose) this.onclose();
  }
  _feed(chunk) {
    if (process.env.DEBUG_WS) console.log("[ws-bytes]", chunk.length, "hex:", chunk.slice(0, 20).toString("hex"));
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0], b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > 0xffffffffn) { this._close(); return; }
        len = Number(big); off = 10;
      }
      let maskKey = null;
      if (masked) {
        if (this.buffer.length < off + 4) return;
        maskKey = this.buffer.slice(off, off + 4); off += 4;
      }
      if (this.buffer.length < off + len) return;
      let payload = this.buffer.slice(off, off + len);
      this.buffer = this.buffer.slice(off + len);
      if (masked) {
        const un = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) un[i] = payload[i] ^ maskKey[i % 4];
        payload = un;
      }
      if (opcode === 0x8) { this._close(); return; }        // close
      if (opcode === 0x9) { this._sendRaw(0xA, payload); continue; } // ping -> pong
      if (opcode === 0x1 && fin && this.onmessage) {         // text
        try { this.onmessage(payload.toString("utf8")); }
        catch (e) { console.error("[ws-handler-error]", e && e.stack || e); }
      }
      // fragmented/continuation frames: accumulate simple case
    }
  }
  send(obj) {
    const payload = Buffer.from(JSON.stringify(obj), "utf8");
    if (process.env.DEBUG_WS) console.log("[send]", this._tag, obj.t, payload.length, "B");
    this._sendRaw(0x1, payload);
  }
  _sendRaw(opcode, payload) {
    try {
      const head = [0x80 | opcode];
      if (payload.length < 126) {
        head.push(payload.length);
        this.socket.write(Buffer.concat([Buffer.from(head), payload]));
      } else if (payload.length < 65536) {
        head.push(126, (payload.length >> 8) & 0xff, payload.length & 0xff);
        this.socket.write(Buffer.concat([Buffer.from(head), payload]));
      } else {
        const buf = Buffer.alloc(10);
        buf[0] = 0x80 | opcode;
        buf[1] = 127;
        buf.writeBigUInt64BE(BigInt(payload.length), 2);
        this.socket.write(Buffer.concat([buf, payload]));
      }
    } catch (e) { this._close(); }
  }
}

/* ---------------- rooms & engine wiring ---------------- */
const rooms = new Map();   // code -> room
const ROOM_CODE_LEN = 4;
const MAX_PLAYERS = 6;
const MAX_SPECTATORS = 4;
const RECONNECT_GRACE_MS = 90 * 1000;
const ROOM_IDLE_MS = 30 * 60 * 1000;

function newCode() {
  for (let i = 0; i < 200; i++) {
    const code = String(Math.floor(Math.random() * 9000) + 1000); // 1000-9999
    if (!rooms.has(code)) return code;
  }
  return null;
}

function makeRoom(code, hostName, hostSocket) {
  const room = {
    code,
    host: hostName,
    players: [],          // {name, seat, color, online, ws, goneTimer}
    spectators: [],       // {name, online, ws}
    game: null,
    idleTimer: null,
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function playerColor(seat) {
  const COLORS = ["#e53935", "#1e88e5", "#43a047", "#8e24aa", "#fb8c00", "#d81b60"];
  return COLORS[seat % COLORS.length];
}

function findMember(room, name) {
  // only ONLINE members count as "taken"; offline ghosts can be rejoined
  return room.players.find(p => p.name === name && p.ws) ||
         room.spectators.find(s => s.name === name && s.ws) || null;
}

function roomView(room) {
  return {
    code: room.code,
    host: room.host,
    players: room.players.map(p => ({
      name: p.name, seat: p.seat, color: p.color, online: !!p.ws,
    })),
    spectators: room.spectators.map(s => ({ name: s.name, online: !!s.ws })),
    started: !!room.game,
  };
}

function broadcastRoom(room) {
  const view = roomView(room);
  for (const m of [...room.players, ...room.spectators]) {
    if (m.ws) m.ws.send({ t: "room", room: view });
  }
}

/* public game state snapshot */
function buildState(room) {
  const g = room.game;
  if (!g) return null;
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
      ? g.skillOptions().map(o => ({ id: o.id, label: o.label,
          targets: g.skillTargets(o.id).map(t => t.name) }))
      : null,
    log: g.logLines.slice(0, 60),
    standings,
    rolloffTieNames: g.pending && g.pending.kind === "rolloff-reroll" ? g.pending.names : null,
  };
}

function privateView(room, member) {
  const g = room.game;
  if (!g) return null;
  const p = g.pending;
  if (!p) return null;
  // hostile-choice is answered by the TARGET player, not the current one
  if (p.kind === "hostile-choice") {
    if (member.name !== p.target) return null;
    return { kind: "hostile-choice", target: p.target, options: p.options };
  }
  const cur = g.phase === "over" ? null : g.current();
  if (!cur || member.name !== cur.name) return null;
  const out = { kind: p.kind };
  if (p.kind === "yuan-peek") {
    const card = CARDS.find(c => c.id === p.card);
    out.card = card ? { name: card.name, deck: card.deck, effect: card.effect } : null;
  } else if (p.kind === "card") {
    out.card = { name: p.card.name, deck: p.card.deck, effect: p.card.effect,
                 needsTarget: !!p.card.needsTarget };
    if (p.card.needsTarget) {
      out.targets = g.boardPlayers().filter(o => o !== cur).map(o => o.name);
    }
  } else if (p.options) {
    out.options = p.options;
  }
  if (p.kind === "park-win") { out.dice = p.dice; out.total = p.total; }
  if (p.kind === "wu-toll") { out.target = p.target; }
  return out;
}

function sync(room) {
  if (!room.game) return;
  if (process.env.DEBUG_WS) console.log("[sync]", room.game.phase, "pending:", room.game.pending && room.game.pending.kind);
  const state = buildState(room);
  let n = 0;
  for (const m of [...room.players, ...room.spectators]) {
    if (!m.ws) continue;
    m.ws.send({ t: "state", state });
    n++;
    const priv = privateView(room, m);
    if (priv) m.ws.send({ t: "private", pending: priv });
  }
}

function err(ws, msg) { if (process.env.DEBUG_WS) console.log("[ws-err]", msg); ws.send({ t: "err", msg }); }

function broadcastLogEvents(room) { /* logs live in state; nothing extra needed */ }

function startGame(room) {
  const names = room.players.slice().sort((a, b) => a.seat - b.seat).map(p => p.name);
  const g = new Game(require("../config.js").BOARD_TILES);
  room.game = g;
  g.setup(names);
  g.onLog = () => sync(room);
  g.onEvent = () => {};
  g.onPhase = () => sync(room);
  sync(room);
}

function resetIdle(room) {
  if (room.idleTimer) clearTimeout(room.idleTimer);
  room.idleTimer = setTimeout(() => {
    if (room.game || room.players.some(p => p.ws)) { resetIdle(room); return; }
    rooms.delete(room.code);
  }, ROOM_IDLE_MS);
}

/* ---------------- action dispatch ---------------- */
function handleAction(room, member, msg, ws) {
  const g = room.game;
  if (!g) { err(ws, "game not started"); return; }
  if (g.phase === "over") { err(ws, "game over"); return; }
  const cur = g.phase === "over" ? null : g.current();

  const needCurrent = (kinds) => {
    if (!cur) { err(ws, "no current player"); return false; }
    if (member.name !== cur.name) { err(ws, "not your turn"); return false; }
    if (kinds && g.pending && !kinds.includes(g.pending.kind) && g.phase !== "skill") {
      err(ws, "unexpected action"); return false;
    }
    return true;
  };

  switch (msg.a) {
    case "roll": {
      if (!needCurrent()) return;
      if (g.phase !== "roll") { err(ws, "cannot roll now"); return; }
      if (typeof msg.guess === "number" && msg.guess >= 1 && msg.guess <= 6) g.setParkGuess(msg.guess);
      g.roll();
      sync(room);
      return;
    }
    case "move": {
      if (!needCurrent()) return;
      if (g.phase !== "move-prompt") { err(ws, "cannot move now"); return; }
      g.afterRollMove(g.lastRoll.total);
      sync(room);
      return;
    }
    case "reroll": {
      if (!needCurrent()) return;
      if (g.phase !== "move-prompt") { err(ws, "cannot re-roll now"); return; }
      g.reroll();
      sync(room);
      return;
    }
    case "rolloffAgain": {
      if (g.phase !== "rolloff") { err(ws, "not in roll-off"); return; }
      g.rerollTie();
      sync(room);
      return;
    }
    case "choice": {
      const p = g.pending;
      if (!p) { err(ws, "nothing to choose"); return; }
      if (p.kind === "hostile-choice") {
        if (member.name !== p.target) { err(ws, "this choice belongs to " + p.target); return; }
        g.hostileChoice(String(msg.id));
        sync(room);
        return;
      }
      if (!needCurrent()) return;
      if (p.kind === "trap") g.trapChoice(String(msg.id));
      else if (p.kind === "park-flip") g.parkFlipChoice(String(msg.id));
      else if (p.kind === "park-win") g.parkWinChoice(String(msg.id));
      else if (p.kind === "wu-toll") g.wuTollChoice(String(msg.id));
      else { err(ws, "unknown choice kind"); return; }
      sync(room);
      return;
    }
    case "cardApply": {
      if (!needCurrent(["card"])) return;
      g.resolveCard(null);
      sync(room);
      return;
    }
    case "cardTarget": {
      if (!needCurrent(["card"])) return;
      const target = room.players.find(m => m.name === msg.target);
      if (!target) { err(ws, "unknown target"); return; }
      g.resolveCard(g.players.find(p => p.name === msg.target) || null);
      sync(room);
      return;
    }
    case "yuanChoice": {
      if (!needCurrent(["yuan-peek"])) return;
      g.yuanChoice(!!msg.keep);
      sync(room);
      return;
    }
    case "skill": {
      if (!needCurrent()) return;
      if (g.phase !== "skill") { err(ws, "not skill phase"); return; }
      const id = String(msg.id);
      const valid = g.skillOptions().some(o => o.id === id);
      if (!valid) { err(ws, "skill not available"); return; }
      const targets = g.skillTargets(id);
      let target = null;
      if (targets.length) {
        if (!msg.target || !targets.some(t => t.name === msg.target)) { err(ws, "bad target"); return; }
        target = g.players.find(p => p.name === msg.target);
      }
      g.useSkill(id, target);
      sync(room);
      return;
    }
    case "endTurn": {
      if (!needCurrent()) return;
      if (g.phase !== "skill") { err(ws, "cannot end turn now"); return; }
      g.endTurn();
      sync(room);
      return;
    }
    default:
      err(ws, "unknown action " + msg.a);
  }
}

/* ---------------- socket lifecycle ---------------- */
function onMessage(ws, raw) {
  if (process.env.DEBUG_WS) console.log("[ws-in]", raw.slice(0, 200));
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { err(ws, "bad json"); return; }
  const member = ws._member;
  const room = ws._room;

  switch (msg.t) {
    case "create": {
      if (ws._room) return;
      const name = cleanName(msg.name);
      const code = newCode();
      if (!code) { err(ws, "server full, try later"); return; }
      const room = makeRoom(code, name, ws);
      const p = { name, seat: 0, color: playerColor(0), online: true, ws };
      room.players.push(p);
      ws._room = room; ws._member = p;
      resetIdle(room);
      ws.send({ t: "welcome", you: { name, seat: 0, spectator: false, host: true, color: p.color } });
      broadcastRoom(room);
      return;
    }
    case "join": {
      if (ws._room) return;
      const room = rooms.get(String(msg.code));
      if (!room) { err(ws, "room not found"); return; }
      const name = cleanName(msg.name);
      if (findMember(room, name)) { err(ws, "name taken in this room"); return; }
      // reconnect path (works during a running game too)
      const ghost = room.players.find(p => p.name === name && !p.ws);
      if (ghost) {
        ghost.ws = ws; ghost.online = true;
        if (ghost.goneTimer) clearTimeout(ghost.goneTimer);
        ws._room = room; ws._member = ghost;
        ws.send({ t: "welcome", you: { name, seat: ghost.seat, spectator: false, host: room.host === name, color: ghost.color } });
        broadcastRoom(room);
        if (room.game) sync(room);
        return;
      }
      if (room.game) { err(ws, "game already started"); return; }
      if (room.players.length >= MAX_PLAYERS) { err(ws, "player seats full"); return; }
      const seat = room.players.length;
      const p = { name, seat, color: playerColor(seat), online: true, ws };
      room.players.push(p);
      ws._room = room; ws._member = p;
      ws.send({ t: "welcome", you: { name, seat, spectator: false, host: false, color: p.color } });
      broadcastRoom(room);
      return;
    }
    case "spectate": {
      if (ws._room) return;
      const room = rooms.get(String(msg.code));
      if (!room) { err(ws, "room not found"); return; }
      const name = cleanName(msg.name);
      if (findMember(room, name)) { err(ws, "name taken in this room"); return; }
      const ghost = room.spectators.find(s => s.name === name && !s.ws);
      if (ghost) {
        ghost.ws = ws; ghost.online = true;
        ws._room = room; ws._member = ghost;
        ws.send({ t: "welcome", you: { name, seat: -1, spectator: true, host: false, color: "#888" } });
        broadcastRoom(room);
        if (room.game) sync(room);
        return;
      }
      if (room.spectators.length >= MAX_SPECTATORS) { err(ws, "spectator seats full"); return; }
      const s = { name, online: true, ws };
      room.spectators.push(s);
      ws._room = room; ws._member = s;
      ws.send({ t: "welcome", you: { name, seat: -1, spectator: true, host: false, color: "#888" } });
      broadcastRoom(room);
      if (room.game) sync(room);
      return;
    }
    case "start": {
      if (!member || !room) return;
      if (member.name !== room.host) { err(ws, "only the host can start"); return; }
      if (room.game) { err(ws, "already started"); return; }
      if (room.players.length < 4) { err(ws, "need 4–6 players to start"); return; }
      if (room.players.some(p => !p.ws)) { err(ws, "wait for all players to be online"); return; }
      startGame(room);
      return;
    }
    case "leave": {
      if (ws._room) detachMember(ws);
      return;
    }
    default:
      if (member && room) handleAction(room, member, msg, ws);
      else err(ws, "join a room first");
  }
}

function cleanName(s) {
  const n = String(s || "").trim().replace(/\s+/g, " ").slice(0, 20);
  return n || "Player" + Math.floor(Math.random() * 1000);
}

function detachMember(ws) {
  const room = ws._room, member = ws._member;
  if (!room || !member) return;
  member.ws = null;
  member.online = false;
  if (!room.game) {
    // pre-game: remove players/spectators immediately
    room.players = room.players.filter(p => p !== member);
    room.spectators = room.spectators.filter(s => s !== member);
    if (room.host === member.name && room.players.length) room.host = room.players[0].name;
    if (!room.players.length && !room.spectators.length) rooms.delete(room.code);
    else broadcastRoom(room);
  } else {
    broadcastRoom(room);
    member.goneTimer = setTimeout(() => {
      if (!member.ws) {
        room.players = room.players.filter(p => p !== member);
        room.spectators = room.spectators.filter(s => s !== member);
        const g = room.game;
        if (g && g.phase !== "over" && g.current() === g.players.find(x => x.name === member.name)) {
          // skip the disconnected player's turn so the game can continue
          const curPlayer = g.players.find(x => x.name === member.name);
          if (curPlayer) { /* endTurn expects current; fall through below */ }
          try { g.endTurn(); } catch (e) {}
        }
        if (g && g.players.every(p => !p.name)) { rooms.delete(room.code); return; }
        broadcastRoom(room);
        sync(room);
      }
    }, RECONNECT_GRACE_MS);
  }
  ws._room = null; ws._member = null;
}

/* ---------------- HTTP server ---------------- */
const server = http.createServer((req, res) => serveStatic(req, res));

server.on("upgrade", (req, socket, head) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  socket.setNoDelay(true);
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + wsAcceptKey(key) + "\r\n\r\n"
  );
  const ws = new WS(socket);
  ws.onmessage = (raw) => onMessage(ws, raw);
  ws.onclose = () => { if (ws._room) detachMember(ws); };
  if (head && head.length) ws._feed(head);
});

server.listen(PORT, () => {
  console.log("OverSCCed server running:");
  console.log("  local:  http://localhost:" + PORT);
  console.log("  LAN:    http://<这台电脑的局域网IP>:" + PORT);
});
