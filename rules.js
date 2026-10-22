/* OverSCCed — rules engine (pure logic, no DOM). Testable in Node. */
"use strict";

const CARDS = [
  // --- DANGER DECK (6)
  { id: "schrodinger", deck: "danger", name: "Schrödinger's Teammate",
    effect: "Lose 2 IC.",
    run: (g, p) => g.loseCoins(p, 2, "Schrödinger's Teammate") },
  { id: "stubborn", deck: "danger", name: "The Stubborn Rebels",
    effect: "Your turn ends now. Skip your next roll.",
    run: (g, p) => { p.skipNextRoll = true; g.forceEndTurn("The Stubborn Rebels"); } },
  { id: "server404", deck: "danger", name: "The Server's Sigh",
    effect: "Back 3 tiles.",
    run: (g, p) => g.moveBack(p, 3, "The Server's Sigh") },
  { id: "semistranger", deck: "danger", name: "Semi-Stranger Social Crisis",
    effect: "Pay 1 IC to the player with the fewest coins. (KK is immune.)",
    run: (g, p) => {
      if (p.charId === "kk") { g.log("KK is immune — social anxiety, finally useful."); return; }
      const others = g.boardPlayers().filter(o => o !== p);
      let target = null;
      for (const o of others) if (!target || o.coins < target.coins) target = o;
      if (target && target.coins <= p.coins) {
        g.payTo(p, target, 1, "Semi-Stranger Social Crisis");
      } else {
        g.loseCoins(p, 1, "Semi-Stranger Social Crisis (poorest already)");
      }
    } },
  { id: "chaindeadlines", deck: "danger", name: "Chain Deadlines",
    effect: "Roll: 1–3 lose 2 IC · 4–6 nothing.",
    run: (g, p) => {
      const r = g.rollDie();
      if (r <= 3) g.loseCoins(p, 2, `Chain Deadlines (rolled ${r})`);
      else g.log(`${p.name} survived Chain Deadlines (rolled ${r}).`);
    } },
  { id: "nothingsticks", deck: "danger", name: "Nothing Sticks",
    effect: "Back to the nearest Trap behind you. Take its penalty.",
    run: (g, p) => {
      let idx = -1;
      for (let i = p.pos - 1; i >= 0; i--) if (g.tileType(i) === "trap") { idx = i; break; }
      if (idx < 0) { g.log("No trap behind — nothing happens."); return; }
      g.emit({ type: "move", name: p.name, from: p.pos, to: idx });
      p.pos = idx;
      g.log(`${p.name} dragged back to a Deadline Trap.`);
      g.applyTrapPenalty(p, true);
    } },
  // --- LUCKY DECK (6)
  { id: "carry", deck: "lucky", name: "The Carry Arrives",
    effect: "+3 tiles and +1 IC.",
    run: (g, p) => { g.gainCoins(p, 1, "The Carry Arrives"); g.moveForward(p, 3, "The Carry Arrives"); } },
  { id: "mystic", deck: "lucky", name: "Mystic Marks",
    effect: "+3 IC.",
    run: (g, p) => g.gainCoins(p, 3, "Mystic Marks") },
  { id: "mercy", deck: "lucky", name: "The Professor's Mercy",
    effect: "Keep this card. Cancels your next Trap.",
    run: (g, p) => { p.heldMercy = true; g.log(`${p.name} keeps The Professor's Mercy.`); } },
  { id: "proposal", deck: "lucky", name: "The Perfect Proposal",
    effect: "+2 IC.",
    run: (g, p) => g.gainCoins(p, 2, "The Perfect Proposal") },
  { id: "exhibition", deck: "lucky", name: "Exhibition Success",
    effect: "+1 IC and +2 tiles.",
    run: (g, p) => { g.gainCoins(p, 1, "Exhibition Success"); g.moveForward(p, 2, "Exhibition Success"); } },
  { id: "survey", deck: "lucky", name: "The Perfect Survey",
    effect: "+3 tiles.",
    run: (g, p) => g.moveForward(p, 3, "The Perfect Survey") },
  // --- SOCIAL DECK (6)
  { id: "midnight", deck: "social", name: "Midnight Food Post",
    effect: "Dice duel with a chosen player — lower roll pays 1 IC.",
    needsTarget: true,
    run: (g, p, target) => g.startDuel(p, target) },
  { id: "hostile", deck: "social", name: "The Hostile Question",
    effect: "Target chooses: pay 2 IC to the bank, or back 3 tiles.",
    needsTarget: true,
    run: (g, p, target) => g.offerTargetChoice(target) },
  { id: "monopoly", deck: "social", name: "Equipment Monopoly",
    effect: "Target skips their entire next turn.",
    needsTarget: true,
    run: (g, p, target) => { target.skipNextTurn = true; g.log(`${target.name} will skip their next turn.`); } },
  { id: "carpool", deck: "social", name: "Forced Carpool",
    effect: "Join the nearest player ahead. Pay them 1 IC.",
    run: (g, p) => {
      const ahead = g.boardPlayers().filter(o => o !== p && o.pos > p.pos).sort((a, b) => a.pos - b.pos);
      if (!ahead.length) { g.log("Nobody ahead — the card fizzles."); return; }
      const t = ahead[0];
      g.emit({ type: "move", name: p.name, from: p.pos, to: t.pos });
      p.pos = t.pos;
      g.log(`${p.name} teleports to ${t.name}'s tile.`);
      g.payTo(p, t, 1, "Forced Carpool");
      g.checkTriggers(p);
    } },
  { id: "wrongplug", deck: "social", name: "The Wrong Plug",
    effect: "Everyone within 2 tiles (including you): back 2.",
    run: (g, p) => {
      for (const o of [...g.boardPlayers()]) {
        if (Math.abs(o.pos - p.pos) <= 2) g.moveBack(o, 2, "The Wrong Plug");
      }
      g.checkTriggers(p);
    } },
  { id: "assassin", deck: "social", name: "Questionnaire Assassin",
    effect: "Everyone with more IC than you pays you 1 IC.",
    run: (g, p) => {
      for (const o of g.boardPlayers()) {
        if (o !== p && o.coins > p.coins) g.payTo(o, p, 1, "Questionnaire Assassin");
      }
    } },
];

