// Glide Path rules engine. Pure state + actions; the host owns the state.
// applyAction mutates state and returns an error string, or null on success.

export const ROLES = ['pilot', 'copilot'];
export const ROUNDS = 7; // 6000 ft down to the landing round
export const APPROACH = [0, 0, 1, 2, 1, 2, 0]; // traffic per approach space; last space = runway
export const REROLL_ROUNDS = [1, 5]; // rounds that award a reroll token
export const MAX_FOCUS = 3;
export const MAX_NAME = 16;
export const other = (r) => (r === 'pilot' ? 'copilot' : 'pilot');
export const firstPlayer = (round) => (round % 2 ? 'pilot' : 'copilot');
export const altitude = (round) => (ROUNDS - round) * 1000;

const S = (kind, owner, vals, i = 0) => ({ kind, owner, vals, i });
const series = (kind, owner, list) => Object.fromEntries(list.map((v, i) => [kind + i, S(kind, owner, v, i)]));
export const SLOTS = {
  axisP: S('axis', 'pilot'), axisC: S('axis', 'copilot'),
  engP: S('engine', 'pilot'), engC: S('engine', 'copilot'),
  radioP: S('radio', 'pilot'), radioC0: S('radio', 'copilot'), radioC1: S('radio', 'copilot'),
  ...series('gear', 'pilot', [[1, 2], [3, 4], [5, 6]]),
  ...series('brake', 'pilot', [[2], [4], [6]]),
  ...series('flap', 'copilot', [[1, 2], [2, 3], [4, 5], [5, 6]]),
  ...series('focus', 'both', [null, null, null]),
};

const count = (a) => a.filter(Boolean).length;
export const slowMark = (s) => 4.5 + count(s.gear); // speed below this: hold position
export const fastMark = (s) => 8.5 + count(s.flaps); // speed above this: advance 2
export const brakeVal = (s) => [0, 2, 4, 6][count(s.brakes)];
export const RUNWAY = APPROACH.length - 1;
export const moveFor = (s, speed) => (speed < slowMark(s) ? 0 : speed < fastMark(s) ? 1 : 2);

export const cleanName = (raw) => String(raw || '').replace(/\s+/g, ' ').trim();

export const createGame = (code) => ({ code, players: [], phase: 'lobby', ...flight(), log: [] });

function flight() {
  return {
    round: 1, axis: 0, pos: 0, planes: [...APPROACH],
    gear: [false, false, false], flaps: [false, false, false, false], brakes: [false, false, false],
    focus: 0, rerolls: REROLL_ROUNDS.includes(1) ? 1 : 0,
    dice: { pilot: [], copilot: [] }, slots: {}, turn: 'pilot',
    ready: { pilot: false, copilot: false }, rerollPick: null, speed: null, reason: '',
  };
}

export function addPlayer(state, { name, token, isHost = false }) {
  name = cleanName(name);
  if (!name) return { error: 'Enter a name' };
  if ([...name].length > MAX_NAME) return { error: `Name too long (max ${MAX_NAME})` };
  if (state.players.length >= 2) return { error: 'Room is full' };
  const taken = state.players[0]?.role;
  const player = { id: 'p' + (state.players.length + 1), name, token, isHost, role: taken ? other(taken) : 'pilot', connected: true };
  state.players.push(player);
  return { player };
}

export function removePlayer(state, id) {
  state.players = state.players.filter((p) => p.id !== id);
}

const log = (s, msg) => { s.log.push(msg); if (s.log.length > 60) s.log.shift(); };
const lose = (s, reason) => { s.phase = 'lost'; s.reason = reason; log(s, 'CRASH: ' + reason); };
const NAME = { pilot: 'Pilot', copilot: 'Co-pilot' };

export function canPlace(s, role, value, id) {
  const d = SLOTS[id];
  if (!d || s.slots[id]) return false;
  if (d.owner !== 'both' && d.owner !== role) return false;
  if (d.vals && !d.vals.includes(value)) return false;
  if (d.kind === 'brake' && d.i && !s.brakes[d.i - 1]) return false; // brakes in order
  if (d.kind === 'flap' && d.i && !s.flaps[d.i - 1]) return false; // flaps in order
  return true;
}

