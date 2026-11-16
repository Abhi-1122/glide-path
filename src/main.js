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

function toast(msg) {
  const t = h('div', { class: 'toast' }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), 3200);
}

const NAME = { pilot: 'Pilot', copilot: 'Co-pilot' };
const PIPS = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

/* ------------------------------ app state ------------------------------ */

const S = {
  mode: 'home', // home | connecting | error | game
  view: null,
  host: null, state: null, client: null,
  lostHost: false, stale: false,
  tmp: null, errMsg: '',
  sel: null, adj: 0, pick: new Set(), // local UI: selected die, focus adjustment, reroll picks
  tutorial: store.get('gp-tutorial') === '1', // personal toggle, off by default
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

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') S.client?.rehello();
});

/* ------------------------------ session ------------------------------ */

function resetLocal() {
  S.host?.leave();
  S.client?.leave();
  Object.assign(S, { host: null, client: null, state: null, view: null, lostHost: false, tmp: null, sel: null, adj: 0 });
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
  const code = h('input', { class: 'input code', placeholder: 'CODE', maxlength: 4, autocomplete: 'off', 'aria-label': 'Room code', value: normCode(params.get('room')) });
  return h('section', { class: 'home' },
    h('div', { class: 'logo' }, h('span', { class: 'logo-mark' }, '✈'), h('h1', {}, 'Glide Path')),
    h('p', { class: 'muted center' }, 'A two-seat co-op landing game. Roll in secret, place in silence, touch down together.'),
    h('div', { class: 'card' },
      h('label', { class: 'lbl' }, 'Name'), name,
      h('button', { class: 'btn primary', onclick: () => createRoom(name.value) }, 'Create flight (you fly Pilot)'),
      h('div', { class: 'or' }, 'or join'),
      h('div', { class: 'row' }, code, h('button', { class: 'btn', onclick: () => joinRoomAs(normCode(code.value), name.value) }, 'Join'))),
    rulesBox(false));
}

const connecting = () => h('section', { class: 'card center' }, h('p', {}, `Contacting the tower for room ${S.tmp?.code}...`));
const errorScreen = () => h('section', { class: 'card center' }, h('p', {}, S.errMsg), h('button', { class: 'btn', onclick: () => goHome() }, 'Back'));

function hud(v) {
  const toggle = h('label', { class: 'switch' },
    h('input', { type: 'checkbox', checked: S.tutorial, onchange: (e) => { S.tutorial = e.target.checked; store.set('gp-tutorial', S.tutorial ? '1' : '0'); render(); } }),
    h('span', {}, 'Tutorial'));
  return h('header', { class: 'hud' },
    h('span', { class: 'brand' }, '✈ Glide Path'),
    h('span', { class: 'chip' }, 'Room ', h('b', {}, v?.code || S.tmp?.code || '')),
    v && h('button', { class: 'btn sm ghost', onclick: () => share(v.code) }, 'Share link'),
    h('span', { class: 'grow' }),
    toggle,
    h('button', { class: 'btn sm ghost', onclick: () => confirm(S.host ? 'Leave? The flight ends for both of you.' : 'Leave this flight?') && goHome() }, 'Leave'));
}

function lobby(v) {
  const me = v.you;
  const seat = (role) => {
    const p = v.players.find((q) => q.role === role);
    return h('div', { class: 'seat ' + role }, h('span', { class: 'seat-role' }, NAME[role]), h('b', {}, p ? p.name + (p.id === me.id ? ' (you)' : '') : 'Waiting...'));
  };
  return h('section', { class: 'lobby' },
    h('div', { class: 'card' },
      h('h2', {}, 'Pre-flight'),
      h('div', { class: 'seats' }, seat('pilot'), seat('copilot')),
      v.players.length < 2 && h('p', { class: 'muted' }, 'Send your co-pilot the link or the room code.'),
      me.isHost
        ? h('div', { class: 'row' },
          h('button', { class: 'btn ghost', onclick: () => doAct({ kind: 'swap' }) }, 'Swap seats'),
          h('button', { class: 'btn primary', disabled: v.players.length < 2, onclick: () => doAct({ kind: 'start' }) }, 'Start flight'))
        : h('p', { class: 'muted' }, 'Waiting for the host to start.')),
    rulesBox(S.tutorial));
}

/* ---- flight board ---- */