const CHARACTERS = [
  { id: "zhuang", name: "Zhuang Yiren", role: "the Dean",
    passive: "—", ultimate: "Assembly (1×/game): every unfinished player back 1 tile and −1 IC." },
  { id: "sansom", name: "Matthew James Sansom", role: "the Associate Dean",
    passive: "Starts with 7 IC (2 extra).",
    ultimate: "Swap places with any player. Cost: 4 IC to the bank + 2 IC to them." },
  { id: "park", name: "Geuntae Park", role: "the Syllabus Controller",
    passive: "Guess your roll (1–6). Right: move normally, then +4 IC & +2 tiles — or +6 IC instead.",
    ultimate: "Land on a penalty tile? It becomes a reward of equal value (+2 IC)." },
  { id: "wangxi", name: "Wang Xi", role: "Mutual Benefit",
    passive: "Can cancel another player's trap (2 IC), then advances 3 herself.",
    ultimate: "You and one player both +2 IC and +2 tiles." },
  { id: "iceman", name: "Iceman", role: "the AI Pioneer",
    passive: "Players landing on your tile bounce back 2.",
    ultimate: "Embrace AI (2×/game): move exactly 4 instead of rolling." },
  { id: "kk", name: "KK", role: "the Reluctant Socialite",
    passive: "Player stops within 1 tile of you → you auto-move +2 (max 3×/game).",
    ultimate: "Drag a player behind you forward — both +3." },
  { id: "yuanyuan", name: "Yuan Yuan", role: "the Syllabus Reviewer",
    passive: "Each turn, peek the top Event card — keep it or bury it." },
  { id: "wupeiyi", name: "Wu Peiyi", role: "the Strict Examiner",
    passive: "Passing her tile? Pay her 1 IC or stop one tile behind." },
  { id: "weigailan", name: "Wei Gailan", role: "the Inspiration Catcher",
    passive: "Rolls 2 dice every turn and takes the higher. Doubles? Back 1." },
  { id: "dingyi", name: "Ding Yi", role: "the Resource Auditor",
    passive: "Any unfinished player rolling 1 or 2 pays her 1 IC." },
];

