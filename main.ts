// Sokoban push-optimal solver for make.fun sokoban-solver-01-run-20261121.
//
// One program answers a set of 5 levels in one run: it reads /input/<id>/level.txt
// (XSB) and writes /output/<id>/solution.txt (LURD moves). Scoring is by pushes:
// a level solved in P* pushes earns 1000 points, more pushes earn 500 * P* / pushes.
//
// How it works
// -----------
// The generated levels decompose: a hallway (the player's row) with 1-4 rooms off
// it, each room holding 3-4 boxes and as many goals, and no box can ever cross a
// door (a push through a door would need the player to stand in the wall row past
// the one-wide hallway). So the level's push optimum is the sum of its rooms'
// optima, and each room is solved on its own, the other rooms' boxes standing as
// walls, the player walking on from room to room.
//
// Each room is solved push-optimally with A* over pushes:
//   - a state is the boxes (sorted) plus the player's reachable region (named by
//     its lowest square); between pushes the player walks freely, so only the
//     region matters, not the exact square the player stands on.
//   - the heuristic is the cheapest assignment of boxes to goals (Hungarian,
//     by brute-force permutations over at most 4 boxes) using shortest-path
//     distances that ignore the other boxes: admissible, and consistent, so the
//     first solved state A* pops is push-optimal.
//   - two deadlocks are pruned, neither of which can prune a solvable state:
//     a box on a dead square (one from which no pull, ignoring the other boxes,
//     ever reaches a goal) and a frozen 2 x 2 block of walls and boxes with a
//     box off its goal.
// If a room's A* exhausts its budget, a greedy best-first search (same pruning,
// same state space) tries for any solution; if the level is no set of rooms at
// all, the whole level is searched the same way.
//
// Everything is budgeted by work (state expansions), never by the wall clock,
// and every tie is broken by fixed order, so two runs write the same bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The four directions: [dx, dy, walk letter, push letter].
const DIRS = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

// Work budgets (expansions), never the clock: deterministic across runs.
const ASTAR_BUDGET = 400000;
const GREEDY_BUDGET = 200000;
const GLOBAL_BUDGET = 3000000;
let spent = 0;

/** A level in XSB: width, height, walls, goals, boxes, player. */
function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is a wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/** The squares from which a box alone can be pulled onto some goal (pulled back
 *  from the goals over open floor, the player's position ignored). */
