/* Network integration test: spawns the real server, connects 4 raw-socket
 * WebSocket clients, and plays a complete game through the wire protocol. */
"use strict";
const { spawn } = require("child_process");
const net = require("net");
const crypto = require("crypto");
const path = require("path");

const PORT = 3917;

/* ---------------- minimal WS client ---------------- */
class WSClient {
  constructor() {
    this.sock = net.connect(PORT, "127.0.0.1");
    this.buffer = Buffer.alloc(0);
    this.handshaken = false;
    this.queue = [];
    this.waiters = [];
    this.sock.on("data", (d) => this._feed(d));
    this.sock.on("error", () => {});
    const key = crypto.randomBytes(16).toString("base64");
    this.sock.write([
      "GET / HTTP/1.1",
      "Host: 127.0.0.1",
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: " + key,
      "Sec-WebSocket-Version: 13",
      "", "",
    ].join("\r\n"));
  }
  _feed(d) {
    if (process.env.DEBUG_CLIENT && this._p3) console.log("[p3-bytes]", Date.now() % 100000, d.length);
    this.buffer = Buffer.concat([this.buffer, d]);
    if (!this.handshaken) {
      const idx = this.buffer.indexOf("\r\n\r\n");
      if (idx < 0) return;
      this.handshaken = true;
      this.buffer = this.buffer.slice(idx + 4);
    }
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0], b1 = this.buffer[1];
      const opcode = b0 & 0x0f;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buffer.length < 10) return; len = Number(this.buffer.readBigUInt64BE(2)); off = 10; }
      if (this.buffer.length < off + len) return;
      const payload = this.buffer.slice(off, off + len);
      this.buffer = this.buffer.slice(off + len);
      if (opcode === 0x1) {
        const msg = JSON.parse(payload.toString("utf8"));
        if (this.waiters.length) {
          const w = this.waiters.shift();
          clearTimeout(w.timer);
          w.resolve(msg);
        } else {
          this.queue.push(msg);
        }
      }
    }
  }
  send(obj) {
    const payload = Buffer.from(JSON.stringify(obj), "utf8");
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
    let head;
    if (masked.length < 126) head = Buffer.from([0x81, 0x80 | masked.length]);
    else if (masked.length < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x81; head[1] = 0x80 | 126;
      head.writeUInt16BE(masked.length, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x81; head[1] = 0x80 | 127;
      head.writeBigUInt64BE(BigInt(masked.length), 2);
    }
    this.sock.write(Buffer.concat([head, mask, masked]));
  }
  next(timeoutMs = 10000) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error("timeout waiting for server message"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
  nextOfType(type, timeoutMs = 8000) {
    return (async () => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const m = await this.next(timeoutMs);
        if (m.t === type) return m;
      }
      throw new Error("expected " + type);
    })();
  }
  close() { this.sock.destroy(); }
}