class Game {
  constructor(boardTiles, opts = {}) {
    this.tiles = boardTiles;               // [{type, x, y}]  x,y relative 0..1
    this.rng = opts.rng || Math.random;
    this.logLines = [];
    this.pending = null;
    this.winner = null;
    this.players = [];
    this.deck = [];
    this.order = [];
    this.currentIdx = 0;
    this.phase = "idle";                   // rolloff | roll | move-prompt | skill | over
    this.rolloff = [];
    this.turnCount = 0;
    this.lastRoll = null;
  }

  tileType(i) { return this.tiles[i] ? this.tiles[i].type : "blank"; }
  endTile() { return this.tiles.length - 1; }   // index of the Finish tile
  boardPlayers() { return this.players.filter(p => !p.finished); }
  char(p) { return CHARACTERS.find(c => c.id === p.charId); }
  log(msg) {
    this.logLines.unshift(msg);
    if (this.logLines.length > 300) this.logLines.pop();
    if (this.onLog) this.onLog(msg);
  }
  emit(evt) { if (this.onEvent) this.onEvent(evt); }
  /* Every "waiting for player input" moment goes through here,
     so the UI always wakes up and shows the prompt. */
  setPending(p) {
    this.pending = p;
    if (this.onPhase) this.onPhase();
  }
  rollDie() { return 1 + Math.floor(this.rng() * 6); }

  /* ---------------- setup ---------------- */
  setup(names) {
    this.players = [];
    const charIds = CHARACTERS.map(c => c.id);
    for (let i = charIds.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [charIds[i], charIds[j]] = [charIds[j], charIds[i]];
    }
    for (let i = 0; i < names.length; i++) {
      this.players.push({
        name: names[i], charId: charIds[i], coins: 5, pos: 0,
        finished: false, finishOrder: 0,
        skipNextTurn: false, skipNextRoll: false,
        warnedThisTurn: false, pendingWarnBonus: false,
        heldMercy: false, ultimateUsed: false, ultUses: 0,
        kkUses: 0, parkGuess: null,
      });
    }
    const sansom = this.players.find(p => p.charId === "sansom");
    if (sansom) sansom.coins = 7;
    this.deck = CARDS.map(c => c.id);
    for (let i = this.deck.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
    }
    this.rolloff = this.players.map(p => ({ name: p.name, rolls: [], done: false }));
    this.phase = "rolloff";
    this.currentIdx = 0;
    this.log("Game started. Rolling to see who goes first…");
    this.doRolloff();
  }

  doRolloff() {
    const contenders = this.rolloff.filter(r => !r.done);
    const results = contenders.map(r => {
      const v = this.rollDie();
      r.rolls.push(v);
      return { r, v };
    });
    const max = Math.max(...results.map(x => x.v));
    const top = results.filter(x => x.v === max);
    this.emit({ type: "rolloff", rolls: results.map(x => ({ name: x.r.name, value: x.v })) });
    if (top.length === 1) {
      const starter = top[0].r;
      this.log(`${starter.name} rolled ${max} and goes first.`);
      const si = this.players.findIndex(p => p.name === starter.name);
      this.order = [];
      for (let k = 0; k < this.players.length; k++) this.order.push((si + k) % this.players.length);
      this.currentIdx = 0;
      this.log(`Turn order: ${this.order.map(i => this.players[i].name).join(" → ")}`);
      this.phase = "turn";
      this.beginTurn();
    } else {
      for (const r of this.rolloff) r.done = true;
      for (const x of top) x.r.done = false;
      this.log(`Tie at ${max} — ${top.map(x => x.r.name).join(", ")} roll again.`);
      this.setPending({ kind: "rolloff-reroll", names: top.map(x => x.r.name) });
    }
  }

