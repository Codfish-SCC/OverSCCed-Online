/* OverSCCed online client — talks to server/server.js over WebSocket.
 * The server is authoritative; this file only renders state and sends actions.
 */
"use strict";

const $ = (id) => document.getElementById(id);
let ws = null;
let me = null;            // {name, seat, spectator, host, color}
let room = null;          // room view from server
let S = null;             // last game state
let myColor = "#888";
let colorOf = {};         // name -> color
let pending = null;       // private prompt for me
let lastActionKey = "";
let sawCharacters = false;
let retryTimer = null;
let reconnectAttempts = 0;

/* ---------------- helpers ---------------- */
function toast(text, ms) {
  const w = $("toasts");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  w.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 350);
  }, ms || 2600);
}
function showConnBar(text) {
  const b = $("connbar");
  b.textContent = text;
  b.style.display = "block";
}
function hideConnBar() { $("connbar").style.display = "none"; }

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  else showConnBar("Connection lost, reconnecting…");
}

function showOverlay(html, fullscreen) {
  const wrap = fullscreen
    ? `<div class="modal fullscreen"><div class="fsinner">${html}</div></div>`
    : `<div class="modal">${html}</div>`;
  $("overlay").innerHTML = wrap;
  $("overlay").style.display = "flex";
  document.body.classList.add("modal-open");
  if (fullscreen) document.body.classList.add("fs-open");
}
function hideOverlay() {
  $("overlay").style.display = "none";
  $("overlay").innerHTML = "";
  document.body.classList.remove("modal-open");
  document.body.classList.remove("fs-open");
}

function charInfo(charId) {
  return CHARACTERS.find(c => c.id === charId) || { id: charId, name: charId, role: "" };
}
function dieFace(v) {
  const pips = {
    1: [4], 2: [2, 6], 3: [2, 4, 6], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8],
  };
  const cells = Array.from({ length: 9 }, (_, i) => pips[v].includes(i) ? '<div class="pip"></div>' : "<div></div>").join("");
  return `<div class="die">${cells}</div>`;
}

/* ---------------- connection ---------------- */
function wsUrl() {
  if (location.protocol === "file:") return "ws://localhost:3000";
  return (location.protocol === "https:" ? "wss://" : "ws://") + location.host;
}
function connect() {
  try {
    ws = new WebSocket(wsUrl());
  } catch (e) {
    showConnBar("Cannot reach the server — make sure it is running.");
    return;
  }
  ws.onopen = () => {
    hideConnBar();
    reconnectAttempts = 0;
    const saved = JSON.parse(localStorage.getItem("overscced_net") || "{}");
    if (saved && saved.code && saved.name && saved.spectator === false && !me) {
      send({ t: "join", code: saved.code, name: saved.name });   // auto-rejoin
    } else if (saved && saved.code && saved.name && saved.spectator === true && !me) {
      send({ t: "spectate", code: saved.code, name: saved.name });
    }
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    handle(msg);
  };
  ws.onclose = () => {
    if (!me) return;
    showConnBar("Connection lost, reconnecting…");
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (reconnectAttempts++ < 30) connect();
      else showConnBar("Reconnect failed — refresh the page.");
    }, 1500);
  };
}

function handle(msg) {
  switch (msg.t) {
    case "welcome": {
      me = msg.you;
      myColor = me.color;
      renderLobby();
      break;
    }
    case "room": {
      room = msg.room;
      renderLobby();
      break;
    }
    case "state": {
      S = msg.state;
      colorOf = {};
      for (const p of S.players) colorOf[p.name] = colorOf[p.name] || seatColorOf(p.name);
      enterGameView();
      renderAll();
      break;
    }
    case "private": {
      pending = msg.pending;
      renderPending();
      break;
    }
    case "err": {
      toast("⚠ " + msg.msg, 3000);
      break;
    }
  }
}

function seatColorOf(name) {
  if (room) {
    const rp = room.players.find(p => p.name === name);
    if (rp) return rp.color;
  }
  if (me && me.name === name) return myColor;
  return "#888";
}