function liveSquares(level) {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (let k = 0; k < 4; k++) {
      const d = DIRS[k][1] * w + DIRS[k][0];
      const y = x - d;
      if (y < 0 || y >= wall.length) continue;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** The squares the player reaches from `from` with `occupied` in the way,
 *  marked in `seen` with `stamp`; returns the lowest reached square. */
function reach(level, occupied, from, seen, stamp, stack) {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2 x 2 block of walls and
 *  boxes with a box off its goal. */
function frozenBlock(level, occupied, goal, t) {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= wall.length) continue;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** A state's key: the region's lowest square and the boxes' squares. */
function keyOf(boxes, low) {
  return low + ':' + boxes.join(',');
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD
 *  letters (the first direction first on ties). */
function walkTo(level, occupied, from, to) {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + DIRS[k][1] * w + DIRS[k][0];
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = DIRS[k][2];
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, case aside) from `from`. */
function endOf(w, from, moves) {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

// A binary heap on [priority, g, sequence, state], smallest first.
function heapPush(heap, e) {
  let i = heap.length;
  heap.push(e);
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!heapLess(heap[i], heap[p])) break;
    const t = heap[i]; heap[i] = heap[p]; heap[p] = t;
    i = p;
  }
}
function heapLess(a, b) {
  // Smaller priority first; on a tie, the deeper state (larger g) first, then
  // the earlier generated: deterministic, and goals surface sooner.
  return a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
}
function heapPop(heap) {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length > 0) {
    heap[0] = last;
    for (let i = 0; ; ) {
      let c = 2 * i + 1;
      if (c >= heap.length) break;
      if (c + 1 < heap.length && heapLess(heap[c + 1], heap[c])) c++;
      if (!heapLess(heap[c], heap[i])) break;
      const t = heap[i]; heap[i] = heap[c]; heap[c] = t;
      i = c;
    }
  }
  return top;
}

/**
 * Push-optimal (astar=true) or greedy (astar=false) search of one sub-level:
 * {pushes, moves} or null when the budget runs out or the level has no solution.
 * A state is the boxes and the player's square after the push that made it;
 * the search expands states in order of pushes (A*) or of the estimate (greedy).
 */
function searchPushes(level, budget, astar) {
  const { w, wall, goals } = level;
  const size = wall.length;
  const n = level.boxes.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (boxes) => boxes.every((b) => goal[b]);
  if (level.boxes.some((b) => !live[b])) return null;

  // Shortest-path distances from every square to each goal, over open floor
  // alone: the assignment heuristic's table.
  const dist = goals.map((g) => {
    const d = new Int32Array(size).fill(-1);
    const q = [g];
    d[g] = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const p = q[qi];
      for (let k = 0; k < 4; k++) {
        const r = p + DIRS[k][1] * w + DIRS[k][0];
        if (r < 0 || r >= size) continue;
        if (!wall[r] && d[r] < 0) {
          d[r] = d[p] + 1;
          q.push(r);
        }
      }
    }
    return d;
  });
  // Every assignment of the boxes to the goals, as goal-index permutations.
  const perms = [];
  {
    const idx = goals.map((_, i) => i);
    const gen = (a, m) => {
      if (m === 1) { perms.push(a.slice()); return; }
      for (let i = 0; i < m; i++) {
        gen(a, m - 1);
        const j = m % 2 === 1 ? 0 : i;
        const t = a[j]; a[j] = a[m - 1]; a[m - 1] = t;
      }
    };
    gen(idx, idx.length);
  }
  // The cheapest assignment of these boxes to the goals, or Infinity when no
  // box can reach the goal it would need: admissible, and consistent. When the
  // counts differ (a malformed level: more boxes than goals, or none at all)
  // there is no one-to-one assignment, so each box takes its nearest goal.
  const heuristic = (boxes) => {
    if (n === 0) return 0;
    if (goals.length === 0) return Infinity;
    if (n !== goals.length) {
      let s = 0;
      for (const b of boxes) {
        let m = Infinity;
        for (let gi = 0; gi < goals.length; gi++) {
          const d = dist[gi][b];
          if (d >= 0 && d < m) m = d;
        }
        if (m === Infinity) return Infinity;
        s += m;
      }
      return s;
    }
    let best = Infinity;
    for (const p of perms) {
      let s = 0;
      let ok = true;
      for (let i = 0; i < n; i++) {
        const d = dist[p[i]][boxes[i]];
        if (d < 0) { ok = false; break; }
        s += d;
        if (s >= best) { ok = false; break; }
      }
      if (ok && s < best) best = s;
    }
    return best;
  };

  // The states: boxes, player square, parent, the push that made it, pushes,
  // and the state's key (region-low + boxes, fixed at generation).
  const sBoxes = [level.boxes.slice()];
  const sPlayer = [level.player];
  const sParent = [-1];
  const sFrom = [-1];
  const sTo = [-1];
  const sG = [0];
  const closed = new Map();
  for (const b of level.boxes) occupied[b] = 1;
  const low0 = reach(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  const sKey = [keyOf(level.boxes, low0)];
  closed.set(sKey[0], 0);
  const h0 = heuristic(level.boxes);
  if (h0 === Infinity) return null;
  const heap = [];
  let seq = 0;
  heapPush(heap, [astar ? h0 : h0, 0, seq++, 0]);
  let expanded = 0;
  while (heap.length > 0) {
    const [, g, , s] = heapPop(heap);
    const boxes = sBoxes[s];
    // A stale heap entry: this state was reached again with fewer pushes.
    if (closed.get(sKey[s]) !== g) continue;
    if (solved(boxes)) {
      // Rebuild the moves: walk to each push's square, then push.
      const path = [];
      for (let t = s; t > 0; t = sParent[t]) path.push(t);
      path.reverse();
      let moves = '';
      let player = level.player;
      let cur = level.boxes.slice();
      for (const t of path) {
        const from = sFrom[t];
        const to = sTo[t];
        const d = to - from;
        const dir = DIRS.find(([dx, dy]) => dy * w + dx === d);
        for (const b of cur) occupied[b] = 1;
        moves += walkTo(level, occupied, player, from - d);
        for (const b of cur) occupied[b] = 0;
        moves += dir[3];
        player = from;
        const next = sBoxes[t];
        cur = next.slice();
      }
      return { pushes: path.length, moves };
    }
    if (expanded >= budget || spent >= GLOBAL_BUDGET) return null;
    expanded++;
    spent++;
    for (const b of boxes) occupied[b] = 1;
    const here = ++stamp;
    reach(level, occupied, sPlayer[s], seen, here, stack);
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi];
      for (let k = 0; k < 4; k++) {
        const d = DIRS[k][1] * w + DIRS[k][0];
        const t = b + d;
        if (seen[b - d] !== here || t < 0 || t >= size || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key = null;
        let next = null;
        let h = Infinity;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          h = heuristic(next);
          if (h !== Infinity) key = keyOf(next, reach(level, occupied, b, mark, ++stamp, stack));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || h === Infinity) continue;
        const g2 = g + 1;
        const had = closed.get(key);
        if (had !== undefined && had <= g2) continue;
        closed.set(key, g2);
        sBoxes.push(next);
        sPlayer.push(b);
        sParent.push(s);
        sFrom.push(b);
        sTo.push(t);
        sG.push(g2);
        sKey.push(key);
        heapPush(heap, [astar ? g2 + h : h, g2, seq++, sBoxes.length - 1]);
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  return null;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a
 * box there reaches no goal) out of the floor, and each part left that holds a
 * box is a room, its squares, boxes and goals. Null when some part holds more
 * or fewer boxes than goals, or a box starts in the hallway: then the level is
 * no set of rooms.
 */
function roomsOf(level) {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (let k = 0; k < 4; k++) {
        const q = squares[i] + DIRS[k][1] * w + DIRS[k][0];
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) if (part[g] >= 0) rooms[part[g]].goals.push(g);
  if (goals.some((g) => part[g] < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** One room's solution: A* first, greedy best-first when it gives up. */
function solveRoom(sub) {
  return searchPushes(sub, ASTAR_BUDGET, true) ?? searchPushes(sub, GREEDY_BUDGET, false);
}

/** The level solved room by room, the other rooms' boxes standing as walls
 *  (on their goals once their room is done); the rooms' optima add up to the
 *  level's. Falls back to a search over the whole level when it is no set of
 *  rooms. Returns {moves, solved}. */
function solveLevel(text) {
  const level = parseLevel(text);
  const rooms = roomsOf(level);
  if (rooms !== null) {
    let player = level.player;
    let moves = '';
    for (const room of rooms) {
      const wall = level.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
      }
      const sub = { w: level.w, h: level.h, wall, goals: room.goals.slice(), boxes: room.boxes.slice(), player };
      const solved = solveRoom(sub);
      if (solved === null) return { moves, solved: false };
      moves += solved.moves;
      player = endOf(level.w, player, solved.moves);
      room.done = true;
    }
    return { moves, solved: true };
  }
  const solved = solveRoom(level);
  return solved === null ? { moves: '', solved: false } : { moves: solved.moves, solved: true };
}

/** Replay the moves on the level: true when every step is legal and every box
 *  ends on a goal. */
function verifyMoves(text, moves) {
  const level = parseLevel(text);
  const { w, wall } = level;
  const goal = new Uint8Array(wall.length);
  for (const g of level.goals) goal[g] = 1;
  const box = new Uint8Array(wall.length);
  for (const b of level.boxes) box[b] = 1;
  let player = level.player;
  for (const ch of moves.toLowerCase()) {
    const k = ch === 'u' ? 0 : ch === 'd' ? 1 : ch === 'l' ? 2 : 3;
    const d = DIRS[k][1] * w + DIRS[k][0];
    const next = player + d;
    if (wall[next]) return false;
    if (box[next]) {
      const beyond = next + d;
      if (wall[beyond] || box[beyond]) return false;
      box[next] = 0;
      box[beyond] = 1;
    }
    player = next;
  }
  for (let i = 0; i < box.length; i++) if (box[i] && !goal[i]) return false;
  return true;
}

for (const id of readdirSync(I).sort()) {
  const text = readFileSync(join(I, id, 'level.txt'), 'utf8');
  // One bad level must never kill the set: any failure still writes a valid
  // (empty) answer for that level, and the rest of the set is solved.
  let out = '';
  try {
    const { moves, solved } = solveLevel(text);
    if (solved && verifyMoves(text, moves)) out = moves;
  } catch {
    out = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${out}\n`);
}