  rerollTie() { this.pending = null; this.doRolloff(); }

  /* ---------------- turn flow ---------------- */
  current() { return this.players[this.order[this.currentIdx]]; }

  beginTurn() {
    const p = this.current();
    this.turnCount++;
    p.warnedThisTurn = false;
    p.parkGuess = null;
    this.log(`— ${p.name}'s turn —`);
    if (p.skipNextTurn) {
      p.skipNextTurn = false;
      this.log(`${p.name} skips this turn entirely.`);
      this.endTurn();
      return;
    }
    if (p.pendingWarnBonus) {
      p.pendingWarnBonus = false;
      this.gainCoins(p, 2, "Academic Warning recovery");
    }
    if (p.skipNextRoll) {
      p.skipNextRoll = false;
      this.log(`${p.name} skips the roll this turn.`);
      this.phase = "skill";
      if (this.onPhase) this.onPhase();
      return;
    }
    if (p.charId === "yuanyuan" && this.deck.length) {
      this.setPending({ kind: "yuan-peek", card: this.deck[this.deck.length - 1] });
      return;
    }
    this.phase = "roll";
    this.emit({ type: "turn-start", name: p.name });
    if (this.onPhase) this.onPhase();
  }

  yuanChoice(keepTop) {
    const p = this.current();
    if (keepTop) this.log(`${p.name} keeps the top card.`);
    else {
      const c = this.deck.pop();
      this.deck.unshift(c);
      this.log(`${p.name} buries the top card at the bottom.`);
    }
    this.pending = null;
    this.phase = "roll";
    if (this.onPhase) this.onPhase();
  }

  setParkGuess(n) { const p = this.current(); if (p.charId === "park") p.parkGuess = n; }

  roll() {
    const p = this.current();
    let dice = [this.rollDie()];
    if (p.charId === "weigailan") {
      dice.push(this.rollDie());
      if (dice[0] === dice[1]) {
        this.log(`${p.name} rolled doubles ${dice[0]}·${dice[1]} — inspiration burns out!`);
        const dest = Math.max(p.pos - 1, 0);
        this.emit({ type: "move", name: p.name, from: p.pos, to: dest });
        p.pos = dest;
        this.checkTriggers(p);
        this.phase = "skill";
        if (this.onPhase) this.onPhase();
        this.lastRoll = { dice, total: 0, stall: true };
        return this.lastRoll;
      }
    }
    const ding = this.boardPlayers().find(o => o.charId === "dingyi");
    if (ding && ding !== p && dice.some(v => v === 1 || v === 2)) {
      this.payTo(p, ding, 1, "Ding Yi's attendance check");
    }
    const total = Math.max(...dice);
    if (p.charId === "park" && p.parkGuess != null && dice.includes(p.parkGuess)) {
      this.log(`${p.name} predicted ${p.parkGuess} — correct!`);
      this.setPending({
        kind: "park-win", total, dice,
        options: [
          { id: "boost", label: "Move normally, then +4 IC & +2 tiles" },
          { id: "cash", label: "+6 IC instead (no move)" },
        ],
      });
      this.lastRoll = { dice, total, park: true };
      return this.lastRoll;
    }
    this.phase = "move-prompt";
    this.lastRoll = { dice, total };
    if (this.onPhase) this.onPhase();
    return this.lastRoll;
  }

  parkWinChoice(choice) {
    const p = this.current();
    const total = this.pending.total;
    this.pending = null;
    if (choice === "boost") {
      this.gainCoins(p, 4, "Park's prediction");
      this.afterRollMove(total + 2);
    } else {
      this.gainCoins(p, 6, "Park's prediction");
      this.phase = "skill";
      if (this.onPhase) this.onPhase();
    }
  }

