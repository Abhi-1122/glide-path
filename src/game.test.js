import assert from 'node:assert/strict';
import { createGame, addPlayer, applyAction, viewFor, SLOTS, ROUNDS, RUNWAY } from './game.js';

function setup() {
  const s = createGame('TEST');
  addPlayer(s, { name: 'Ann', token: 'a', isHost: true });
  addPlayer(s, { name: 'Bob', token: 'b' });
  assert.equal(applyAction(s, 'p1', { kind: 'start' }), null);
  return s;
}
const P = 'p1', C = 'p2';
const roll = (s, pd, cd) => {
  applyAction(s, P, { kind: 'ready' });
  applyAction(s, C, { kind: 'ready' });
  s.dice.pilot = pd; s.dice.copilot = cd; // force dice
};
const place = (s, who, value, slot, adj = 0) => {
  const role = who === P ? 'pilot' : 'copilot';
  return applyAction(s, who, { kind: 'place', die: s.dice[role].indexOf(value), slot, adj });
};

// roles, lobby, hidden dice
{
  const s = setup();
  assert.equal(s.players[0].role, 'pilot');
  assert.equal(s.players[1].role, 'copilot');
  roll(s, [1, 2, 3, 4], [5, 6, 6, 6]);
  assert.equal(s.phase, 'placing');
  assert.deepEqual(viewFor(s, P).dice.copilot, [0, 0, 0, 0]);
  assert.deepEqual(viewFor(s, P).dice.pilot, [1, 2, 3, 4]);
  assert.equal(viewFor(s, P).players[0].token, undefined);
}

// turn order, ownership, axis tilt, radio, engines, focus
{
  const s = setup();
  roll(s, [1, 2, 3, 4], [1, 3, 5, 6]);
  assert.equal(place(s, C, 1, 'axisC'), 'Not your turn');
  assert.equal(place(s, P, 1, 'flap0'), 'That die cannot go there');
  assert.equal(place(s, P, 2, 'gear0'), null);
  assert.equal(s.gear[0], true);
  assert.equal(place(s, C, 3, 'radioC0'), null); // 2 spaces ahead -> space 2 had 1 plane
  assert.equal(s.planes[2], 0);
  assert.equal(place(s, P, 4, 'axisP'), null);
  assert.equal(place(s, C, 5, 'axisC'), null);
  assert.equal(s.axis, 1); // tilts toward the co-pilot's higher die
  assert.equal(place(s, P, 3, 'engP'), null);
  assert.equal(place(s, C, 6, 'focus0'), null);
  assert.equal(s.focus, 1);
  // speed 1+? : pilot 1 left; engines need co-pilot -> co-pilot has 1 left
  assert.equal(place(s, P, 1, 'radioP'), null); // current space: no plane
  assert.equal(place(s, C, 1, 'engC', 1), null); // focus turns 1 into 2: speed 5 -> slow mark 5.5 -> hold
  assert.equal(s.focus, 0);
  assert.equal(s.pos, 0);
  assert.equal(s.round, 2);
  assert.equal(s.phase, 'strategy');
}

// order rules for brakes and flaps
{
  const s = setup();
  roll(s, [4, 4, 4, 4], [3, 3, 3, 3]);
  assert.equal(place(s, P, 4, 'brake1'), 'That die cannot go there');
  assert.equal(place(s, P, 4, 'axisP'), null);
  assert.equal(place(s, C, 3, 'flap1'), 'That die cannot go there');
}

// collision and spin
{
  const s = setup();
  s.pos = 2; // 1 plane here
  roll(s, [6, 6, 1, 1], [6, 6, 1, 1]);
  place(s, P, 6, 'engP');
  place(s, C, 6, 'engC'); // speed 12 -> move 2 into traffic
  assert.equal(s.phase, 'lost');
  assert.match(s.reason, /collision/);
}
{
  const s = setup();
  roll(s, [6, 6, 1, 1], [1, 1, 1, 1]);
  place(s, P, 6, 'axisP');
  place(s, C, 1, 'axisC'); // tilt -5
  assert.equal(s.phase, 'lost');
  assert.match(s.reason, /spin/);
}

// mandatory axis + throttle every round
{
  const s = setup();
  roll(s, [2, 2, 2, 2], [1, 1, 1, 1]);
  for (const [w, v, sl] of [[P, 2, 'gear0'], [C, 1, 'flap0'], [P, 2, 'brake0'], [C, 1, 'radioC0'], [P, 2, 'radioP'], [C, 1, 'radioC1'], [P, 2, 'focus0'], [C, 1, 'focus1']])
    assert.equal(place(s, w, v, sl), null);
  assert.equal(s.phase, 'lost');
  assert.match(s.reason, /Axis and Throttle/);
}

// a winning landing on the final round
{
  const s = setup();
  Object.assign(s, { round: ROUNDS, pos: RUNWAY, planes: s.planes.map(() => 0), gear: [true, true, true], flaps: [true, true, true, true], brakes: [true, true, false] });
  roll(s, [3, 3, 6, 1], [3, 3, 1, 1]);
  for (const [w, v, sl] of [[P, 3, 'axisP'], [C, 3, 'axisC'], [P, 1, 'engP'], [C, 1, 'engC'], [P, 6, 'brake2'], [C, 3, 'focus0'], [P, 3, 'radioP'], [C, 1, 'radioC0']])
    assert.equal(place(s, w, v, sl), null, sl);
  assert.equal(s.phase, 'won', s.reason);
}

// landing too fast fails
{
  const s = setup();
  Object.assign(s, { round: ROUNDS, pos: RUNWAY, planes: s.planes.map(() => 0), gear: [true, true, true], flaps: [true, true, true, true], brakes: [true, false, false] });
  roll(s, [3, 3, 1, 1], [3, 3, 1, 1]);
  for (const [w, v, sl] of [[P, 3, 'axisP'], [C, 3, 'axisC'], [P, 1, 'engP'], [C, 1, 'engC'], [P, 3, 'radioP'], [C, 3, 'focus0'], [P, 1, 'focus1'], [C, 1, 'radioC0']])
    assert.equal(place(s, w, v, sl), null, sl);
  assert.equal(s.phase, 'lost');
  assert.match(s.reason, /speed 2 not below brakes 2/);
}

// reroll: both pick, hidden picks in view
{
  const s = setup();
  roll(s, [1, 1, 1, 1], [1, 1, 1, 1]);
  assert.equal(s.rerolls, 1);
  assert.equal(applyAction(s, P, { kind: 'reroll' }), null);
  assert.equal(place(s, P, 1, 'axisP'), 'Waiting for the reroll');
  assert.equal(applyAction(s, P, { kind: 'rerollPick', idx: [0, 1, 2, 3] }), null);
  assert.equal(applyAction(s, C, { kind: 'rerollPick', idx: [] }, () => 0.99), null);
  assert.equal(s.rerollPick, null);
  assert.deepEqual(s.dice.copilot, [1, 1, 1, 1]);
}

assert.equal(Object.keys(SLOTS).length, 20);
console.log('all game tests passed');