const myDice = (v) => v.dice[v.you.role];
const selValue = (v) => (S.sel == null ? null : myDice(v)[S.sel] + S.adj);
const myTurn = (v) => v.phase === 'placing' && v.turn === v.you.role && !v.rerollPick;

function approach(v) {
  return h('div', { class: 'instrument' },
    h('div', { class: 'ins-title' }, 'Approach', h('span', { class: 'muted' }, ` ${RUNWAY - v.pos} to runway`)),
    h('div', { class: 'track' }, v.planes.map((n, i) => {
      const here = i === v.pos, past = i < v.pos;
      return h('div', { class: `cell ${here ? 'here' : ''} ${past ? 'past' : ''} ${i === RUNWAY ? 'rwy' : ''}` },
        h('span', { class: 'cell-k' }, past ? '' : `R${i - v.pos + 1}`),
        h('span', { class: 'cell-body' }, i === RUNWAY ? 'RWY' : n ? '▲'.repeat(n) : '·'),
        here && h('span', { class: 'you-are-here' }, '✈'));
    })),
    S.tutorial && h('p', { class: 'tip' }, 'R1, R2... is the radio value that reaches each space. Triangles are traffic. Throttle cannot carry you through a space with traffic.'));
}

function tiltGauge(v) {
  return h('div', { class: 'instrument' },
    h('div', { class: 'ins-title' }, 'Wing tilt', h('span', { class: 'muted' }, v.axis ? ` ${Math.abs(v.axis)} toward ${v.axis < 0 ? 'Pilot' : 'Co-pilot'}` : ' level')),
    h('div', { class: 'tilt' }, [-3, -2, -1, 0, 1, 2, 3].map((i) =>
      h('span', { class: `t ${Math.abs(i) === 3 ? 'danger' : ''} ${i === v.axis ? 'on' : ''}` }, Math.abs(i) === 3 ? '✕' : i === 0 ? '—' : Math.abs(i)))),
    h('div', { class: 'horizon', style: { '--deg': v.axis * 12 + 'deg' } }, h('i')),
    S.tutorial && h('p', { class: 'tip' }, 'Each round the Pilot and Co-pilot axis dice are compared; the wings tip toward the higher die by the difference. Reaching ✕ is a spin. Land level.'));
}

function speedGauge(v) {
  const sm = slowMark(v), fm = fastMark(v), b = brakeVal(v);
  return h('div', { class: 'instrument' },
    h('div', { class: 'ins-title' }, 'Throttle', h('span', { class: 'muted' }, v.speed != null ? ` last: ${v.speed}` : '')),
    h('div', { class: 'speed' }, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) =>
      h('span', { class: `sp ${n < sm ? 'z0' : n < fm ? 'z1' : 'z2'} ${n === v.speed ? 'on' : ''} ${v.round === ROUNDS && n < b ? 'stop' : ''}` }, n))),
    h('div', { class: 'legend' },
      h('span', { class: 'z0' }, `≤${sm - 0.5}: hold`), h('span', { class: 'z1' }, `${sm + 0.5}–${fm - 0.5}: +1`), h('span', { class: 'z2' }, `≥${fm + 0.5}: +2`),
      h('span', { class: 'brk' }, `Brakes ${b}`)),
    S.tutorial && h('p', { class: 'tip' }, v.round === ROUNDS
      ? `Final round: throttle no longer moves you. Total speed must be below the brakes (${b}) to stop on the runway.`
      : 'Both throttle dice are added. The total decides how far you advance. Gear pushes the hold zone up, flaps push the +2 zone up.'));
}

const SLOT_INFO = {
  axis: ['Axis', 'Mandatory each round. Any value. Sets the wing tilt.'],
  engine: ['Throttle', 'Mandatory each round. Any value. Sum sets your advance.'],
  radio: ['Radio', 'Value N clears one traffic token on space RN.'],
  gear: ['Gear', 'Any order. Each one raises the hold zone by 1.'],
  brake: ['Brakes', 'In order 2 → 4 → 6. Sets your stopping limit.'],
  flap: ['Flaps', 'In order, top first. Each raises the +2 zone by 1.'],
  focus: ['Focus', 'Any value. Earn 1 focus token (max 3).'],
};