  reroll() {
    const p = this.current();
    if (p.coins < 2) { this.log("Not enough coins to re-roll."); return false; }
    this.loseCoins(p, 2, "Re-roll");
    this.phase = "roll";
    if (this.onPhase) this.onPhase();
    return true;
  }

  afterRollMove(total) {
    const p = this.current();
    const dest = Math.min(p.pos + total, this.endTile());
    this.stepMove(p, dest);
  }

  stepMove(p, dest) {
    const wu = this.boardPlayers().find(o => o.charId === "wupeiyi");
    if (wu && wu !== p) {
      const wuIdx = wu.pos;
      if (wuIdx > p.pos && wuIdx <= dest) {
        this.setPending({
          kind: "wu-toll", target: wu.name, from: p.pos, dest,
          options: [
            { id: "pay", label: `Pay ${wu.name} 1 IC` },
            { id: "stop", label: "Stop one tile behind her" },
          ],
        });
        return;
      }
    }
    this.doStepMove(p, dest);
  }

  doStepMove(p, dest) {
    const from = p.pos;
    p.pos = dest;
    this.emit({ type: "move", name: p.name, from, to: dest });
    this.checkTriggers(p);
    // If a passive bounced the mover, the extra movement never triggers tile effects.
    if (p.pos !== dest) this.landAfterSlide(p);
    else this.resolveLanding(p);
  }

  wuTollChoice(choice) {
    const p = this.current();
    const wu = this.boardPlayers().find(o => o.charId === "wupeiyi");
    const { dest, from } = this.pending;
    this.pending = null;
    if (choice === "pay") {
      this.payTo(p, wu, 1, "Wu Peiyi's toll");
      this.doStepMove(p, dest);
    } else {
      p.pos = Math.max(wu.pos - 1, 0);
      this.emit({ type: "move", name: p.name, from, to: p.pos });
      this.log(`${p.name} stops one tile behind ${wu.name}.`);
      this.checkTriggers(p);
      this.landAfterSlide(p);
    }
  }

  checkTriggers(p) {
    const ice = this.boardPlayers().find(o => o.charId === "iceman" && o !== p && o.pos === p.pos);
    if (ice) {
      const dest = Math.max(p.pos - 2, 0);
      this.emit({ type: "move", name: p.name, from: p.pos, to: dest });
      p.pos = dest;
      this.log(`${p.name} bounced off Iceman's repulsion field.`);
    }
    const kk = this.boardPlayers().find(o => o.charId === "kk" && o !== p);
    if (kk && kk.kkUses < 3 && Math.abs(kk.pos - p.pos) <= 1) {
      kk.kkUses++;
      const kkDest = Math.min(kk.pos + 2, this.endTile());
      this.emit({ type: "move", name: kk.name, from: kk.pos, to: kkDest });
      kk.pos = kkDest;
      this.log(`${kk.name} escapes +2 (${kk.kkUses}/3).`);
      if (this.tileType(kk.pos) === "finish" && !kk.finished) this.finishPlayer(kk);
    }
  }

  resolveLanding(p) {
    const type = this.tileType(p.pos);
    if (type === "finish") { this.finishPlayer(p); this.endTurn(); return; }
    if (type === "blank" || type === "start") {
      this.phase = "skill";
      if (this.onPhase) this.onPhase();
      return;
    }
    if (type === "checkin") {
      this.gainCoins(p, 2, "SCC Check-in");
      this.phase = "skill";
      if (this.onPhase) this.onPhase();
      return;
    }
    if (type === "trap") {
      if (p.heldMercy) {
        p.heldMercy = false;
        this.log("The Professor's Mercy cancels the Trap!");
        this.phase = "skill";
        if (this.onPhase) this.onPhase();
        return;
      }
      if (p.charId === "park" && !p.ultimateUsed) {
        this.setPending({ kind: "park-flip", options: [
          { id: "flip", label: "ULTIMATE · flip the penalty into +2 IC" },
          { id: "normal", label: "Take the trap normally" },
        ]});
        return;
      }
      this.trapChoices(p);
      return;
    }
    if (type === "event") {
      this.drawCard(p);
      return;
    }
    if (type === "fwd" || type === "back") {
      const delta = type === "fwd" ? 3 : -3;
      const dest = Math.min(this.endTile(), Math.max(0, p.pos + delta));
      this.emit({ type: "move", name: p.name, from: p.pos, to: dest });
      p.pos = dest;
      this.log(`${p.name} ${type === "fwd" ? "slides +3" : "stumbles −3"}.`);
      this.checkTriggers(p);
      this.landAfterSlide(p);
      return;
    }
  }

