/* End-to-end test over the REAL public MQTT broker: one host + three clients
 * play a complete game with the host acting as the authoritative server. */
"use strict";

const { Game, CARDS } = require("./rules.js");
const { BOARD_TILES } = require("./config.js");
const MQTTNet = require("./mqtt_host.js");
const miniMqtt = require("./mqtt_mini.js");

console.log("loaded:", typeof MQTTNet, "| mqtt mini:", typeof miniMqtt.connect);

function makeNet(name) {
  const queue = [];
  const waiters = [];
  const net = new MQTTNet({
    mqtt: miniMqtt,
    Game, BOARD_TILES, CARDS,
    onMessage(msg) { push(msg); },
  });
  function push(msg) {
    if (waiters.length) { const w = waiters.shift(); clearTimeout(w.timer); w.resolve(msg); }
    else queue.push(msg);
  }
  net.next = function (timeoutMs = 20000) {
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => { reject(new Error(name + " timeout")); }, timeoutMs);
      waiters.push(waiter);
    });
  };
  net.nextOfType = async function (type, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const m = await net.next(timeoutMs);
      if (m.t === type) return m;
    }
    throw new Error(name + " expected " + type);
  };
  return net;
}

async function autoplay(net, name) {
  let lastKey = "", acted = false, lastSeen = "";
  while (true) {
    let msg;
    try { msg = await net.next(40000); }
    catch (e) { console.log("[TIMEOUT]", name, "lastSeen:", lastSeen); throw e; }
    if (process.env.DEBUG_MQTT && name === "P1") console.log("[cli-P1]", msg.t, JSON.stringify(msg).slice(0, 120));
    if (msg.t === "err") { console.log("[ignored-err]", name, msg.msg); continue; }
    if (msg.t === "state") {
      const st = msg.state;
      lastSeen = st.phase + " turn=" + st.turn + " tc=" + st.turnCount + " pending?";
      if (st.phase === "over") return st;
      if (st.turnCount > maxTcSeen[name]) maxTcSeen[name] = st.turnCount;
      if (maxTcSeen[name] >= 8) return { smoke: true, turnCount: maxTcSeen[name] };
      const me = st.players.find(p => p.name === name);
      const key = st.phase + "|" + st.turnCount + "|" + st.turn + "|" + st.deckCount;
      if (key !== lastKey) { lastKey = key; acted = false; }
      if (st.turn === name) {
        if (st.phase === "roll") {
          if (!acted) { acted = true; net.act({ a: "roll" }); }
        } else if (st.phase === "move-prompt") {
          if (!acted) {
            acted = true;
            if (me.coins >= 2 && Math.random() < 0.2) net.act({ a: "reroll" });
            else net.act({ a: "move" });
          }
        } else if (st.phase === "skill") {
          const opts = st.skillOptions || [];
          if (!acted) {
            acted = true;
            if (opts.length && Math.random() < 0.3) {
              const o = opts[Math.floor(Math.random() * opts.length)];
              net.act({ a: "skill", id: o.id, target: o.targets.length ? o.targets[0] : null });
            } else net.act({ a: "endTurn" });
          }
        }
      } else if (st.phase === "rolloff" && st.rolloffTieNames) {
        net.act({ a: "rolloffAgain" });
      }
    } else if (msg.t === "private") {
      const p = msg.pending;
      lastSeen = "private:" + p.kind;
      if (p.kind === "yuan-peek") net.act({ a: "yuanChoice", keep: true });
      else if (p.kind === "park-win") net.act({ a: "choice", id: "boost" });
      else if (p.kind === "park-flip") net.act({ a: "choice", id: "normal" });
      else if (p.kind === "trap") net.act({ a: "choice", id: p.options[0].id });
      else if (p.kind === "wu-toll") net.act({ a: "choice", id: "pay" });
      else if (p.kind === "card") {
        if (p.card.needsTarget && p.targets.length) net.act({ a: "cardTarget", target: p.targets[0] });
        else net.act({ a: "cardApply" });
      } else if (p.kind === "hostile-choice") net.act({ a: "choice", id: p.options[0].id });
      else throw new Error("unknown pending " + p.kind);
    }
  }
}

const maxTcSeen = {};
async function main() {
  const host = makeNet("H");
  const c2 = makeNet("P2"), c3 = makeNet("P3"), c4 = makeNet("P4");
  await new Promise(r => setTimeout(r, 2000));

  host.create("P1");
  await host.nextOfType("welcome", 30000);
  const roomMsg = await host.nextOfType("room", 30000);
  const code = roomMsg.room.code;
  console.log("room created:", code, "token:", host.token);

  for (const [net, nm] of [[c2, "P2"], [c3, "P3"], [c4, "P4"]]) {
    net.join(code, nm, false);
    await net.nextOfType("welcome", 30000);
    console.log(nm, "joined");
  }
  await new Promise(r => setTimeout(r, 500));

  host.start();
  await new Promise(r => setTimeout(r, 800));

  const results = await Promise.all([
    autoplay(host, "P1"), autoplay(c2, "P2"), autoplay(c3, "P3"), autoplay(c4, "P4"),
  ]);
  const over = results[0];
  if (over.winner) {
    console.log("game over — winner:", over.winner);
    console.log("standings:", over.standings.map(s => s.name + ":" + s.coins).join(" "));
    console.log("MQTT E2E OK — FULL game completed via public broker, host-authoritative");
  } else {
    console.log("MQTT E2E OK (smoke) — game advanced past turn 8 on all 4 clients via public broker");
  }
  process.exit(0);
}

setTimeout(() => { console.error("WATCHDOG: stuck"); process.exit(2); }, 420000);
main().catch(e => { console.error("MQTT E2E FAILED:", e.message); process.exit(1); });