function slot(v, id) {
  const d = SLOTS[id];
  const placed = v.slots[id];
  const val = selValue(v);
  const ok = myTurn(v) && val != null && canPlace(v, v.you.role, val, id);
  const engaged = { gear: v.gear, flap: v.flaps, brake: v.brakes }[d.kind]?.[d.i];
  const req = d.vals ? d.vals.join(d.kind === 'brake' ? '' : '–') : '';
  return h('button', {
    class: `slot ${d.kind} own-${d.owner} ${ok ? 'ok' : ''} ${engaged ? 'engaged' : ''} ${placed ? 'filled ' + placed.role : ''}`,
    disabled: !ok,
    title: SLOT_INFO[d.kind][1],
    onclick: () => { doAct({ kind: 'place', die: S.sel, slot: id, adj: S.adj }); S.sel = null; S.adj = 0; },
  },
  placed ? h('span', { class: 'die ' + placed.role }, placed.value) : h('span', { class: 'req' }, req || '○'),
  engaged && h('span', { class: 'led' }));
}

function group(v, kind, ids, extra) {
  return h('div', { class: 'group ' + kind },
    h('div', { class: 'g-title' }, SLOT_INFO[kind][0], extra),
    h('div', { class: 'g-slots' }, ids.map((id) => slot(v, id))),
    S.tutorial && h('p', { class: 'tip' }, SLOT_INFO[kind][1]));
}

function panel(v) {
  return h('div', { class: 'panel' },
    h('div', { class: 'side pilot' },
      h('h3', {}, 'Pilot'),
      group(v, 'axis', ['axisP']), group(v, 'engine', ['engP']), group(v, 'radio', ['radioP']),
      group(v, 'gear', ['gear0', 'gear1', 'gear2']), group(v, 'brake', ['brake0', 'brake1', 'brake2'])),
    h('div', { class: 'side mid' },
      h('h3', {}, 'Shared'),
      group(v, 'focus', ['focus0', 'focus1', 'focus2']),
      h('div', { class: 'tokens' },
        h('span', {}, 'Focus ', h('b', {}, '◆'.repeat(v.focus) + '◇'.repeat(MAX_FOCUS - v.focus))),
        h('span', {}, 'Rerolls ', h('b', {}, v.rerolls))),
      S.tutorial && h('p', { class: 'tip' }, 'Spend focus while placing: each token shifts the die by 1 (no wrap-around). A reroll token lets both crew reroll any of their unplaced dice.')),
    h('div', { class: 'side copilot' },
      h('h3', {}, 'Co-pilot'),
      group(v, 'axis', ['axisC']), group(v, 'engine', ['engC']), group(v, 'radio', ['radioC0', 'radioC1']),
      group(v, 'flap', ['flap0', 'flap1', 'flap2', 'flap3'])));
}

function tray(v) {
  const role = v.you.role;
  const dice = myDice(v);
  const partner = v.dice[other(role)];
  const picking = v.rerollPick && !v.rerollPick[role];
  if (S.sel != null && S.sel >= dice.length) { S.sel = null; S.adj = 0; }
  const val = selValue(v);
  return h('div', { class: 'tray ' + role },
    h('div', { class: 'tray-row' },
      h('span', { class: 'tray-lbl' }, 'Your dice'),
      v.phase === 'strategy' ? h('span', { class: 'muted' }, 'Rolled once both crew are ready.') :
        dice.map((d, i) => h('button', {
          class: `die big ${role} ${S.sel === i ? 'sel' : ''} ${picking && S.pick.has(i) ? 'pick' : ''}`,
          disabled: !(myTurn(v) || picking),
          onclick: () => {
            if (picking) S.pick.has(i) ? S.pick.delete(i) : S.pick.add(i);
            else { S.sel = S.sel === i ? null : i; S.adj = 0; }
            render();
          },
        }, PIPS[d]))),
    h('div', { class: 'tray-row' },
      h('span', { class: 'tray-lbl' }, NAME[other(role)]),
      partner.map((d) => h('span', { class: 'die hidden ' + other(role) }, d || '?'))),
    myTurn(v) && S.sel != null && v.focus > 0 && h('div', { class: 'tray-row' },
      h('span', { class: 'tray-lbl' }, 'Focus'),
      h('button', { class: 'btn sm', disabled: val <= 1 || -(S.adj - 1) > v.focus, onclick: () => { S.adj--; render(); } }, '−'),
      h('b', { class: 'adj' }, `${myDice(v)[S.sel]} → ${val}`),
      h('button', { class: 'btn sm', disabled: val >= 6 || S.adj + 1 > v.focus, onclick: () => { S.adj++; render(); } }, '+')),
    h('div', { class: 'tray-row actions' },
      v.phase === 'strategy' && (v.ready[role]
        ? h('span', { class: 'muted' }, `Waiting for ${NAME[other(role)]} to be ready...`)
        : h('button', { class: 'btn primary', onclick: () => doAct({ kind: 'ready' }) }, 'Ready – roll dice')),
      picking && h('button', { class: 'btn primary', onclick: () => { doAct({ kind: 'rerollPick', idx: [...S.pick] }); S.pick = new Set(); } }, `Reroll ${S.pick.size} selected`),
      v.rerollPick && !picking && h('span', { class: 'muted' }, 'Waiting for partner to choose rerolls...'),
      myTurn(v) && v.rerolls > 0 && h('button', { class: 'btn ghost', onclick: () => { S.sel = null; doAct({ kind: 'reroll' }); } }, 'Use reroll token')));
}

