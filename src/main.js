import './style.css';
import { inject } from '@vercel/analytics';
import {
  createGame, addPlayer, viewFor, cleanName, canPlace, moveFor, other, altitude, firstPlayer,
  SLOTS, ROUNDS, RUNWAY, MAX_NAME, MAX_FOCUS, slowMark, fastMark, brakeVal,
} from './game.js';
import { hostRoom, joinClient, genCode, normCode, validCode, BUILD } from './net.js';

inject();

/* ------------------------------ helpers ------------------------------ */

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* no storage: still works */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  json(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
};
const uuid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));
const getToken = () => {
  let t = store.get('gp-token');
  if (!t) { t = uuid(); store.set('gp-token', t); }
  return t;
};

// DOM builder. Strings become text nodes, so player-supplied text is never parsed as HTML.
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') for (const [a, b] of Object.entries(v)) e.style.setProperty(a, b);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return e;
}
const $ = (sel) => document.querySelector(sel);

function toast(msg) {
  const t = h('div', { class: 'toast' }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), 3200);
}

const NAME = { pilot: 'Pilot', copilot: 'Co-pilot' };
const PIP = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
const pips = (n) => (n ? [...Array(9).keys()].map((i) => h('i', { class: PIP[n].includes(i) ? 'p' : '' })) : h('b', {}, '?'));

/* ------------------------------ app state ------------------------------ */

const S = {
  mode: 'home', // home | connecting | error | game
  view: null, host: null, state: null, client: null,
  lostHost: false, stale: false, tmp: null, errMsg: '',
  sel: null, adj: 0, pick: new Set(), // selected die, focus adjustment, reroll picks
  tutorial: false, // personal toggle, off on every load
  info: null, // tutorial: system the player tapped for an explanation
  sheet: null, // null | 'menu' | 'rules'
  overHidden: false,
  lastV: null, fly: null, // animation bookkeeping
};

function doAct(action) {
  if (S.host) {
    const e = S.host.act(action);
    if (e) toast(e);
  } else if (S.client && !S.client.send(action)) toast('Reconnecting to host...');
}