export function hasMove(s, role) {
  for (const v0 of s.dice[role])
    for (let adj = -s.focus; adj <= s.focus; adj++)
      for (const id in SLOTS) if (v0 + adj >= 1 && v0 + adj <= 6 && canPlace(s, role, v0 + adj, id)) return true;
  return false;
}

function checkStuck(s) {
  if (s.phase === 'placing' && !s.rerollPick && s.dice[s.turn].length && !hasMove(s, s.turn))
    lose(s, `${NAME[s.turn]} had no legal space for any die.`);
}

function resolve(s, id, v) {
  const d = SLOTS[id];
  const sl = s.slots;
  switch (d.kind) {
    case 'axis':
      if (!(sl.axisP && sl.axisC)) return;
      s.axis += sl.axisC.value - sl.axisP.value;
      log(s, `Axis ${sl.axisP.value} vs ${sl.axisC.value}: tilt is now ${s.axis}.`);
      if (Math.abs(s.axis) >= 3) lose(s, 'The plane rolled too far and went into a spin.');
      return;
    case 'engine': {
      if (!(sl.engP && sl.engC)) return;
      const speed = (s.speed = sl.engP.value + sl.engC.value);
      if (s.round === ROUNDS) return log(s, `Landing speed ${speed} (brakes hold below ${brakeVal(s)}).`);
      const move = moveFor(s, speed);
      for (let i = 0; i < move; i++) if (s.planes[s.pos + i]) return lose(s, 'Mid-air collision: traffic was still in the way.');
      if (s.pos + move > RUNWAY) return lose(s, 'Overshot the runway.');
      s.pos += move;
      return log(s, `Speed ${speed}: advanced ${move} space${move === 1 ? '' : 's'}.`);
    }
    case 'radio': {
      const t = s.pos + v - 1;
      if (s.planes[t]) { s.planes[t]--; log(s, `Radio ${v}: cleared traffic ${v - 1} space${v === 2 ? '' : 's'} ahead.`); }
      else log(s, `Radio ${v}: no traffic there.`);
      return;
    }
    case 'gear': case 'flap': case 'brake': {
      const arr = s[{ gear: 'gear', flap: 'flaps', brake: 'brakes' }[d.kind]];
      if (!arr[d.i]) { arr[d.i] = true; log(s, `${{ gear: 'Landing gear', flap: 'Flaps', brake: 'Brakes' }[d.kind]} ${d.i + 1} engaged.`); }
      return;
    }
    case 'focus':
      s.focus = Math.min(MAX_FOCUS, s.focus + 1);
      return;
  }
}

function endRound(s) {
  const sl = s.slots;
  if (!(sl.axisP && sl.axisC && sl.engP && sl.engC)) return lose(s, 'Axis and Throttle must both be filled every round.');
  if (s.round === ROUNDS) {
    const fails = [];
    if (s.pos !== RUNWAY) fails.push('not over the runway');
    if (!s.gear.every(Boolean)) fails.push('landing gear not fully down');
    if (!s.flaps.every(Boolean)) fails.push('flaps not fully extended');
    if (s.axis) fails.push('wings not level');
    if (!(s.speed < brakeVal(s))) fails.push(`speed ${s.speed} not below brakes ${brakeVal(s)}`);
    if (fails.length) return lose(s, 'Rough landing: ' + fails.join(', ') + '.');
    s.phase = 'won';
    s.reason = 'Smooth touchdown. Welcome home!';
    return log(s, 'LANDED: ' + s.reason);
  }
  if (s.round === ROUNDS - 1 && s.pos !== RUNWAY) return lose(s, 'Reached the final altitude without being over the runway.');
  s.round++;
  s.slots = {};
  s.speed = null;
  s.phase = 'strategy';
  s.ready = { pilot: false, copilot: false };
  if (REROLL_ROUNDS.includes(s.round)) { s.rerolls++; log(s, 'Gained a reroll token.'); }
  log(s, `Round ${s.round}: ${altitude(s.round)} ft.`);
}