function hint(v) {
  const role = v.you.role;
  const lines = [];
  if (v.phase === 'strategy') {
    lines.push(`Strategy time: you may talk freely about the plan. Once dice are rolled, no talking about dice values. ${NAME[firstPlayer(v.round)]} places first this round.`);
    if (v.round === ROUNDS) lines.push('This is the landing round. Make sure you can level the wings, keep the speed under the brakes, and finish any gear/flaps.');
  } else if (v.phase === 'placing') {
    if (v.rerollPick) lines.push('Reroll: tap the dice you want to reroll, then confirm (you can pick none).');
    else if (v.turn !== role) lines.push(`${NAME[v.turn]} is placing. Watch what they choose: it is your only communication now.`);
    else if (S.sel == null) lines.push('Your turn: tap one of your dice, then a highlighted space. You must place a die each turn.');
    else {
      const val = selValue(v);
      lines.push(`Placing a ${val}. Highlighted spaces accept it.`);
      const mine = role === 'pilot' ? 'engP' : 'engC', theirs = role === 'pilot' ? 'engC' : 'engP';
      if (!v.slots[mine] && v.slots[theirs] && v.round < ROUNDS) {
        const sp = val + v.slots[theirs].value, mv = moveFor(v, sp);
        const blocked = [...Array(mv).keys()].some((i) => v.planes[v.pos + i]);
        lines.push(`On Throttle: speed ${sp} → advance ${mv}${blocked ? ' — COLLISION, traffic ahead!' : v.pos + mv > RUNWAY ? ' — OVERSHOOT!' : ''}.`);
      }
      const ax = role === 'pilot' ? 'axisP' : 'axisC', axO = role === 'pilot' ? 'axisC' : 'axisP';
      if (!v.slots[ax] && v.slots[axO]) {
        const t = v.axis + (role === 'pilot' ? v.slots.axisC.value - val : val - v.slots.axisP.value);
        lines.push(`On Axis: tilt becomes ${t}${Math.abs(t) >= 3 ? ' — SPIN!' : ''}.`);
      }
      if (val >= 1) {
        const t = v.pos + val - 1;
        lines.push(`On Radio: ${v.planes[t] ? 'clears traffic on R' + val : 'nothing to clear on R' + val}.`);
      }
    }
    const left = ['axisP', 'axisC', 'engP', 'engC'].filter((id) => !v.slots[id] && SLOTS[id].owner === role);
    if (left.length && myDice(v).length <= left.length) lines.push('Careful: your remaining dice are needed for Axis/Throttle.');
    if (v.planes[v.pos] && !(v.slots.engP && v.slots.engC)) lines.push('Traffic sits on your current space: clear it (Radio 1) or keep the speed in the hold zone.');
  }
  return h('div', { class: 'card hint' }, h('h3', {}, 'Flight instructor'), lines.map((l) => h('p', {}, l)));
}

