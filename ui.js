/* OverSCCed — UI controller (hot-seat). */
"use strict";

const $ = (id) => document.getElementById(id);
const COLORS = ["#e53935", "#1e88e5", "#43a047", "#8e24aa", "#fb8c00", "#d81b60"];
const TYPE_LABEL = {
  start: "START", finish: "FINISH", blank: "BLANK", event: "EVENT",
  checkin: "CHECK-IN", trap: "TRAP", fwd: "+3", back: "−3",
};
const TYPE_CYCLE = ["blank", "event", "checkin", "trap", "fwd", "back", "start", "finish"];

let game = null;
let tiles = loadBoard();
let colorOf = {};
let calState = null;   // {stage:'pick'|'types', pts:[], idx}
let handoverDone = false;

/* ---------------- board config ---------------- */
function loadBoard() {
  try {
    const raw = localStorage.getItem("overscced_board_v1");
    if (raw) {
      const t = JSON.parse(raw);
      if (Array.isArray(t) && t.length === 57) return t;
    }
  } catch (e) { /* ignore */ }
  return BOARD_TILES.map(t => ({ ...t }));
}
function saveBoard(list) {
  tiles = list;
  localStorage.setItem("overscced_board_v1", JSON.stringify(list));
}

/* ---------------- setup UI ---------------- */
function showOverlay(html, opts) {
  opts = opts || {};
  const wrap = opts.fullscreen
    ? `<div class="modal fullscreen"><div class="fsinner">${html}</div></div>`
    : `<div class="modal">${html}</div>`;
  $("overlay").innerHTML = wrap;
  $("overlay").style.display = "flex";
  document.body.classList.add("modal-open");
  if (opts.fullscreen) document.body.classList.add("fs-open");
}
function hideOverlay() {
  $("overlay").style.display = "none";
  document.body.classList.remove("modal-open");
  document.body.classList.remove("fs-open");
}

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  $("toasts").appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 350); }, 2600);
}

function dieFace(value) {
  const map = {
    1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8],
  };
  const pips = map[value] || [];
  let cells = "";
  for (let i = 0; i < 9; i++) cells += `<span class="pip" style="${pips.includes(i) ? "" : "visibility:hidden"}"></span>`;
  return `<div class="die">${cells}</div>`;
}

function newGameFlow() {
  const countOptions = [4, 5, 6].map(n => `<option value="${n}" ${n === 4 ? "selected" : ""}>${n} players</option>`).join("");
  let namesHtml = "";
  for (let i = 0; i < 6; i++) {
    namesHtml += `<div class="row"><label style="width:70px;line-height:34px;color:var(--gray)">P${i + 1}</label>
      <input type="text" id="nm${i}" placeholder="Player ${i + 1}" ${i < 4 ? "" : 'style="display:none"'}>`;
    namesHtml += `</div>`;
  }
  showOverlay(`
    <h2>New game</h2>
    <div class="sub">4–6 players, one device. Everyone draws a character at random.</div>
    <div class="row"><label style="width:70px;line-height:34px;color:var(--gray)">Players</label>
      <select id="pcount" style="flex:1;padding:9px;border:1px solid var(--hair);border-radius:8px;font-family:inherit;font-size:14px">${countOptions}</select></div>
    <div id="namelist">${namesHtml}</div>
    <div class="row" style="margin-top:14px">
      <button class="primary" style="flex:1" onclick="startGame()">Start</button>
      <button style="flex:1" onclick="hideOverlay()">Cancel</button>
    </div>
  `, { fullscreen: true });
  $("pcount").onchange = () => {
    const n = +$("pcount").value;
    for (let i = 0; i < 6; i++) {
      const input = $("nm" + i);
      input.style.display = i < n ? "" : "none";
    }
  };
}

function showErr(msg) {
  const b = $("errbar");
  if (b) { b.style.display = "block"; b.textContent = "⚠ " + msg; }
}
function startGame() {
  try {
    startGameInner();
  } catch (err) {
    showErr(err && err.message ? err.message : String(err));
    console.error(err);
  }
}
function startGameInner() {
  toast("Starting game…");
  const n = +$("pcount").value;
  const names = [];
  for (let i = 0; i < n; i++) {
    const v = $("nm" + i).value.trim();
    names.push(v || `Player ${i + 1}`);
  }
  hideOverlay();
  game = new Game(tiles);
  colorOf = {};
  names.forEach((nm, i) => { colorOf[nm] = COLORS[i % COLORS.length]; });
  game.onLog = (msg) => appendLog(msg);
  game.onEvent = (evt) => handleEvent(evt);
  game.onPhase = () => { render(); handlePending(); };
  handoverDone = true;
  game.setup(names);
  revealCharacters();
  render();
  handlePending();
}