  landAfterSlide(p) {
    if (this.tileType(p.pos) === "finish") { this.finishPlayer(p); this.endTurn(); return; }
    this.phase = "skill";
    if (this.onPhase) this.onPhase();
  }

  trapChoices(p) {
    const opts = [];
    const wangxi = this.boardPlayers().find(o => o.charId === "wangxi" && o !== p && o.coins >= 2);
    if (wangxi) opts.push({ id: "wangxi-help", label: `${wangxi.name} cancels it (she pays 2 IC, advances 3)` });
    if (p.coins >= 3) opts.push({ id: "cancel", label: "Pay 3 IC — ignore the trap" });
    opts.push({ id: "lose", label: "Lose 2 IC" });
    opts.push({ id: "retreat", label: "Retreat 3 tiles" });
    this.setPending({ kind: "trap", options: opts });
  }

  trapChoice(choice) {
    const p = this.current();
    this.pending = null;
    if (choice === "cancel") this.loseCoins(p, 3, "Cancel a penalty tile");
    else if (choice === "lose") this.loseCoins(p, 2, "Deadline Trap");
    else if (choice === "retreat") this.moveBack(p, 3, "Deadline Trap retreat");
    else if (choice === "wangxi-help") {
      const wangxi = this.boardPlayers().find(o => o.charId === "wangxi" && o !== p);
      this.loseCoins(wangxi, 2, "Wang Xi's tutoring");
      this.moveForward(wangxi, 3, "Wang Xi's tutoring");
      this.log(`${wangxi.name} cancelled ${p.name}'s trap.`);
    }
    this.phase = "skill";
    if (this.onPhase) this.onPhase();
  }

  parkFlipChoice(choice) {
    const p = this.current();
    this.pending = null;
    if (choice === "flip") {
      p.ultimateUsed = true;
      this.gainCoins(p, 2, "Park's final interpretation");
    } else {
      this.applyTrapPenalty(p, false);
    }
    this.phase = "skill";
    if (this.onPhase) this.onPhase();
  }

  applyTrapPenalty(p, forced) {
    if (p.heldMercy) { p.heldMercy = false; this.log("The Professor's Mercy cancels the Trap!"); return; }
    this.loseCoins(p, 2, "Deadline Trap");
  }

  moveForward(p, n, src) {
    const dest = Math.min(p.pos + n, this.endTile());
    this.emit({ type: "move", name: p.name, from: p.pos, to: dest });
    p.pos = dest;
    this.log(`${p.name} moves +${n} (${src}).`);
    if (this.tileType(p.pos) === "finish" && !p.finished) this.finishPlayer(p);
    else this.checkTriggers(p);
  }

  moveBack(p, n, src) {
    const dest = Math.max(p.pos - n, 0);
    this.emit({ type: "move", name: p.name, from: p.pos, to: dest });
    p.pos = dest;
    this.log(`${p.name} moves −${n} (${src}).`);
    this.checkTriggers(p);
  }

  drawCard(p) {
    if (!this.deck.length) {
      this.log("The deck is empty.");
      this.phase = "skill";
      if (this.onPhase) this.onPhase();
      return;
    }
    const cardId = this.deck.pop();
    const card = CARDS.find(c => c.id === cardId);
    this.log(`${p.name} draws: ${card.name} (${card.deck} deck).`);
    this.setPending({ kind: "card", card });
  }