const shareUrl = (code) => `${location.origin}/?room=${code}`;
async function share(code) {
  const url = shareUrl(code);
  try {
    if (navigator.share) { await navigator.share({ title: 'Glide Path', text: `Fly with me: ${code}`, url }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { toast(url); }
}

let wake = null;
async function keepAwake() {
  try {
    if (!navigator.wakeLock || wake || document.visibilityState !== 'visible') return;
    wake = await navigator.wakeLock.request('screen');
    wake.addEventListener('release', () => { wake = null; });
  } catch { /* not allowed: fine */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !(S.host || S.client)) return;
  keepAwake();
  S.client?.rehello();
});

/* ------------------------------ session ------------------------------ */

function resetLocal() {
  S.host?.leave();
  S.client?.leave();
  Object.assign(S, { host: null, client: null, state: null, view: null, lostHost: false, tmp: null, sel: null, adj: 0, lastV: null, sheet: null });
  try { wake?.release(); } catch { /* ignore */ }
  wake = null;
}

function goHome(msg) {
  const session = store.json('gp-session');
  if (session?.host) store.del('gp-host-' + session.room);
  store.del('gp-session');
  resetLocal();
  try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
  S.mode = 'home';
  render();
  if (msg) toast(msg);
}

function setUrl(code) { try { history.replaceState(null, '', '?room=' + code); } catch { /* ignore */ } }

function onHostChange(state) {
  store.set('gp-host-' + state.code, JSON.stringify(state));
  S.view = viewFor(state, state.players.find((p) => p.isHost).id);
  S.mode = 'game';
  render();
}

function startHost(state, session) {
  S.state = state;
  S.host = hostRoom(state, onHostChange);
  store.set('gp-session', JSON.stringify({ ...session, host: true }));
  setUrl(state.code);
  keepAwake();
  S.host.changed();
}

function createRoom(rawName) {
  const name = cleanName(rawName);
  const state = createGame(genCode());
  const r = addPlayer(state, { name, token: getToken(), isHost: true });
  if (r.error) return toast(r.error);
  store.set('gp-name', name);
  resetLocal();
  startHost(state, { room: state.code, name });
}

function joinRoomAs(code, rawName) {
  const name = cleanName(rawName);
  if (!name) return toast('Enter a name');
  if ([...name].length > MAX_NAME) return toast(`Name too long (max ${MAX_NAME})`);
  if (!validCode(code)) return toast('Enter the 4-character room code');
  store.set('gp-name', name);
  resetLocal();
  S.mode = 'connecting';
  S.tmp = { code };
  setUrl(code);
  keepAwake();
  S.client = joinClient(code, { name, token: getToken() }, {
    onView(v) {
      if (!S.client) return;
      store.set('gp-session', JSON.stringify({ room: code, name }));
      S.mode = 'game';
      S.lostHost = false;
      S.stale = v.build !== BUILD;
      S.view = v;
      render();
    },
    onErr(msg) {
      if (msg === 'Not in this game') return S.client?.rehello();
      if (S.mode !== 'game') return goHome(msg);
      toast(msg);
    },
    onTimeout() { S.mode = 'error'; S.errMsg = 'Room not found or host offline'; render(); },
    onHostLost() { S.lostHost = true; render(); },
  });
  render();
}

/* ------------------------------ screens ------------------------------ */

function home() {
  const params = new URLSearchParams(location.search);
  const name = h('input', { class: 'input', placeholder: 'Your name', maxlength: 32, autocomplete: 'off', 'aria-label': 'Your name', value: store.get('gp-name') || '' });
  const code = h('input', { class: 'input code', placeholder: 'CODE', maxlength: 4, autocomplete: 'off', autocapitalize: 'characters', 'aria-label': 'Room code', value: normCode(params.get('room')) });
  return h('section', { class: 'home' },
    h('div', { class: 'hero' },
      h('div', { class: 'hero-sky' }, h('span', { class: 'hero-plane' }, '✈'), h('i', { class: 'hero-rwy' })),
      h('h1', {}, 'Glide Path'),
      h('p', { class: 'muted' }, 'Two seats. Secret dice. No talking. One runway.')),
    h('div', { class: 'card' },
      name,
      h('button', { class: 'btn primary big', onclick: () => createRoom(name.value) }, 'Create flight'),
      h('div', { class: 'or' }, 'or join with a code'),
      h('div', { class: 'row' }, code, h('button', { class: 'btn big', onclick: () => joinRoomAs(normCode(code.value), name.value) }, 'Join'))),
    h('button', { class: 'btn ghost', onclick: () => { S.sheet = 'rules'; render(); } }, 'How to fly'));
}

const connecting = () => h('section', { class: 'card center mid' }, h('div', { class: 'radar' }), h('p', {}, `Contacting the tower for room ${S.tmp?.code}...`));
const errorScreen = () => h('section', { class: 'card center mid' }, h('p', {}, S.errMsg), h('button', { class: 'btn', onclick: () => goHome() }, 'Back'));

function tutorToggle() {
  return h('button', {
    class: 'btn sm tutor ' + (S.tutorial ? 'on' : ''), 'aria-pressed': String(S.tutorial),
    onclick: () => { S.tutorial = !S.tutorial; S.info = null; render(); },
  }, S.tutorial ? 'Tutor on' : 'Tutor off');
}
const menuBtn = () => h('button', { class: 'btn sm icon', 'aria-label': 'Menu', onclick: () => { S.sheet = 'menu'; render(); } }, '☰');

function lobby(v) {
  const me = v.you;
  const seat = (role) => {
    const p = v.players.find((q) => q.role === role);
    return h('div', { class: `seat ${role} ${p ? 'taken' : ''}` },
      h('span', { class: 'seat-ico' }, role === 'pilot' ? 'P' : 'C'),
      h('span', { class: 'seat-role' }, NAME[role]),
      h('b', {}, p ? p.name + (p.id === me.id ? ' (you)' : '') : 'Waiting...'));
  };
  return h('section', { class: 'lobby' },
    h('div', { class: 'topbar' }, h('span', { class: 'brand' }, '✈ Pre-flight'), h('span', { class: 'grow' }), tutorToggle(), menuBtn()),
    h('div', { class: 'card' },
      h('div', { class: 'roomcode' }, h('span', { class: 'muted' }, 'Room'), h('b', {}, v.code)),
      h('button', { class: 'btn', onclick: () => share(v.code) }, 'Share invite link'),
      h('div', { class: 'seats' }, seat('pilot'), seat('copilot')),
      me.isHost
        ? h('div', { class: 'row' },
          h('button', { class: 'btn ghost', onclick: () => doAct({ kind: 'swap' }) }, 'Swap seats'),
          h('button', { class: 'btn primary grow', disabled: v.players.length < 2, onclick: () => doAct({ kind: 'start' }) }, v.players.length < 2 ? 'Waiting for co-pilot' : 'Start flight'))
        : h('p', { class: 'muted center' }, 'Waiting for the host to start.')),
    S.tutorial && h('div', { class: 'card instructor' }, h('h3', {}, 'Flight instructor'),
      h('p', {}, 'Glide Path is fully cooperative: you win or crash together. Before each roll you can plan out loud. Once the dice are rolled, say nothing about them; your placements are your only signals.'),
      h('p', {}, 'Open "How to fly" from the ☰ menu any time for the full rules.')));
}

/* ---- flight board ---- */

const myDice = (v) => v.dice[v.you.role];
const selValue = (v) => (S.sel == null ? null : myDice(v)[S.sel] + S.adj);
const myTurn = (v) => v.phase === 'placing' && v.turn === v.you.role && !v.rerollPick;
const deg = (axis) => axis * 11 + 'deg';
const markPct = (m) => ((m - 1.5) / 11) * 100; // position of a between-numbers mark on the 2..12 scale

function approach(v, fx) {
  const n = v.planes.length;
  return h('div', { class: 'approach' },
    h('div', { class: 'sys-head' }, h('span', {}, 'Approach'), h('span', { class: 'muted' }, v.pos === RUNWAY ? 'over the runway' : `${RUNWAY - v.pos} to runway`)),
    h('div', { class: 'track', style: { '--n': n } },
      v.planes.map((k, i) => h('div', { class: `cell ${i < v.pos ? 'past' : ''} ${i === RUNWAY ? 'rwy' : ''}` },
        h('span', { class: 'ck' }, i >= v.pos && i - v.pos < 6 ? 'R' + (i - v.pos + 1) : ''),
        h('span', { class: 'traffic' },
          Array.from({ length: k }, () => h('i', { class: 'tf' }, '✈')),
          fx.cleared?.includes(i) && h('i', { class: 'tf poof' }, '✈')))),
      h('div', { class: 'ship', style: { '--pos': v.pos } }, h('span', {}, '✈'))));
}

function speedGauge(v) {
  const sm = slowMark(v), fm = fastMark(v), b = brakeVal(v);
  const final = v.round === ROUNDS;
  return h('div', { class: 'speedo' + (final ? ' final' : '') },
    h('div', { class: 'sys-head' }, h('span', {}, 'Speed'),
      h('span', { class: 'muted' }, final ? `land below ${b || '—'}` : `hold ≤${sm - 0.5} · +2 ≥${fm + 0.5}`)),
    h('div', { class: 'scale' },
      [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => h('span', { class: `sp ${n < sm ? 'z0' : n < fm ? 'z1' : 'z2'} ${n === v.speed ? 'on' : ''}` }, n)),
      h('i', { class: 'pin slow', style: { left: markPct(sm) + '%' } }),
      h('i', { class: 'pin fast', style: { left: markPct(fm) + '%' } }),
      b > 0 && h('i', { class: 'pin brake', style: { left: markPct(b - 0.5) + '%' } })));
}

const SLOT_INFO = {
  axis: ['Axis', 'Both seats must place one die here every round, any value. When both are in, the wings tip toward the higher die by the difference. Reach 3 either way and the plane spins out. You must land level.'],
  engine: ['Throttle', 'Both seats must place one die here every round, any value. The two dice are added: below the hold mark you stay put, between the marks you advance 1, above the +2 mark you advance 2. On the final round throttle no longer moves you; it is your landing speed.'],
  radio: ['Radio', 'A die of value N clears one plane N−1 spaces ahead (R1 = your current space). Throttle cannot move you through a space that still has traffic.'],
  gear: ['Gear', 'Pilot only, 1–2, 3–4, 5–6, any order. Each one pushes the hold mark up by 1 (you need more throttle to keep moving). All 3 must be down to land.'],
  brake: ['Brakes', 'Pilot only, exactly 2, then 4, then 6, in that order. On the final round your total speed must be lower than the highest brake engaged.'],
  flap: ['Flaps', 'Co-pilot only, top to bottom: 1–2, 2–3, 4–5, 5–6. Each one pushes the +2 mark up by 1. All 4 must be out to land.'],
  focus: ['Focus', 'Any die, either seat. Earns a shared focus token (max 3). When placing a die you may spend tokens to change its value by 1 each, without wrapping 6 to 1.'],
};

function slot(v, id, fx) {
  const d = SLOTS[id];
  const placed = v.slots[id];
  const val = selValue(v);
  const ok = myTurn(v) && val != null && canPlace(v, v.you.role, val, id);
  const engaged = { gear: v.gear, flap: v.flaps, brake: v.brakes }[d.kind]?.[d.i];
  const req = d.vals ? d.vals.join(d.kind === 'brake' ? '' : '·') : '';
  const fresh = fx.newSlots?.includes(id) && S.fly?.slot !== id;
  return h('button', {
    class: `slot ${d.kind} ${ok ? 'ok' : ''} ${engaged ? 'engaged' : ''} ${fx.engaged?.includes(id) ? 'flip' : ''}`,
    'data-slot': id,
    disabled: !ok,
    'aria-label': `${SLOT_INFO[d.kind][0]} ${req}`,
    onclick: () => {
      const r = $('.tray .die.sel')?.getBoundingClientRect();
      S.fly = r ? { slot: id, rect: r } : null;
      doAct({ kind: 'place', die: S.sel, slot: id, adj: S.adj });
      S.sel = null; S.adj = 0;
      render();
    },
  },
  placed ? h('span', { class: `die sm ${placed.role} ${fresh ? 'pop' : ''}` }, pips(placed.value)) : h('span', { class: 'req' }, req),
  d.kind !== 'focus' && d.kind !== 'axis' && d.kind !== 'engine' && d.kind !== 'radio' && h('span', { class: 'led' }));
}

function sysTitle(kind, extra) {
  return h('div', {
    class: 'g-title' + (S.tutorial ? ' tappable' : '') + (S.info === kind ? ' active' : ''),
    onclick: S.tutorial ? () => { S.info = S.info === kind ? null : kind; render(); } : null,
  }, SLOT_INFO[kind][0], extra, S.tutorial && h('span', { class: 'q' }, '?'));
}
const group = (v, fx, kind, ids, cls = '') =>
  h('div', { class: `sys ${kind} ${cls}` }, sysTitle(kind), h('div', { class: 'g-slots' }, ids.map((id) => slot(v, id, fx))));

function cockpit(v, fx) {
  const engDone = v.slots.engP && v.slots.engC;
  return h('div', { class: 'cockpit' },
    h('div', { class: 'col pilot' },
      h('div', { class: 'col-tag' }, 'Pilot'),
      group(v, fx, 'radio', ['radioP']),
      group(v, fx, 'gear', ['gear0', 'gear1', 'gear2'], 'stack'),
      group(v, fx, 'brake', ['brake0', 'brake1', 'brake2'], 'stack')),
    h('div', { class: 'col center' },
      h('div', { class: 'sys axis' }, sysTitle('axis'),
        h('div', { class: 'pair' }, slot(v, 'axisP', fx),
          h('div', { class: 'horizon' + (Math.abs(v.axis) === 2 ? ' warn' : '') },
            h('div', { class: 'ground', style: { transform: `rotate(${deg(v.axis)})` } }),
            h('span', { class: 'wings' }, '—●—'),
            h('span', { class: 'tiltnum' }, v.axis ? `${Math.abs(v.axis)}${v.axis < 0 ? 'P' : 'C'}` : '0')),
          slot(v, 'axisC', fx))),
      h('div', { class: 'sys engine' }, sysTitle('engine'),
        h('div', { class: 'pair' }, slot(v, 'engP', fx),
          h('div', { class: `readout ${engDone && fx.newSlots?.some((s) => s.startsWith('eng')) ? 'pulse' : ''}` },
            h('b', {}, v.speed ?? '–'), h('span', {}, v.round === ROUNDS ? 'landing' : v.speed != null ? `+${moveFor(v, v.speed)}` : 'speed')),
          slot(v, 'engC', fx))),
      h('div', { class: 'sys focus' }, sysTitle('focus'),
        h('div', { class: 'g-slots' }, ['focus0', 'focus1', 'focus2'].map((id) => slot(v, id, fx))),
        h('div', { class: 'tokens' },
          h('span', { class: 'tok-row', title: 'Focus tokens' }, Array.from({ length: MAX_FOCUS }, (_, i) => h('i', { class: 'tok' + (i < v.focus ? ' on' : '') }))),
          h('span', { class: 'rr' + (v.rerolls ? ' on' : '') }, `↻ ${v.rerolls}`)))),
    h('div', { class: 'col copilot' },
      h('div', { class: 'col-tag' }, 'Co-pilot'),
      group(v, fx, 'radio', ['radioC0', 'radioC1']),
      group(v, fx, 'flap', ['flap0', 'flap1', 'flap2', 'flap3'], 'stack')));
}

function tray(v, fx) {
  const role = v.you.role;
  const dice = myDice(v);
  const partner = v.dice[other(role)];
  const picking = v.rerollPick && !v.rerollPick[role];
  if (S.sel != null && (S.sel >= dice.length || !myTurn(v))) { S.sel = null; S.adj = 0; }
  const val = selValue(v);
  const status = v.phase === 'strategy'
    ? (v.ready[role] ? `Waiting for ${NAME[other(role)]}...` : 'Plan together, then roll.')
    : picking ? 'Tap dice to reroll, then confirm.'
      : v.rerollPick ? 'Partner is choosing rerolls...'
        : myTurn(v) ? (S.sel == null ? 'Your move: pick a die.' : 'Now tap a glowing space.')
          : `${NAME[v.turn]} is placing. Stay silent.`;
  return h('div', { class: `tray ${role} ${myTurn(v) ? 'live' : ''}` },
    h('div', { class: 'tray-status' }, h('span', {}, status),
      h('span', { class: 'partner' }, NAME[other(role)][0], partner.map(() => h('i', { class: 'mini ' + other(role) + (fx.rolled ? ' roll' : '') })))),
    v.phase === 'strategy'
      ? h('div', { class: 'tray-dice' }, v.ready[role]
        ? h('div', { class: 'waiting' }, [0, 1, 2, 3].map(() => h('span', { class: `die big ${role} ghost` }, pips(0))))
        : h('button', { class: 'btn primary big roll-btn', onclick: () => { navigator.vibrate?.(15); doAct({ kind: 'ready' }); } }, '⚄ Roll dice'))
      : h('div', { class: 'tray-dice' }, dice.map((d, i) => h('button', {
        class: `die big ${role} ${S.sel === i ? 'sel' : ''} ${picking && S.pick.has(i) ? 'pick' : ''} ${fx.rolled ? 'roll' : ''}`,
        style: { '--i': i },
        disabled: !(myTurn(v) || picking),
        'aria-label': `Die ${d}`,
        onclick: () => {
          if (picking) S.pick.has(i) ? S.pick.delete(i) : S.pick.add(i);
          else { S.sel = S.sel === i ? null : i; S.adj = 0; }
          render();
        },
      }, pips(S.sel === i ? val : d)))),
    (myTurn(v) && S.sel != null && v.focus > 0) || picking || (myTurn(v) && v.rerolls > 0)
      ? h('div', { class: 'tray-actions' },
        myTurn(v) && S.sel != null && v.focus > 0 && h('div', { class: 'adjuster' },
          h('button', { class: 'btn sm', disabled: val <= 1 || Math.abs(S.adj - 1) > v.focus, onclick: () => { S.adj--; render(); } }, '−'),
          h('span', {}, `focus ${S.adj > 0 ? '+' : ''}${S.adj}`),
          h('button', { class: 'btn sm', disabled: val >= 6 || Math.abs(S.adj + 1) > v.focus, onclick: () => { S.adj++; render(); } }, '+')),
        picking && h('button', { class: 'btn primary', onclick: () => { doAct({ kind: 'rerollPick', idx: [...S.pick] }); S.pick = new Set(); } }, `Reroll ${S.pick.size}`),
        myTurn(v) && v.rerolls > 0 && S.sel == null && h('button', { class: 'btn ghost sm', onclick: () => doAct({ kind: 'reroll' }) }, '↻ Use reroll'))
      : null);
}

function hint(v) {
  const role = v.you.role;
  const lines = [];
  if (S.info) lines.push(h('p', { class: 'info' }, h('b', {}, SLOT_INFO[S.info][0] + ': '), SLOT_INFO[S.info][1]));
  if (v.phase === 'strategy') {
    lines.push(`Strategy: talk freely now. Once you roll, no talking about dice. ${NAME[firstPlayer(v.round)]} places first this round.`);
    if (v.round === ROUNDS) lines.push('Landing round: level the wings, finish gear and flaps, and keep speed below the brakes.');
    else if (v.round === ROUNDS - 1 && v.pos < RUNWAY) lines.push(`You must reach the runway this round (${RUNWAY - v.pos} to go).`);
  } else if (v.phase === 'placing') {
    if (v.rerollPick) lines.push('Reroll: choose any of your unplaced dice to reroll (or none) and confirm.');
    else if (v.turn !== role) lines.push(`${NAME[v.turn]} is placing. Read their choice: it is your only signal.`);
    else if (S.sel == null) lines.push('Tap one of your dice, then a glowing space. You must place each turn.');
    else {
      const val = selValue(v);
      const mine = role === 'pilot' ? 'engP' : 'engC', theirs = role === 'pilot' ? 'engC' : 'engP';
      if (!v.slots[mine] && v.slots[theirs] && v.round < ROUNDS) {
        const sp = val + v.slots[theirs].value, mv = moveFor(v, sp);
        const blocked = [...Array(mv).keys()].some((i) => v.planes[v.pos + i]);
        lines.push(`Throttle: speed ${sp} → advance ${mv}${blocked ? '. COLLISION: traffic in the way!' : v.pos + mv > RUNWAY ? '. OVERSHOOT!' : '.'}`);
      }
      if (!v.slots[mine] && v.slots[theirs] && v.round === ROUNDS) {
        const sp = val + v.slots[theirs].value;
        lines.push(`Throttle: landing speed ${sp}, brakes ${brakeVal(v)}${sp < brakeVal(v) ? ' ✓' : ' ✗ too fast'}.`);
      }
      const ax = role === 'pilot' ? 'axisP' : 'axisC', axO = role === 'pilot' ? 'axisC' : 'axisP';
      if (!v.slots[ax] && v.slots[axO]) {
        const t = v.axis + (role === 'pilot' ? v.slots.axisC.value - val : val - v.slots.axisP.value);
        lines.push(`Axis: tilt becomes ${Math.abs(t)}${t ? (t < 0 ? ' toward Pilot' : ' toward Co-pilot') : ' (level)'}${Math.abs(t) >= 3 ? '. SPIN!' : '.'}`);
      }
      lines.push(`Radio: ${v.planes[v.pos + val - 1] ? 'clears a plane on R' + val : 'nothing on R' + val}.`);
    }
    const left = ['axisP', 'axisC', 'engP', 'engC'].filter((id) => !v.slots[id] && SLOTS[id].owner === role);
    if (v.turn === role && left.length && myDice(v).length <= left.length) lines.push('Careful: your remaining dice are needed for Axis/Throttle.');
    if (v.planes[v.pos] && !(v.slots.engP && v.slots.engC)) lines.push('Traffic on your current space: clear it with Radio 1 or keep speed in the hold zone.');
  }
  return h('div', { class: 'instructor' }, h('span', { class: 'ins-ico' }, '\u{1F393}'), h('div', {}, lines.map((l) => (l instanceof Node ? l : h('p', {}, l)))));
}

function rulesList() {
  return h('ol', { class: 'rules' },
    h('li', {}, h('b', {}, 'Goal. '), `Work together to land. After ${ROUNDS} rounds (6000 ft to the ground) you need: plane over the runway, 3 gear down, 4 flaps out, wings level, speed below the brakes.`),
    h('li', {}, h('b', {}, 'Each round. '), 'Plan out loud, then both roll 4 dice in secret. From now on: no talking about dice. Place one die at a time, alternating. The starting seat alternates every round.'),
    h('li', {}, h('b', {}, 'Mandatory. '), 'Every round each seat puts one die on Axis and one on Throttle. If either is empty when all 8 dice are down, you crash.'),
    h('li', {}, h('b', {}, 'Axis. '), 'Higher die tips the wings toward its seat by the difference. 3 either way = spin.'),
    h('li', {}, h('b', {}, 'Throttle. '), 'Sum both dice. Below the hold mark: stay. Between marks: advance 1. Above the +2 mark: advance 2. You may not move into or through a space with traffic, nor past the runway.'),
    h('li', {}, h('b', {}, 'Radio. '), 'Value N clears one plane on space RN (R1 = where you are). Pilot 1 radio, Co-pilot 2.'),
    h('li', {}, h('b', {}, 'Gear (Pilot). '), '1·2, 3·4, 5·6, any order. Each raises the hold mark by 1.'),
    h('li', {}, h('b', {}, 'Flaps (Co-pilot). '), '1·2, 2·3, 4·5, 5·6, top to bottom. Each raises the +2 mark by 1.'),
    h('li', {}, h('b', {}, 'Brakes (Pilot). '), 'Exactly 2, then 4, then 6. Landing speed must be lower than the highest brake.'),
    h('li', {}, h('b', {}, 'Focus. '), 'Any die earns a token (max 3, shared). Spend tokens to shift a die by 1 each as you place it.'),
    h('li', {}, h('b', {}, 'Rerolls. '), 'Tokens arrive in rounds 1 and 5. On your turn spend one: both seats may reroll any unplaced dice.'),
    h('li', {}, h('b', {}, 'Timing. '), 'Be over the runway by the end of round 6; round 7 is touchdown. A seat that cannot legally place a die crashes the flight.'));
}

function sheet(v) {
  if (!S.sheet) return null;
  const close = () => { S.sheet = null; render(); };
  const body = S.sheet === 'rules'
    ? [h('h2', {}, 'How to fly'), rulesList()]
    : [
      h('h2', {}, 'Flight menu'),
      v && h('div', { class: 'roomcode' }, h('span', { class: 'muted' }, 'Room'), h('b', {}, v.code),
        h('button', { class: 'btn sm', onclick: () => share(v.code) }, 'Share')),
      h('button', { class: 'btn', onclick: () => { S.sheet = 'rules'; render(); } }, 'How to fly (rules)'),
      v?.log?.length && h('details', { class: 'log' }, h('summary', {}, 'Flight log'), h('ul', {}, v.log.slice().reverse().map((l) => h('li', {}, l)))),
      v?.you?.isHost && v.phase !== 'lobby' && h('button', { class: 'btn ghost', onclick: () => confirm('Restart the flight from 6000 ft?') && (doAct({ kind: 'restart' }), close()) }, 'Restart flight'),
      h('button', { class: 'btn danger', onclick: () => confirm(S.host ? 'Leave? The flight ends for both of you.' : 'Leave this flight?') && goHome() }, 'Leave'),
    ];
  return h('div', { class: 'sheet-wrap' },
    h('div', { class: 'scrim', onclick: close }),
    h('div', { class: 'sheet' }, h('div', { class: 'grab' }), h('button', { class: 'btn sm icon close', onclick: close, 'aria-label': 'Close' }, '✕'), body));
}

function overModal(v) {
  if (!['won', 'lost'].includes(v.phase) || S.overHidden) return null;
  const won = v.phase === 'won';
  return h('div', { class: 'over-wrap' },
    h('div', { class: `over ${won ? 'won' : 'lost'}` },
      h('div', { class: 'over-art' }, won
        ? [h('i', { class: 'land-rwy' }), h('span', { class: 'land-plane' }, '✈')]
        : h('span', { class: 'crash' }, '\u{1F4A5}')),
      h('h2', {}, won ? 'Touchdown!' : 'Flight lost'),
      h('p', {}, v.reason),
      h('div', { class: 'row' },
        h('button', { class: 'btn ghost', onclick: () => { S.overHidden = true; render(); } }, 'See board'),
        v.you.isHost ? h('button', { class: 'btn primary', onclick: () => doAct({ kind: 'restart' }) }, 'Fly again') : h('span', { class: 'muted' }, 'Host can restart'))));
}

function flight(v, fx) {
  const turn = v.phase === 'placing' && !v.rerollPick ? (v.turn === v.you.role ? 'Your turn' : `${NAME[v.turn]}`) : v.phase === 'strategy' ? 'Plan' : v.phase === 'won' ? 'Landed' : v.phase === 'lost' ? 'Crashed' : 'Reroll';
  return h('section', { class: 'flight seat-' + v.you.role },
    h('div', { class: 'topbar' },
      h('div', { class: 'alt' }, h('b', {}, altitude(v.round)), h('span', {}, `ft · R${v.round}/${ROUNDS}`)),
      h('span', { class: `pill ${turn === 'Your turn' ? 'mine' : ''} ${fx.myTurn ? 'pulse' : ''}`, onclick: () => { if (S.overHidden) { S.overHidden = false; render(); } } }, turn),
      h('span', { class: 'grow' }),
      v.players.some((p) => !p.connected) && h('span', { class: 'off' }, 'partner offline'),
      tutorToggle(), menuBtn()),
    approach(v, fx),
    speedGauge(v),
    cockpit(v, fx),
    S.tutorial && hint(v),
    tray(v, fx),
    overModal(v));
}

/* ------------------------------ animation ------------------------------ */

// Compare the previous view with the new one to decide which animations to play.
function diff(p, v) {
  if (!p || !v || p.phase === 'lobby' || v.phase === 'lobby' || v.round < p.round) return {};
  const fx = {
    rolled: (p.phase === 'strategy' && v.phase === 'placing') || (!!p.rerollPick && !v.rerollPick),
    newSlots: Object.keys(v.slots).filter((k) => !p.slots[k]),
    cleared: v.round === p.round ? v.planes.map((n, i) => (n < p.planes[i] ? i : -1)).filter((i) => i >= 0) : [],
    engaged: [...['gear', 'flaps', 'brakes'].flatMap((k, j) => v[k].map((on, i) => (on && !p[k][i] ? ['gear', 'flap', 'brake'][j] + i : null)))].filter(Boolean),
    round: v.round !== p.round,
    myTurn: myTurn(v) && !myTurn(p),
    over: v.phase !== p.phase && ['won', 'lost'].includes(v.phase),
    axisFrom: p.axis, posFrom: p.pos,
    marks: { slow: markPct(slowMark(p)), fast: markPct(fastMark(p)), brake: markPct(brakeVal(p) - 0.5) },
  };
  if (p.phase === 'won' || p.phase === 'lost') return { round: true };
  return fx;
}

const EASE = 'cubic-bezier(.22,1,.36,1)';
function runFx(fx, v) {
  if (!v || v.phase === 'lobby') return;
  if (fx.axisFrom != null && fx.axisFrom !== v.axis)
    $('.horizon .ground')?.animate([{ transform: `rotate(${deg(fx.axisFrom)})` }, { transform: `rotate(${deg(v.axis)})` }], { duration: 1000, easing: EASE });
  if (fx.posFrom != null && fx.posFrom !== v.pos) {
    const w = $('.track').clientWidth / v.planes.length;
    $('.ship')?.animate([{ transform: `translateX(${(fx.posFrom - v.pos) * w}px)` }, { transform: 'translateX(0)' }], { duration: 1200, easing: EASE });
  }
  if (fx.marks) {
    const to = { slow: markPct(slowMark(v)), fast: markPct(fastMark(v)), brake: markPct(brakeVal(v) - 0.5) };
    for (const k of ['slow', 'fast', 'brake']) if (fx.marks[k] !== to[k]) $('.pin.' + k)?.animate([{ left: fx.marks[k] + '%' }, { left: to[k] + '%' }], { duration: 800, easing: EASE });
  }
  if (S.fly && v.slots[S.fly.slot]) {
    const el = $(`[data-slot="${S.fly.slot}"] .die`);
    if (el) {
      const r = el.getBoundingClientRect(), f = S.fly.rect;
      el.animate([
        { transform: `translate(${f.left - r.left}px, ${f.top - r.top}px) scale(${f.width / r.width})` },
        { transform: 'none' },
      ], { duration: 420, easing: EASE });
    }
    S.fly = null;
  }
  if (fx.round && v.phase === 'strategy') banner(`${altitude(v.round)} ft`, v.round === ROUNDS ? 'Final approach: touchdown round' : `Round ${v.round} of ${ROUNDS}`);
  if (fx.myTurn) navigator.vibrate?.(35);
  if (fx.over) {
    if (v.phase === 'lost') { $('#app').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-10px)' }, { transform: 'translateX(9px)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(0)' }], { duration: 450 }); navigator.vibrate?.([80, 40, 120]); }
    else navigator.vibrate?.([30, 60, 30]);
  }
}

function banner(big, small) {
  const b = h('div', { class: 'round-banner' }, h('b', {}, big), h('span', {}, small));
  document.body.append(b);
  setTimeout(() => b.remove(), 2200);
}

/* ------------------------------ render ------------------------------ */

function render() {
  const v = S.view;
  let fx = {};
  if (v !== S.lastV) {
    fx = diff(S.lastV, v);
    if (v && S.lastV && v.phase !== S.lastV.phase && !['won', 'lost'].includes(v.phase)) S.overHidden = false;
    S.lastV = v;
  }
  const app = document.getElementById('app');
  const inGame = S.mode === 'game' && v;
  const body = inGame ? (v.phase === 'lobby' ? lobby(v) : flight(v, fx)) : { home, connecting, error: errorScreen }[S.mode]();
  const banners = [
    S.lostHost && h('div', { class: 'banner' }, 'Connection to host lost. Reconnecting...'),
    S.stale && S.client && h('div', { class: 'banner' }, 'You and the host are on different versions. Both reload, host first.'),
  ].filter(Boolean);
  const y = window.scrollY;
  app.replaceChildren(...banners, body);
  const sh = sheet(inGame ? v : null);
  document.querySelector('.sheet-wrap')?.remove();
  if (sh) document.body.append(sh);
  window.scrollTo(0, y);
  runFx(fx, inGame ? v : null);
}

/* ------------------------------ boot ------------------------------ */

(function boot() {
  const session = store.json('gp-session');
  const room = normCode(new URLSearchParams(location.search).get('room')) || normCode(session?.room);
  if (session && room === session.room) {
    if (session.host) {
      const saved = store.json('gp-host-' + room);
      if (saved) {
        saved.players.forEach((p) => { p.connected = p.isHost; });
        return startHost(saved, session);
      }
    } else return joinRoomAs(room, session.name);
  }
  render();
})();