function revealCharacters() {
  const rows = game.players.map((p, i) => {
    const c = game.char(p);
    return `<div class="charline">
      <span class="avatar" style="background:${COLORS[i % COLORS.length]}">${p.name[0].toUpperCase()}</span>
      <div style="flex:1"><b>${p.name}</b>
        <div class="sk">${c.name} — ${c.role}</div>
        <div class="sk">${c.passive !== "—" ? "Passive: " + c.passive : ""}${c.ultimate ? (c.passive !== "—" ? " · " : "") + c.ultimate : ""}</div>
      </div></div>`;
  }).join("");
  showOverlay(`
    <h2>Characters drawn</h2>
    <div class="sub">Read your skills. Pass the device around the table.</div>
    ${rows}
    <div class="row" style="margin-top:12px"><button class="primary" style="flex:1" onclick="hideOverlay()">Ready</button></div>
  `, { fullscreen: true });
}

/* ---------------- rendering ---------------- */
function appendLog(msg) {
  const log = $("log");
  const div = document.createElement("div");
  div.className = "l";
  div.textContent = msg;
  log.prepend(div);
  while (log.children.length > 120) log.removeChild(log.lastChild);
}

function render() {
  if (!game) return;
  // players panel
  const cur = game.phase === "over" ? null : game.current();
  const rows = game.players.map(p => {
    const c = game.char(p);
    const badges = [];
    if (p.finished) badges.push(`<span class="badge">${ord(p.finishOrder)} place</span>`);
    if (p.heldMercy) badges.push(`<span class="badge">Mercy</span>`);
    if (p.skipNextTurn) badges.push(`<span class="badge">Skip</span>`);
    return `<div class="prow ${p === cur ? "cur" : ""}">
      <span class="avatar" style="background:${colorOf[p.name]}">${p.name[0].toUpperCase()}</span>
      <div class="info"><div class="nm">${p.name}</div><div class="chr">${c.name} · ${c.role}</div></div>
      ${badges.join("")}
      <span class="coins"><img src="assets/coin.jpg" alt="IC">${p.coins}</span>
    </div>`;
  }).join("");
  $("players").innerHTML = rows;

  // turn banner
  if (game.phase === "over") {
    $("turnbanner").style.display = "none";
  } else if (cur) {
    $("turnbanner").style.display = "flex";
    $("turnbanner").querySelector(".dot").style.background = colorOf[cur.name];
    $("turnname").textContent = `${cur.name} — ${game.char(cur).name}`;
  }
  renderTokens();
  renderActions();
}