/* ---------------- lobby ---------------- */
function renderLobby() {
  const inRoom = !!(me && room);
  $("lobbyJoin").style.display = inRoom ? "none" : "";
  $("lobbyRoom").style.display = inRoom ? "" : "none";
  $("gameHeader").style.display = "none";
  $("gameView").style.display = "none";
  $("lobbyView").style.display = "flex";
  if (!inRoom) {
    if (localStorage.getItem("overscced_name")) $("lobbyName").value = localStorage.getItem("overscced_name");
    return;
  }
  $("roomCode").textContent = room.code;
  $("roomTag").textContent = "Room " + room.code;
  const isHost = me.host;
  $("roomCodeHint").textContent = isHost
    ? "Share this code with friends. Start when everyone is in."
    : "Waiting for the host to start…";
  // seats
  const COLORS = ["#e53935", "#1e88e5", "#43a047", "#8e24aa", "#fb8c00", "#d81b60"];
  let seats = "";
  for (let i = 0; i < 6; i++) {
    const p = room.players.find(x => x.seat === i);
    if (p) {
      seats += `<div class="seat ${p.name === me.name ? "me" : ""} ${p.online ? "" : "offline"}">
        <span class="dot" style="background:${p.color}"></span>
        <span class="nm">${esc(p.name)}${p.name === room.host ? " ★" : ""}</span>
        <span class="badge">${p.online ? "online" : "offline"}</span></div>`;
    } else {
      seats += `<div class="seat empty"><span class="dot" style="background:${COLORS[i]}"></span>
        <span class="nm">Seat ${i + 1}</span></div>`;
    }
  }
  $("seatgrid").innerHTML = seats;
  const specs = room.spectators.map(s => esc(s.name)).join(", ") || "none";
  $("specrow").innerHTML = `<b>Spectators (${room.spectators.length}/4):</b>${specs}`;
  const ready = !room.started && room.players.length >= 4 && room.players.every(p => p.online);
  const btn = $("btnStart");
  btn.disabled = !(isHost && ready);
  btn.textContent = room.started
    ? "Game in progress"
    : ready ? "Start game" : `Start game (${room.players.length}/4–6 players)`;
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function myName() {
  const v = $("lobbyName").value.trim();
  return v || ("Player" + Math.floor(Math.random() * 1000));
}
function createRoom() {
  const name = myName();
  localStorage.setItem("overscced_name", name);
  send({ t: "create", name });
}
function joinRoom(spectate) {
  const code = $("lobbyCode").value.trim();
  if (!/^\d{4}$/.test(code)) { toast("Enter the 4-digit room code"); return; }
  const name = myName();
  localStorage.setItem("overscced_name", name);
  localStorage.setItem("overscced_net", JSON.stringify({ code, name, spectator: spectate }));
  send(spectate ? { t: "spectate", code, name } : { t: "join", code, name });
}
function startRoom() { send({ t: "start" }); }
function leaveRoom() {
  send({ t: "leave" });
  localStorage.removeItem("overscced_net");
  me = null; room = null; S = null;
  ws.close();
  setTimeout(() => { connect(); }, 300);
}

/* ---------------- game view ---------------- */
const MAP_W = 2188, MAP_H = 1508;
function fitBoard() {
  const wrap = $("boardwrap"), img = $("boardimg");
  if (!wrap || !img) return;
  const availW = wrap.clientWidth - 24, availH = wrap.clientHeight - 24;
  const scale = Math.min(availW / MAP_W, availH / MAP_H);
  img.style.width = Math.floor(MAP_W * scale) + "px";
  img.style.height = Math.floor(MAP_H * scale) + "px";
}

function enterGameView() {
  if ($("gameView").style.display !== "flex") {
    $("lobbyView").style.display = "none";
    $("gameView").style.display = "flex";
    $("gameHeader").style.display = "flex";
    fitBoard();
  }
  if (!sawCharacters && S && S.players.length) {
    sawCharacters = true;
    showCharacters();
  }
}

function renderAll() {
  if (!S) return;
  if (S.phase !== "over") overShown = false;
  renderTurn();
  renderPlayersPanel();
  renderTokens();
  renderActions();
  renderLog();
}

function renderTurn() {
  const cur = S.turn ? S.players.find(p => p.name === S.turn) : null;
  const dot = $("turnbanner").querySelector(".dot");
  if (cur) {
    dot.style.background = colorOf[cur.name];
    $("turnname").textContent = cur.name + "'s turn" + (cur.name === me.name ? " (you!)" : "");
  } else if (S.phase === "over") {
    dot.style.background = "transparent";
    $("turnname").textContent = "Game over";
  } else {
    dot.style.background = "transparent";
    $("turnname").textContent = "Rolling for first player…";
  }
}

function renderPlayersPanel() {
  const box = $("players");
  box.innerHTML = S.players.map(p => {
    const c = charInfo(p.charId);
    const cur = p.name === S.turn && S.phase !== "over";
    return `<div class="prow ${cur ? "cur" : ""}">
      <span class="avatar" style="background:${colorOf[p.name]}">${esc(p.name[0].toUpperCase())}</span>
      <div class="info">
        <div class="nm">${esc(p.name)}${p.finished ? ' <span class="badge">' + (p.finishOrder === 1 ? "1st" : "done") + "</span>" : ""}</div>
        <div class="chr">${esc(c.name)}${p.heldMercy ? " · academic warning" : ""}${p.skipNextTurn ? " · skip next" : ""}</div>
      </div>
      <span class="coins"><img src="assets/coin.jpg" alt="IC">${p.coins}</span>
    </div>`;
  }).join("");
}

function renderTokens() {
  const holder = $("tokens");
  if (!S) { holder.innerHTML = ""; return; }
  const groups = {};
  for (const p of S.players) (groups[p.pos] = groups[p.pos] || []).push(p);
  const existing = {};
  for (const el of holder.children) existing[el.dataset.key] = el;
  for (const posStr in groups) {
    const g2 = groups[posStr];
    const tileIdx = Math.max(0, Math.min((typeof BOARD_TILES !== "undefined" ? BOARD_TILES.length : 57) - 1, g2[0].pos));
    const t = BOARD_TILES[tileIdx];
    const N = g2.length;
    const key = N === 1 ? "p:" + g2[0].name : "g:" + g2.map(p => p.name).sort().join("+");
    let el = existing[key];
    if (!el) {
      el = document.createElement("div");
      el.className = "token";
      el.dataset.key = key;
      holder.appendChild(el);
    }
    el.style.left = (t.x * 100) + "%";
    el.style.top = (t.y * 100) + "%";
    const size = N === 1 ? 28 : 30 + N * 3;
    el.style.width = size + "px";
    el.style.height = size + "px";
    if (N === 1) {
      el.style.background = colorOf[g2[0].name];
      el.textContent = g2[0].name[0].toUpperCase();
    } else {
      const stops = g2.map((p, i) => colorOf[p.name] + " " + (i / N * 100) + "% " + ((i + 1) / N * 100) + "%").join(", ");
      el.style.background = "conic-gradient(from 0deg, " + stops + ")";
      let labels = "";
      g2.forEach((p, i) => {
        const a = (i + 0.5) / N * 2 * Math.PI;
        const x = 50 + Math.sin(a) * 30, y = 50 - Math.cos(a) * 30;
        labels += `<span class="toklab" style="left:${x}%;top:${y}%;background:${colorOf[p.name]}">${esc(p.name[0].toUpperCase())}</span>`;
      });
      el.innerHTML = labels;
    }
    el.classList.toggle("finished", g2.every(p => p.finished));
    el.classList.toggle("current", g2.some(p => p.name === S.turn) && S.phase !== "over");
  }
  for (const el of [...holder.children]) {
    let used = false;
    for (const posStr in groups) {
      const g2 = groups[posStr];
      const k = g2.length === 1 ? "p:" + g2[0].name : "g:" + g2.map(p => p.name).sort().join("+");
      if (el.dataset.key === k) { used = true; break; }
    }
    if (!used) el.remove();
  }
}

function renderActions() {
  const box = $("actions");
  if (!S) return;
  const myTurn = S.turn === me.name && !me.spectator;
  const key = S.phase + "|" + S.turnCount + "|" + S.turn;
  const stepLabel = {
    roll: "Step 2/4 · Roll & move",
    "move-prompt": "Step 2/4 · Roll & move",
    skill: "Step 4/4 · Use a skill (optional)",
  }[S.phase] || "Step 3/4 · Resolve the tile";

  if (S.phase === "over") { box.innerHTML = ""; return; }

  if (S.phase === "rolloff") {
    const rolls = (S.rolloff || []).map(r =>
      `<div class="rollchip"><span class="rdot" style="background:${colorOf[r.name] || "#888"}"></span><b>${esc(r.name)}</b><span>${r.rolls.join(" · ")}</span></div>`).join("");
    let html = `<div class="phase-line">Roll-off — highest starts</div><div class="rollgrid">${rolls}</div>`;
    if (S.rolloffTieNames) {
      html += `<div class="btnrow" style="margin-top:8px"><button class="primary" onclick="netAction('rolloffAgain')">Roll again (${esc(S.rolloffTieNames.join(", "))})</button></div>`;
    }
    box.innerHTML = html;
    return;
  }

  if (!myTurn) {
    box.innerHTML = `<div class="stepchip">${stepLabel}</div>
      <div class="phase-line">${S.turn ? "Waiting for " + esc(S.turn) + "…" : "…"}</div>`;
    return;
  }

  if (S.phase === "roll") {
    const meP = S.players.find(p => p.name === me.name);
    let guessRow = "";
    if (meP && meP.charId === "park" && !meP.ultimateUsed) {
      guessRow = `<div class="phase-line">Park's blind guess: bet on a number — if it comes up, +4 IC and +2 tiles (once per game)</div>
        <div class="guessrow">${[1, 2, 3, 4, 5, 6].map(n => `<button id="guess${n}" onclick="setGuess(${n})">${n}</button>`).join("")}
        <button onclick="setGuess(0)">No bet</button></div>`;
    }
    box.innerHTML = `<div class="stepchip">${stepLabel}</div>${guessRow}
      <div class="btnrow"><button class="primary" onclick="netAction('roll')">Roll</button></div>`;
    return;
  }
  if (S.phase === "move-prompt" && S.lastRoll) {
    const meP = S.players.find(p => p.name === me.name);
    box.innerHTML = `<div class="stepchip">${stepLabel}</div>
      <div class="dice">${S.lastRoll.dice.map(dieFace).join("")}</div>
      <div class="phase-line">Total ${S.lastRoll.total} — move ${Math.min(S.lastRoll.total, (typeof BOARD_TILES !== "undefined" ? BOARD_TILES.length - 1 : 56) - meP.pos)} tiles</div>
      <div class="btnrow">
        <button class="primary" onclick="netAction('move')">Move</button>
        <button onclick="netAction('reroll')" ${meP.coins < 2 ? "disabled" : ""}>Re-roll (2 IC)</button>
      </div>`;
    return;
  }
  if (S.phase === "skill") {
    const opts = S.skillOptions || [];
    let html = `<div class="stepchip">${stepLabel}</div><div class="btnrow">`;
    for (const o of opts) {
      html += `<button onclick="netSkill('${o.id}')">${esc(o.label)}${o.targets.length ? " →" : ""}</button>`;
    }
    html += `<button class="primary" onclick="netAction('endTurn')">End turn</button></div>`;
    box.innerHTML = html;
    return;
  }
  box.innerHTML = `<div class="stepchip">${stepLabel}</div><div class="phase-line">…</div>`;
}

/* guess state (kept locally, sent with roll) */
let guess = 0;
function setGuess(n) {
  guess = n;
  for (let i = 0; i <= 6; i++) {
    const b = $("guess" + i);
    if (b) b.classList.toggle("on", i === n && n > 0);
  }
}
function netAction(a) {
  if (a === "roll") send({ a: "roll", guess: guess || null });
  else send({ a });
  guess = 0;
}
function netSkill(id) {
  const o = (S && S.skillOptions || []).find(x => x.id === id);
  if (!o) return;
  if (!o.targets.length) { send({ a: "skill", id }); return; }
  showOverlay(`<h2>Choose a target</h2>
    <div class="optlist">${o.targets.map(t =>
      `<button class="primary" onclick="pickSkillTarget('${id}','${esc(t)}')">${esc(t)}</button>`).join("")}
      <button onclick="hideOverlay()">Cancel</button></div>`);
}
function pickSkillTarget(id, target) {
  hideOverlay();
  send({ a: "skill", id, target });
}

function renderLog() {
  const box = $("log");
  box.innerHTML = (S.log || []).map(l => `<div class="l">${esc(l)}</div>`).join("");
  box.scrollTop = box.scrollHeight;
}

/* ---------------- private prompts (only my screen) ---------------- */
function renderPending() {
  if (!pending) return;
  const p = pending;
  if (p.kind === "yuan-peek") {
    showOverlay(`<h2>Yuanyuan's passive</h2>
      <div class="sub">You peeked at the top card (only you can see it)</div>
      <div class="cardface"><div class="decktag" style="color:#2a56c6">Top of deck</div>
      <div class="cname">${esc(p.card.name)}</div></div>
      <div class="btnrow"><button class="primary" style="flex:1" onclick="hideOverlay();send({a:'yuanChoice',keep:true})">Keep this card</button>
      <button style="flex:1" onclick="hideOverlay();send({a:'yuanChoice',keep:false})">Discard this card</button></div>`);
    return;
  }
  if (p.kind === "card") {
    const deckClass = p.card.deck === "d" ? "deck-d" : p.card.deck === "l" ? "deck-l" : "deck-s";
    showOverlay(`<div class="cardface">
        <div class="decktag ${deckClass}">${p.card.deck === "d" ? "Danger" : p.card.deck === "l" ? "Lucky" : "Special"}</div>
        <div class="cname">${esc(p.card.name)}</div>
        <div class="ceffect">${esc(p.card.effect)}</div>
      </div>
      <div class="optlist">${
        p.card.needsTarget && p.targets.length
          ? `<div class="sub">Choose a target player:</div>` + p.targets.map(t =>
              `<button class="primary" onclick="hideOverlay();send({a:'cardTarget',target:'${esc(t)}'})">${esc(t)}</button>`).join("")
          : `<button class="primary" onclick="hideOverlay();send({a:'cardApply'})">Confirm</button>`
      }</div>`);
    return;
  }
  if (p.kind === "trap" || p.kind === "wu-toll" || p.kind === "park-flip" || p.kind === "park-win" || p.kind === "hostile-choice") {
    const title = {
      trap: "Trap!", "wu-toll": "Toll", "park-flip": "Park's ultimate",
      "park-win": "Park guessed right!", "hostile-choice": "Opponent's card effect",
    }[p.kind];
    let extra = "";
    if (p.kind === "wu-toll") extra = `<div class="sub">You passed ${esc(p.target)} — pay the toll</div>`;
    if (p.kind === "park-win") extra = `<div class="sub">Dice ${p.dice.join(" · ")} = ${p.total} — you guessed right!</div>`;
    if (p.kind === "hostile-choice") extra = `<div class="sub">The effect targets you — choose how to respond:</div>`;
    showOverlay(`<h2>${title}</h2>${extra}
      <div class="optlist">${(p.options || []).map(o =>
        `<button class="primary" onclick="hideOverlay();send({a:'choice',id:'${o.id}'})">${esc(o.label)}</button>`).join("")}</div>`);
    return;
  }
}

/* ---------------- start / finish screens ---------------- */
function showCharacters() {
  const rows = S.players.map(p => {
    const c = charInfo(p.charId);
    return `<div class="charline">
      <span class="avatar" style="background:${colorOf[p.name]}">${esc(p.name[0].toUpperCase())}</span>
      <div style="flex:1"><b>${esc(p.name)}</b>
        <div class="sk">${esc(c.name)} — ${esc(c.role)}</div>
        <div class="sk">${esc(c.passive !== "—" ? "Passive: " + c.passive : "")}${c.ultimate ? (c.passive !== "—" ? " · " : "") + c.ultimate : ""}</div>
      </div>
    </div>`;
  }).join("");
  showOverlay(`<h2>Characters drawn</h2>
    <div class="sub">Pass the device around to see everyone's character</div>
    ${rows}
    <div class="row" style="margin-top:12px"><button class="primary" style="flex:1" onclick="hideOverlay()">Ready</button></div>`, true);
}

let overShown = false;
function showGameOver() {
  if (overShown) return;
  if (!S || S.phase !== "over" || !S.standings) return;
  overShown = true;
  const rows = S.standings.map((s, i) => `<tr>
    <td><b>${i === 0 ? "🥇 " : i === 1 ? "🥈 " : i === 2 ? "🥉 " : ""}${esc(s.name)}</b></td>
    <td>${esc(charInfo(s.charId).name)}</td>
    <td>${s.finishOrder ? "#" + s.finishOrder + " to finish" : "unfinished"}</td>
    <td><b>${s.coins} IC</b></td>
  </tr>`).join("");
  showOverlay(`<h2>Game over</h2>
    <div class="sub">Final standings (most IC wins)</div>
    <table class="standings"><tr><th>Player</th><th>Character</th><th>Finish</th><th>IC</th></tr>${rows}</table>
    <div class="row"><button class="primary" style="flex:1" onclick="hideOverlay();leaveRoom()">Back to lobby</button></div>`, true);
}

/* ---------------- boot ---------------- */
window.addEventListener("resize", fitBoard);
$("btnLeave").onclick = leaveRoom;
fitBoard();
connect();
setInterval(() => {
  // poll for the game-over screen in case the last state arrived before we rendered
  if (S && S.phase === "over") showGameOver();
}, 1500);