function rulesBox(open) {
  return h('details', { class: 'card rules', open },
    h('summary', {}, 'How to fly (rules)'),
    h('ol', {},
      h('li', {}, h('b', {}, 'Goal. '), `Land on the runway after ${ROUNDS} rounds (6000 ft down to the ground) with all 3 gear down, all 4 flaps out, wings level and speed below the brakes.`),
      h('li', {}, h('b', {}, 'Round. '), 'Talk strategy, then both press Ready. Each of you secretly rolls 4 dice. From then on: no talking about your dice. Take turns placing one die at a time; the starting seat alternates each round.'),
      h('li', {}, h('b', {}, 'Mandatory. '), 'Each round both crew must put one die on Axis and one on Throttle. If either is missing when all 8 dice are placed, the flight is lost.'),
      h('li', {}, h('b', {}, 'Axis. '), 'When both axis dice are down, the wings tip toward the higher die by the difference. Tilt 3 either way is a spin.'),
      h('li', {}, h('b', {}, 'Throttle. '), 'When both throttle dice are down, their sum is compared to the hold and +2 zones: advance 0, 1 or 2 spaces. Moving into a space that still has traffic is a collision. Passing the runway is an overshoot.'),
      h('li', {}, h('b', {}, 'Radio. '), 'A die of value N removes one traffic token N−1 spaces ahead (1 = your current space). Pilot has 1 radio, Co-pilot has 2.'),
      h('li', {}, h('b', {}, 'Gear (Pilot). '), '1–2, 3–4, 5–6, any order. Each raises the hold zone by 1, so you need more speed to keep moving.'),
      h('li', {}, h('b', {}, 'Flaps (Co-pilot). '), '1–2, 2–3, 4–5, 5–6, top to bottom. Each raises the +2 zone by 1.'),
      h('li', {}, h('b', {}, 'Brakes (Pilot). '), 'Exactly 2, then 4, then 6. On the final round throttle does not move you; your speed must be lower than the highest brake engaged.'),
      h('li', {}, h('b', {}, 'Focus. '), 'Any die on a Focus space earns a token (max 3 shared). Spend tokens when placing to change a die by 1 each.'),
      h('li', {}, h('b', {}, 'Rerolls. '), 'Tokens arrive in rounds 1 and 5. On your turn, spend one: each of you rerolls any of your unplaced dice.'),
      h('li', {}, h('b', {}, 'Timing. '), 'You must be over the runway by the end of round 6; the final round is for touchdown only. A seat with no legal placement loses the flight.')));
}

function over(v) {
  const won = v.phase === 'won';
  return h('div', { class: 'card over ' + (won ? 'won' : 'lost') },
    h('h2', {}, won ? 'Landed!' : 'Flight lost'),
    h('p', {}, v.reason),
    v.you.isHost ? h('button', { class: 'btn primary', onclick: () => doAct({ kind: 'restart' }) }, 'Fly again') : h('p', { class: 'muted' }, 'The host can start another flight.'));
}

function flight(v) {
  const turn = v.phase === 'placing' && !v.rerollPick ? (v.turn === v.you.role ? 'Your turn' : `${NAME[v.turn]}’s turn`) : v.phase === 'strategy' ? 'Strategy' : '';
  return h('section', { class: 'flight seat-' + v.you.role },
    h('div', { class: 'status' },
      h('span', {}, 'Round ', h('b', {}, `${v.round}/${ROUNDS}`)),
      h('span', {}, 'Alt ', h('b', {}, `${altitude(v.round)} ft`)),
      h('span', {}, 'You: ', h('b', { class: v.you.role }, NAME[v.you.role])),
      turn && h('span', { class: 'turn' }, turn),
      v.players.some((p) => !p.connected) && h('span', { class: 'warn' }, 'Partner offline')),
    ['won', 'lost'].includes(v.phase) && over(v),
    h('div', { class: 'instruments' }, approach(v), tiltGauge(v), speedGauge(v)),
    S.tutorial && hint(v),
    tray(v),
    panel(v),
    h('details', { class: 'card log' }, h('summary', {}, 'Flight log'), h('ul', {}, v.log.slice().reverse().map((l) => h('li', {}, l)))),
    rulesBox(false));
}

/* ------------------------------ render ------------------------------ */

function render() {
  const v = S.view;
  const app = document.getElementById('app');
  const body = S.mode === 'game' && v ? (v.phase === 'lobby' ? lobby(v) : flight(v))
    : { home, connecting, error: errorScreen }[S.mode]();
  const banners = [
    S.lostHost && h('div', { class: 'banner' }, 'Connection to host lost. Reconnecting...'),
    S.stale && S.client && h('div', { class: 'banner' }, 'You and the host are on different versions. Both reload, host first.'),
  ];
  const y = window.scrollY;
  app.replaceChildren(...(S.mode === 'home' ? [] : [hud(v)]), ...banners.filter(Boolean), body);
  window.scrollTo(0, y);
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