  resolveCard(target) {
    const p = this.current();
    const card = this.pending.card;
    this.pending = null;
    if (card.needsTarget && !target) {
      this.log(`${card.name} — no valid targets, the card fizzles.`);
      this.phase = "skill";
      if (this.onPhase) this.onPhase();
      return;
    }
    card.run(this, p, target);
    if (this.current() !== p || p.finished) return;
    this.checkTriggers(p);
    this.phase = "skill";
    if (this.onPhase) this.onPhase();
  }

  startDuel(p, target) {
    const a = this.rollDie(), b = this.rollDie();
    this.log(`${p.name} rolls ${a} · ${target.name} rolls ${b}.`);
    if (a === b) { this.log("Tie — nothing happens."); return; }
    if (a > b) this.payTo(target, p, 1, "Midnight Food Post duel");
    else this.payTo(p, target, 1, "Midnight Food Post duel");
  }

  offerTargetChoice(target) {
    this.setPending({ kind: "hostile-choice", target: target.name, options: [
      { id: "pay", label: "Pay 2 IC to the bank" },
      { id: "back", label: "Back 3 tiles" },
    ]});
  }

  hostileChoice(choice) {
    const t = this.players.find(p => p.name === this.pending.target);
    this.pending = null;
    if (choice === "pay") this.loseCoins(t, 2, "The Hostile Question");
    else this.moveBack(t, 3, "The Hostile Question");
    this.phase = "skill";
    if (this.onPhase) this.onPhase();
  }

  /* ---------------- coins ---------------- */
  gainCoins(p, n, src) {
    p.coins += n;
    this.log(`${p.name} gains ${n} IC (${src}) → ${p.coins} IC.`);
  }

  loseCoins(p, n, src) {
    p.coins -= n;
    this.log(`${p.name} loses ${n} IC (${src}) → ${p.coins} IC.`);
    this.checkBroke(p);
  }

  payTo(from, to, n, src) {
    if (from.coins <= 0) { this.log(`${from.name} is broke — pays nothing.`); this.checkBroke(from); return; }
    const amt = Math.min(from.coins, n);
    from.coins -= amt;
    to.coins += amt;
    this.log(`${from.name} pays ${to.name} ${amt} IC (${src}).`);
    this.checkBroke(from);
  }

  checkBroke(p) {
    if (p.coins <= 0 && !p.finished && !p.warnedThisTurn) {
      p.warnedThisTurn = true;
      p.coins = 0;
      const dest = Math.max(p.pos - 5, 0);
      this.emit({ type: "move", name: p.name, from: p.pos, to: dest });
      p.pos = dest;
      p.pendingWarnBonus = true;
      this.log(`ACADEMIC WARNING — ${p.name} is broke: back 5 tiles, +2 IC next turn.`);
      this.checkTriggers(p);
    }
  }

  /* ---------------- skills ---------------- */
  skillOptions() {
    const p = this.current();
    const opts = [];
    if (p.charId === "zhuang" && !p.ultimateUsed) opts.push({ id: "zhuang-ult", label: "ULTIMATE · Assembly — everyone back 1, −1 IC" });
    if (p.charId === "sansom" && !p.ultimateUsed && p.coins >= 6)
      opts.push({ id: "sansom-ult", label: "ULTIMATE · Swap places (cost 4 IC + 2 IC gift)" });
    if (p.charId === "wangxi" && !p.ultimateUsed)
      opts.push({ id: "wangxi-ult", label: "ULTIMATE · You + one player: +2 IC & +2 tiles" });
    if (p.charId === "iceman" && p.ultUses < 2)
      opts.push({ id: "iceman-ult", label: `ULTIMATE · Move exactly 4 (${2 - p.ultUses} left)` });
    if (p.charId === "kk" && !p.ultimateUsed)
      opts.push({ id: "kk-ult", label: "ULTIMATE · Drag a player behind you +3 together" });
    return opts;
  }