function renderTokens() {
  const holder = $("tokens");
  if (!game) { holder.innerHTML = ""; return; }
  const groups = {};
  for (const p of game.players) (groups[p.pos] = groups[p.pos] || []).push(p);
  // stable key: single tokens keyed by player (so the SAME element glides tile→tile),
  // merged tokens keyed by the sorted set of names (so the pie follows the group)
  const existing = {};
  for (const el of holder.children) existing[el.dataset.key] = el;
  for (const posStr in groups) {
    const g2 = groups[posStr];
    const tileIdx = Math.max(0, Math.min(game.tiles.length - 1, g2[0].pos));
    const t = tiles[tileIdx];
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
    el.style.marginLeft = "0px";
    const size = N === 1 ? 28 : 30 + N * 3;
    el.style.width = size + "px";
    el.style.height = size + "px";
    if (N === 1) {
      el.style.background = colorOf[g2[0].name];
      el.textContent = g2[0].name[0].toUpperCase();
    } else {
      const stops = g2.map((p, i) =>
        colorOf[p.name] + " " + (i / N * 100) + "% " + ((i + 1) / N * 100) + "%").join(", ");
      el.style.background = "conic-gradient(from 0deg, " + stops + ")";
      let labels = "";
      g2.forEach((p, i) => {
        const a = (i + 0.5) / N * 2 * Math.PI;
        const x = 50 + Math.sin(a) * 30;
        const y = 50 - Math.cos(a) * 30;
        labels += '<span class="toklab" style="left:' + x + '%;top:' + y + '%;background:' +
                  colorOf[p.name] + '">' + p.name[0].toUpperCase() + '</span>';
      });
      el.innerHTML = labels;
    }
    el.classList.toggle("finished", g2.every(p => p.finished));
    el.classList.toggle("current",
      g2.some(p => p === game.current()) && game.phase !== "over");
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
  if (!game) { box.innerHTML = `<div class="dim">Press “New game” to start.</div>`; return; }
  if (game.phase === "rolloff") {
    const rolls = game.rolloff.map(r =>
      `<div class="rollchip"><span class="rdot" style="background:${colorOf[r.name]}"></span><b>${r.name}</b><span>${r.rolls.join(" · ")}</span></div>`).join("");
    box.innerHTML = `<div class="phase-line">Roll-off — highest starts</div>
      <div class="rollgrid">${rolls}</div>`;
    if (game.pending && game.pending.kind === "rolloff-reroll") {
      box.innerHTML += `<div class="btnrow" style="margin-top:8px"><button class="primary" onclick="rolloffAgain()">Roll again (${game.pending.names.join(", ")})</button></div>`;
    }
    return;
  }
  if (game.phase === "over") {
    box.innerHTML = `<div class="phase-line">Game over</div>
      <div class="btnrow"><button class="primary" onclick="newGameFlow()">Play again</button></div>`;
    return;
  }
  const p = game.current();
  const isCur = true;
  const stepLabel = {
    roll: "Step 2/4 · Roll & move",
    "move-prompt": "Step 2/4 · Roll & move",
    skill: "Step 4/4 · Use a skill (optional)",
  }[game.phase] || "Step 3/4 · Resolve the tile";
  let html = `<div class="stepchip">${stepLabel}</div>`;
  if (game.phase === "roll") {
    html += `<div class="phase-line">${p.name}: roll the die${p.charId === "park" ? " — guess first (optional)" : ""}</div>`;
    if (p.charId === "park") {
      html += `<div class="guessrow">${[1,2,3,4,5,6].map(n =>
        `<button id="g${n}" onclick="pickGuess(${n})">${n}</button>`).join("")}</div>`;
    }
    html += `<div class="btnrow" style="margin-top:8px"><button class="primary" onclick="doRoll()">Roll</button></div>`;
  } else if (game.phase === "move-prompt") {
    const lr = game.lastRoll;
    const total = lr.total;
    html += `<div class="phase-line">${p.name} rolled</div>
      <div class="dice">${lr.dice.map(v => dieFace(v)).join("")}</div>`;
    html += `<div class="btnrow">
      <button class="primary" onclick="doMove()">Move ${total} tile${total === 1 ? "" : "s"}</button>`;
    if (p.coins >= 2) html += `<button onclick="doReroll()">Re-roll — 2 IC</button>`;
    html += `</div>`;
  } else if (game.phase === "skill") {
    html += `<div class="phase-line">${p.name}: use a skill if you want</div>`;
    const opts = game.skillOptions();
    if (opts.length) {
      html += `<div class="btnrow">${opts.map(o =>
        `<button onclick="pickSkill('${o.id}')">${o.label}</button>`).join("")}</div>`;
    }
    html += `<div class="btnrow" style="margin-top:6px"><button class="primary" onclick="endTurn()">End turn</button></div>`;
  } else {
    html += `<div class="phase-line">…</div>`;
  }
  box.innerHTML = html;
}

function handleEvent(evt) {
  if (evt.type === "move") toast(`${evt.name} → tile ${evt.to + 1}`);
  if (evt.type === "finish") toast(`${evt.name} finished ${ord(evt.order)} (+${evt.bonus} IC)`);
  if (evt.type === "over") {
    toast(`${evt.winner} wins!`);
    showGameOver();
  }
}

function showGameOver() {
  const sorted = [...game.players].sort((a, b) =>
    b.coins - a.coins || a.finishOrder - b.finishOrder);
  const rows = sorted.map((p, i) =>
    `<tr><td>${i === 0 ? "🏆" : i + 1}</td><td>${p.name}</td><td>${game.char(p).name}</td>
     <td>${p.coins} IC</td><td>${p.finished ? ord(p.finishOrder) : "—"}</td></tr>`).join("");
  showOverlay(`
    <h2>${sorted[0].name} wins!</h2>
    <div class="sub">Most Inspiration Coins at the final count.</div>
    <table class="standings"><tr><th></th><th>Player</th><th>Character</th><th>Coins</th><th>Finish</th></tr>${rows}</table>
    <div class="row"><button class="primary" style="flex:1" onclick="hideOverlay()">Close</button></div>
  `, { fullscreen: true });
}

/* ---------------- pending interactions ---------------- */
let lastPending = null;
function handlePending() {
  if (!game || !game.pending) return;
  const pend = game.pending;
  if (pend === lastPending) return;
  lastPending = pend;
  const k = pend.kind;
  if (k === "rolloff-reroll") {
    // handled inline in actions
    render();
    return;
  }
  if (k === "yuan-peek") {
    const card = cardById(pend.card);
    showOverlay(`
      <h2>Yuan Yuan · Reviewer's eye</h2>
      <div class="sub">The top Event card is:</div>
      <div class="cardface"><span class="decktag ${deckClass(card.deck)}">${card.deck} deck</span>
        <div class="cname">${card.name}</div><div class="ceffect">${card.effect}</div></div>
      <div class="row"><button class="primary" style="flex:1" onclick="yuanChoice(true)">Keep it on top</button>
      <button style="flex:1" onclick="yuanChoice(false)">Bury it</button></div>
    `);
    return;
  }
  if (k === "park-win") {
    showOverlay(`
      <h2>Park predicted it!</h2>
      <div class="sub">You rolled ${pend.dice.join(" · ")} — choose your prize.</div>
      <div class="optlist">${pend.options.map(o =>
        `<button class="primary" onclick="parkWin('${o.id}')">${o.label}</button>`).join("")}</div>
    `);
    return;
  }
  if (k === "park-flip") {
    showOverlay(`
      <h2>Deadline Trap!</h2>
      <div class="optlist">${pend.options.map(o =>
        `<button class="primary" onclick="parkFlip('${o.id}')">${o.label}</button>`).join("")}</div>
    `);
    return;
  }
  if (k === "trap") {
    showOverlay(`
      <h2>Deadline Trap!</h2>
      <div class="sub">Lose 2 IC or retreat 3 tiles. Pay 3 IC to ignore it entirely.</div>
      <div class="optlist">${pend.options.map(o =>
        `<button class="primary" onclick="trapPick('${o.id}')">${o.label}</button>`).join("")}</div>
    `);
    return;
  }
  if (k === "wu-toll") {
    showOverlay(`
      <h2>${pend.target}'s toll</h2>
      <div class="sub">You are about to pass her tile.</div>
      <div class="optlist">${pend.options.map(o =>
        `<button class="primary" onclick="wuPick('${o.id}')">${o.label}</button>`).join("")}</div>
    `);
    return;
  }
  if (k === "card") {
    const card = pend.card;
    const deckLabel = { danger: "DANGER DECK", lucky: "LUCKY DECK", social: "SOCIAL DECK" }[card.deck];
    if (card.needsTarget) {
      const others = game.boardPlayers().filter(o => o !== game.current());
      showOverlay(`
        <h2>${card.name}</h2>
        <div class="cardface"><span class="decktag ${deckClass(card.deck)}">${deckLabel}</span>
          <div class="ceffect">${card.effect}</div></div>
        <div class="sub">Choose a target:</div>
        <div class="optlist">${others.map(o =>
          `<button class="primary" onclick="cardTarget('${o.name}')">${o.name}</button>`).join("")}</div>
      `);
    } else {
      showOverlay(`
        <h2>${card.name}</h2>
        <div class="cardface"><span class="decktag ${deckClass(card.deck)}">${deckLabel}</span>
          <div class="ceffect">${card.effect}</div></div>
        <div class="row"><button class="primary" style="flex:1" onclick="cardApply()">Apply</button></div>
      `);
    }
    return;
  }
  if (k === "hostile-choice") {
    showOverlay(`
      <h2>${pend.target}, choose:</h2>
      <div class="optlist">${pend.options.map(o =>
        `<button class="primary" onclick="hostilePick('${o.id}')">${o.label}</button>`).join("")}</div>
    `);
    return;
  }
}

function cardById(id) { return CARDS.find(c => c.id === id); }
function deckClass(deck) { return deck === "danger" ? "deck-d" : deck === "lucky" ? "deck-l" : "deck-s"; }

/* ---------------- action wiring ---------------- */
function rolloffAgain() { game.rerollTie(); render(); handlePending(); }
function pickGuess(n) {
  const p = game.current();
  game.setParkGuess(n);
  for (let i = 1; i <= 6; i++) $("g" + i).classList.toggle("on", i === n);
  $("g" + n).classList.toggle("on", p.parkGuess === n);
}
function doRoll() { game.roll(); render(); handlePending(); }
function doMove() { game.afterRollMove(game.lastRoll.total); render(); handlePending(); }
function doReroll() { game.reroll(); render(); handlePending(); }
function endTurn() { lastPending = null; game.endTurn(); render(); handlePending(); }
function yuanChoice(keep) { lastPending = null; game.yuanChoice(keep); hideOverlay(); render(); handlePending(); }
function parkWin(id) { lastPending = null; game.parkWinChoice(id); hideOverlay(); render(); handlePending(); }
function parkFlip(id) { lastPending = null; game.parkFlipChoice(id); hideOverlay(); render(); handlePending(); }
function trapPick(id) { lastPending = null; game.trapChoice(id); hideOverlay(); render(); handlePending(); }
function wuPick(id) { lastPending = null; game.wuTollChoice(id); hideOverlay(); render(); handlePending(); }
function cardTarget(name) {
  const target = game.players.find(p => p.name === name);
  lastPending = null;
  game.resolveCard(target);
  hideOverlay(); render(); handlePending();
}
function cardApply() { lastPending = null; game.resolveCard(null); hideOverlay(); render(); handlePending(); }
function hostilePick(id) { lastPending = null; game.hostileChoice(id); hideOverlay(); render(); handlePending(); }

function pickSkill(id) {
  const targets = game.skillTargets(id);
  if (targets.length) {
    showOverlay(`
      <h2>Choose a target</h2>
      <div class="optlist">${targets.map(t =>
        `<button class="primary" onclick="skillWithTarget('${id}','${t.name}')">${t.name}</button>`).join("")}
        <button onclick="hideOverlay()">Cancel</button></div>
    `);
  } else {
    game.useSkill(id, null);
    render(); handlePending();
  }
}
function skillWithTarget(id, name) {
  const t = game.players.find(p => p.name === name);
  lastPending = null;
  game.useSkill(id, t);
  hideOverlay(); render(); handlePending();
}

/* ---------------- rules modal ---------------- */
function showRules() {
  showOverlay(`
    <h2>OverSCCed — quick rules</h2>
    <div class="sub">Race across the campus. The richest player wins.</div>
    <p style="font-size:13.5px;line-height:1.6">
      <b>Setup.</b> 4–6 players. Everyone draws a character at random and takes 5 IC (Sansom: 7).
      All roll a die — highest starts; ties roll again until one is highest.<br><br>
      <b>Your turn.</b> ① Check status ② Roll & move ③ Resolve the tile ④ Use a skill (optional).<br><br>
      <b>Tiles.</b> Blank: nothing · Event: draw a card · Check-in: +2 IC · Trap: −2 IC or back 3
      (pay 3 IC to ignore) · +3/−3 movement tiles · Finish: arrival bonus.<br><br>
      <b>Coins.</b> Re-roll: 2 IC. Cancel a penalty: 3 IC. Broke (0 IC): Academic Warning —
      back 5 tiles, +2 IC next turn, once per turn.<br><br>
      <b>Winning.</b> Overshoot is fine. Arrival bonus: 1st +5 · 2nd +3 · 3rd +1. Game ends when the
      last player finishes — most IC wins, ties go to the earlier finisher.
    </p>
    <div class="row" style="margin-top:12px"><button class="primary" style="flex:1" onclick="hideOverlay()">Close</button></div>
  `, { fullscreen: true });
}

/* ---------------- calibration ---------------- */
function startCalibration() {
  if (game) { toast("Finish the current game first."); return; }
  calState = { stage: "pick", pts: [], idx: 0 };
  renderCalMarks();
  $("boardimg").style.cursor = "crosshair";
  $("calhint").style.display = "block";
  $("calbtns").style.display = "flex";
  updateCalUI();
}

function updateCalUI() {
  if (!calState) return;
  if (calState.stage === "pick") {
    const idx = calState.idx;
    if (idx < 57) $("calhint").textContent = `Click tile ${idx + 1} / 57${idx === 0 ? " (Start)" : idx === 56 ? " (Finish)" : ""}`;
    else $("calhint").textContent = "All 57 placed — click Done to set tile types.";
    $("calbtns").innerHTML = `
      <button onclick="calUndo()">Undo</button>
      <button class="primary" onclick="calDonePicking()">Done</button>
      <button onclick="cancelCal()">Cancel</button>`;
  } else {
    $("calhint").textContent = "Click a tile to cycle its type. Then Save.";
    $("calbtns").innerHTML = `
      <button onclick="calBackToPick()">Redo points</button>
      <button class="primary" onclick="calSave()">Save</button>
      <button onclick="cancelCal()">Cancel</button>`;
  }
}

function renderCalMarks() {
  const holder = $("calmarks");
  holder.innerHTML = "";
  if (!calState) return;
  if (calState.stage === "pick") {
    calState.pts.forEach((pt, i) => {
      const m = document.createElement("div");
      m.className = "calmark";
      m.style.left = (pt.x * 100) + "%";
      m.style.top = (pt.y * 100) + "%";
      m.textContent = i + 1;
      holder.appendChild(m);
    });
  } else {
    calState.pts.forEach((pt, i) => {
      const m = document.createElement("div");
      m.className = "typemark";
      m.style.left = (pt.x * 100) + "%";
      m.style.top = (pt.y * 100) + "%";
      m.textContent = TYPE_LABEL[pt.type] || "?";
      holder.appendChild(m);
    });
  }
}

function boardClick(e) {
  if (!calState) return;
  const box = $("boardbox");
  const rect = box.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  if (calState.stage === "pick") {
    if (calState.idx >= 57) return;
    calState.pts.push({ x, y, type: DEFAULT_TYPES[calState.idx] });
    calState.idx++;
  } else {
    // cycle type of nearest tile
    let best = -1, bestD = 1e9;
    calState.pts.forEach((pt, i) => {
      const d = (pt.x - x) ** 2 + (pt.y - y) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best >= 0 && bestD < 0.004) {
      const t = calState.pts[best].type;
      calState.pts[best].type = TYPE_CYCLE[(TYPE_CYCLE.indexOf(t) + 1) % TYPE_CYCLE.length];
    }
  }
  renderCalMarks();
  updateCalUI();
}

function calUndo() {
  if (!calState || calState.stage !== "pick") return;
  calState.pts.pop();
  calState.idx = Math.max(0, calState.idx - 1);
  renderCalMarks(); updateCalUI();
}
function calDonePicking() {
  if (calState.idx < 57) { toast("Click all 57 tiles first."); return; }
  calState.stage = "types";
  renderCalMarks(); updateCalUI();
}
function calBackToPick() {
  calState.stage = "pick";
  calState.idx = 57;
  renderCalMarks(); updateCalUI();
}
function calSave() {
  saveBoard(calState.pts.map(p => ({ ...p })));
  downloadConfig();
  cancelCal();
  toast("Board saved. It will be used from now on.");
}
function cancelCal() {
  calState = null;
  $("calmarks").innerHTML = "";
  $("calhint").style.display = "none";
  $("calbtns").style.display = "none";
  $("boardimg").style.cursor = "";
}
function downloadConfig() {
  const body = `/* OverSCCed board config (calibrated) */\n` +
    `const DEFAULT_TYPES = ${JSON.stringify(tiles.map(t => t.type))};\n\n` +
    `const COLS = 9, ROWS = 5, MX = 0, MY = 0;\n\n` +
    `function buildDefaultBoard() {\n  return ${JSON.stringify(tiles)};\n}\n\n` +
    `const BOARD_TILES = buildDefaultBoard();\n`;
  const blob = new Blob([body], { type: "text/javascript" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "config.js";
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------------- init ---------------- */
function ord(n) { return n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`; }

const MAP_W = 2188, MAP_H = 1508;
function fitBoard() {
  const wrap = $("boardwrap");
  const img = $("boardimg");
  if (!wrap || !img) return;
  const availW = wrap.clientWidth - 24;
  const availH = wrap.clientHeight - 24;
  const scale = Math.min(availW / MAP_W, availH / MAP_H);
  img.style.width = Math.floor(MAP_W * scale) + "px";
  img.style.height = Math.floor(MAP_H * scale) + "px";
}

fitBoard();
window.addEventListener("resize", fitBoard);
$("btnNew").onclick = newGameFlow;
$("btnRules").onclick = showRules;
$("btnCal").onclick = startCalibration;
$("boardbox").onclick = boardClick;

render();
if ($("buildtag")) $("buildtag").textContent = "v17 ✓";
appendLog("OverSCCed web edition loaded. Press “New game” to start.");
appendLog("Tip: the board layout is a default guess — press “Calibrate board” and click your 57 tiles once, in path order.");