/* ---------------- autoplayer ---------------- */
async function autoplay(client, name) {
  let lastKey = "";
  let acted = false;
  let lastSeen = "";
  while (true) {
    let msg;
    try {
      msg = await client.next(15000);
    } catch (e) {
      console.log("[TIMEOUT]", name, "lastSeen:", lastSeen);
      throw e;
    }
    if (msg.t === "err") { console.log("[ignored-err]", name, msg.msg); continue; }
    if (msg.t === "state") {
      const st = msg.state;
      lastSeen = st.phase + " turn=" + st.turn + " tc=" + st.turnCount + " tie=" + (st.rolloffTieNames ? "y" : "n");
      if (st.phase === "over") return st;
      const me = st.players.find(p => p.name === name);
      const key = st.phase + "|" + st.turnCount + "|" + st.turn + "|" + (st.deckCount);
      if (key !== lastKey) { lastKey = key; acted = false; }
      if (st.turn === name) {
        if (st.phase === "roll") {
          if (!acted) { acted = true; client.send({ a: "roll" }); }
        } else if (st.phase === "move-prompt") {
          if (!acted) {
            acted = true;
            if (me.coins >= 2 && Math.random() < 0.2) client.send({ a: "reroll" });
            else client.send({ a: "move" });
          }
        } else if (st.phase === "skill") {
          const opts = st.skillOptions || [];
          if (!acted && opts.length && Math.random() < 0.3) {
            acted = true;
            const o = opts[Math.floor(Math.random() * opts.length)];
            client.send({ a: "skill", id: o.id, target: o.targets.length ? o.targets[0] : null });
          } else {
            client.send({ a: "endTurn" });
          }
        }
      } else if (st.phase === "rolloff" && st.rolloffTieNames) {
        client.send({ a: "rolloffAgain" });
      }
    } else if (msg.t === "private") {
      lastSeen = "private:" + msg.pending.kind;
      const p = msg.pending;
      const respond = (obj) => client.send(obj);
      if (p.kind === "yuan-peek") respond({ a: "yuanChoice", keep: true });
      else if (p.kind === "park-win") respond({ a: "choice", id: "boost" });
      else if (p.kind === "park-flip") respond({ a: "choice", id: "normal" });
      else if (p.kind === "trap") respond({ a: "choice", id: p.options[0].id });
      else if (p.kind === "wu-toll") respond({ a: "choice", id: "pay" });
      else if (p.kind === "card") {
        if (p.card.needsTarget && p.targets.length) respond({ a: "cardTarget", target: p.targets[0] });
        else respond({ a: "cardApply" });
      } else if (p.kind === "hostile-choice") respond({ a: "choice", id: p.options[0].id });
      else throw new Error("unknown pending " + p.kind);
    }
  }
}



async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, "server.js"), String(PORT)], {
    cwd: path.join(__dirname, ".."),
  });
  server.stdout.on("data", (d) => process.stdout.write("[srv] " + d));
  server.stderr.on("data", (d) => process.stdout.write("[srv-err] " + d));
  await new Promise(r => setTimeout(r, 800));

  const clients = [new WSClient(), new WSClient(), new WSClient(), new WSClient()];
  const names = ["P1", "P2", "P3", "P4"];

  clients[0].send({ t: "create", name: "P1" });
  await clients[0].nextOfType("welcome");
  const roomMsg = await clients[0].nextOfType("room");
  const code = roomMsg.room.code;
  console.log("room created:", code);

  for (let i = 1; i < 4; i++) {
    clients[i].send({ t: "join", code, name: names[i] });
    await clients[i].nextOfType("welcome");
  }
  await new Promise(r => setTimeout(r, 300));

  clients[0].send({ t: "start" });
  await new Promise(r => setTimeout(r, 800));

  // --- reconnect scenario: P4 drops, rejoins mid-game ---
  clients[3].close();
  await new Promise(r => setTimeout(r, 600));
  clients[3] = new WSClient();
  clients[3].send({ t: "join", code, name: "P4" });
  await clients[3].nextOfType("welcome");
  console.log("P4 reconnected mid-game");

  // --- spectator joins mid-game ---
  const spec = new WSClient();
  spec.send({ t: "spectate", code, name: "Watcher" });
  await spec.nextOfType("welcome");
  const specState = await spec.nextOfType("state");
  console.log("spectator receiving state:", specState.state.phase);

  const results = await Promise.all(names.map((n, i) => autoplay(clients[i], n)));
  const over = results[0];
  console.log("game over — winner:", over.winner);
  console.log("standings:", over.standings.map(s => s.name + ":" + s.coins).join(" "));
  if (!over.winner) throw new Error("no winner");
  spec.close();
  for (const c of clients) c.close();
  server.kill();
  console.log("NET TEST OK — full 4-player game completed over WebSocket");
  process.exit(0);
}

setTimeout(() => { console.error("WATCHDOG: test stuck"); process.exit(2); }, 120000);
main().catch((e) => {
  console.error("NET TEST FAILED:", e.message);
  process.exit(1);
});