  skillTargets(id) {
    const p = this.current();
    const others = this.boardPlayers().filter(o => o !== p);
    if (id === "sansom-ult") return others.filter(o => o.pos !== this.endTile());
    if (id === "wangxi-ult") return others;
    if (id === "kk-ult") return others.filter(o => o.pos < p.pos);
    return [];
  }

  useSkill(id, target) {
    const p = this.current();
    if (["sansom-ult", "wangxi-ult", "kk-ult"].includes(id) && !target) {
      this.log("No valid target — skill not used.");
      return;
    }
    if (id === "zhuang-ult") {
      p.ultimateUsed = true;
      for (const o of [...this.boardPlayers()]) {
        const dest = Math.max(o.pos - 1, 0);
        this.emit({ type: "move", name: o.name, from: o.pos, to: dest });
        o.pos = dest;
        this.loseCoins(o, 1, "Zhuang's assembly");
      }
      this.log("Zhuang Yiren calls an all-college assembly.");
    } else if (id === "sansom-ult") {
      p.ultimateUsed = true;
      this.loseCoins(p, 4, "Sansom's swap (bank)");
      this.payTo(p, target, 2, "Sansom's swap (gift)");
      const a = p.pos, b = target.pos;
      p.pos = b; target.pos = a;
      this.emit({ type: "swap", a: p.name, b: target.name });
      this.log(`${p.name} swaps places with ${target.name}.`);
      this.checkTriggers(p);
    } else if (id === "wangxi-ult") {
      p.ultimateUsed = true;
      this.gainCoins(p, 2, "Wang Xi's pairing");
      this.gainCoins(target, 2, "Wang Xi's pairing");
      this.moveForward(p, 2, "Wang Xi's pairing");
      this.moveForward(target, 2, "Wang Xi's pairing");
    } else if (id === "iceman-ult") {
      p.ultUses++;
      this.log(`${p.name} embraces AI — moves exactly 4.`);
      this.stepMove(p, Math.min(p.pos + 4, this.endTile()));
      return;
    } else if (id === "kk-ult") {
      p.ultimateUsed = true;
      this.moveForward(p, 3, "KK's publicity");
      this.moveForward(target, 3, "KK's publicity");
    }
  }

  /* ---------------- finishing ---------------- */
  finishPlayer(p) {
    p.finished = true;
    p.finishOrder = this.players.filter(x => x.finished).length;
    const bonus = [5, 3, 1, 0, 0, 0][Math.max(0, p.finishOrder - 1)];
    this.emit({ type: "finish", name: p.name, order: p.finishOrder, bonus });
    if (bonus) this.gainCoins(p, bonus, `Arrival bonus (${ordinal(p.finishOrder)})`);
    else this.log(`${p.name} finishes ${ordinal(p.finishOrder)} — no bonus.`);
    if (this.players.every(x => x.finished)) this.endGame();
  }

  endGame() {
    this.phase = "over";
    let best = null;
    for (const p of this.players) {
      if (!best || p.coins > best.coins ||
          (p.coins === best.coins && p.finishOrder < best.finishOrder)) best = p;
    }
    this.winner = best;
    this.log(`Game over! ${best.name} wins with ${best.coins} IC.`);
    this.emit({ type: "over", winner: best.name });
    if (this.onPhase) this.onPhase();
  }

  endTurn() {
    if (this.phase === "over") return;
    this.currentIdx = (this.currentIdx + 1) % this.players.length;
    this.phase = "turn";
    if (this.players.every(p => p.finished)) { this.endGame(); return; }
    this.beginTurn();
  }

  forceEndTurn(src) {
    this.log(`${src}: the turn ends immediately.`);
    this.endTurn();
  }
}

function ordinal(n) { return n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`; }

if (typeof module !== "undefined" && module.exports) {
  module.exports = { Game, CARDS, CHARACTERS };
}