// action: { kind, die?, slot?, adj?, idx? }
export function applyAction(state, playerId, a, rng = Math.random) {
  const s = state;
  const p = s.players.find((q) => q.id === playerId);
  if (!p || !a) return 'Not in this game';
  const role = p.role;
  const roll = () => 1 + Math.floor(rng() * 6);

  if (a.kind === 'swap') {
    if (s.phase !== 'lobby' || !p.isHost) return 'Only the host can swap seats in the lobby';
    s.players.forEach((q) => { q.role = other(q.role); });
    return null;
  }
  if (a.kind === 'start' || a.kind === 'restart') {
    if (!p.isHost) return 'Only the host can start';
    if (s.players.length < 2) return 'Waiting for your co-pilot';
    if (a.kind === 'start' && s.phase !== 'lobby') return 'Already started';
    Object.assign(s, flight(), { phase: 'strategy', log: [`Round 1: ${altitude(1)} ft. Talk strategy, then both press Roll.`] });
    return null;
  }
  if (s.phase === 'won' || s.phase === 'lost' || s.phase === 'lobby') return 'Not now';

  if (a.kind === 'ready') {
    if (s.phase !== 'strategy') return 'Dice already rolled';
    s.ready[role] = true;
    if (s.ready.pilot && s.ready.copilot) {
      for (const r of ROLES) s.dice[r] = [roll(), roll(), roll(), roll()].sort((x, y) => x - y);
      s.phase = 'placing';
      s.turn = firstPlayer(s.round);
      log(s, `Dice rolled. Silence on the flight deck! ${NAME[s.turn]} places first.`);
      checkStuck(s);
    }
    return null;
  }
  if (s.phase !== 'placing') return 'Not now';

  if (a.kind === 'reroll') {
    if (s.turn !== role) return 'Not your turn';
    if (s.rerolls < 1) return 'No reroll tokens';
    if (s.rerollPick) return 'Reroll already in progress';
    s.rerolls--;
    s.rerollPick = { pilot: null, copilot: null };
    log(s, `${NAME[role]} used a reroll token. Both crew choose dice to reroll.`);
    return null;
  }
  if (a.kind === 'rerollPick') {
    if (!s.rerollPick) return 'No reroll in progress';
    if (s.rerollPick[role]) return 'Already chosen';
    const n = s.dice[role].length;
    s.rerollPick[role] = [...new Set((Array.isArray(a.idx) ? a.idx : []).filter((i) => Number.isInteger(i) && i >= 0 && i < n))];
    if (s.rerollPick.pilot && s.rerollPick.copilot) {
      for (const r of ROLES) { for (const i of s.rerollPick[r]) s.dice[r][i] = roll(); s.dice[r].sort((x, y) => x - y); }
      s.rerollPick = null;
      log(s, 'Dice rerolled.');
      checkStuck(s);
    }
    return null;
  }
  if (a.kind === 'place') {
    if (s.rerollPick) return 'Waiting for the reroll';
    if (s.turn !== role) return 'Not your turn';
    const v0 = s.dice[role][a.die];
    if (v0 == null) return 'No such die';
    const adj = Number.isInteger(a.adj) ? a.adj : 0;
    const v = v0 + adj;
    if (Math.abs(adj) > s.focus || v < 1 || v > 6) return 'Not enough focus for that change';
    if (!canPlace(s, role, v, a.slot)) return 'That die cannot go there';
    s.focus -= Math.abs(adj);
    s.dice[role].splice(a.die, 1);
    s.slots[a.slot] = { role, value: v };
    resolve(s, a.slot, v);
    if (s.phase !== 'placing') return null;
    if (!s.dice.pilot.length && !s.dice.copilot.length) return endRound(s), null;
    if (s.dice[other(role)].length) s.turn = other(role);
    checkStuck(s);
    return null;
  }
  return 'Unknown action';
}

// What one player may see: partner's dice values stay hidden until placed.
export function viewFor(state, id) {
  const v = structuredClone(state);
  const me = v.players.find((p) => p.id === id);
  v.players.forEach((p) => { delete p.token; });
  const hide = me ? other(me.role) : null;
  if (hide && !['won', 'lost'].includes(v.phase)) v.dice[hide] = v.dice[hide].map(() => 0);
  if (v.rerollPick) v.rerollPick = { pilot: !!v.rerollPick.pilot, copilot: !!v.rerollPick.copilot };
  v.you = me ? { id: me.id, role: me.role, isHost: me.isHost } : null;
  return v;
}
