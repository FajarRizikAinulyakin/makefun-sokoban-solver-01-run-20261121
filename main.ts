// Room-by-room push-optimal Sokoban solver.
//
// The levels this competition draws are a hallway with one to four rooms off
// it, each room holding 3 or 4 boxes and as many goals, and a box that leaves
// its room can never come back, so a level's push-optimal count is the sum of
// its rooms' optima. This program therefore splits every level into rooms,
// solves each room on its own in the fewest pushes, and stitches the rooms'
// push sequences together with the player's walks between them.
//
// A room is solved by a search over pushes, not steps: a state is the boxes'
// squares plus the region the player can reach (named by its lowest square),
// so a whole walk between two pushes is one state. The search is A* whose
// estimate is the cheapest way to match the boxes to the goals by the
// shortest floor distance, which no push sequence can beat, so the first
// solved state it meets is push-optimal; a breadth-first search over the
// same states is the fallback when A* spends its state budget. States are
// pruned when a box sits on a square no push can ever bring to a goal
// (pulled back from the goals, ignoring the other boxes) or inside a frozen
// 2 x 2 block of walls and boxes. A room that is not the last one is only
// accepted solved when the player can still reach its door, so the player
// can walk on to the next room; a room whose door square is itself a goal is
// solved last, since the box that ends there seals the room.
//
// Everything is budgeted by work (states searched), never by the wall clock,
// and every tie is broken by a fixed order, so two runs write the same bytes.
// Only Node's built-in modules are used; nothing is read outside /input and
// /bot, nothing is written outside /output.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** State budgets, counted in states searched, never in seconds. */
const ASTAR_MAX_STATES = 100_000;
const BFS_MAX_STATES = 250_000;
const TOTAL_MAX_STATES = 2_000_000;

const DIRS = [
  { dx: 0, dy: -1, ch: 'u', push: 'U' },
  { dx: 0, dy: 1, ch: 'd', push: 'D' },
  { dx: -1, dy: 0, ch: 'l', push: 'L' },
  { dx: 1, dy: 0, ch: 'r', push: 'R' },
];

type Level = {
  w: number;
  h: number;
  size: number;
  wall: Uint8Array;
  goalSet: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

type Push = { from: number; to: number };

type Room = {
  cells: number[];
  boxes: number[];
  goals: number[];
  door: number;
  entry: number;
};

/** Parse an XSB level; the outer frame counts as wall whatever it shows. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const size = w * h;
  const wall = new Uint8Array(size).fill(1);
  const goalSet = new Uint8Array(size);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x] as string;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') {
        goalSet[i] = 1;
        goals.push(i);
      }
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, size, wall, goalSet, goals, boxes, player };
}

/**
 * Split a level into rooms: the connected parts of the floor once the
 * player's row (the hallway) is cut out. Null when the level is no such set
 * of rooms: a box or a goal in the hallway, a part holding a different count
 * of boxes and goals, or a room with anything but one door onto the hallway.
 */
function findRooms(level: Level): Room[] | null {
  const { w, size, wall, goals, boxes, player } = level;
  const prow = Math.floor(player / w);
  const comp = new Int32Array(size).fill(-1);
  const rooms: Room[] = [];
  const stack: number[] = [];
  for (let s = 0; s < size; s++) {
    if (wall[s] || Math.floor(s / w) === prow || comp[s] >= 0) continue;
    const cells: number[] = [s];
    comp[s] = rooms.length;
    stack.length = 0;
    stack.push(s);
    while (stack.length > 0) {
      const c = stack.pop() as number;
      for (const d of DIRS) {
        const q = c + d.dy * w + d.dx;
        if (q < 0 || q >= size) continue;
        if (wall[q] || Math.floor(q / w) === prow || comp[q] >= 0) continue;
        comp[q] = rooms.length;
        cells.push(q);
        stack.push(q);
      }
    }
    rooms.push({ cells, boxes: [], goals: [], door: -1, entry: -1 });
  }
  for (const b of boxes) {
    if (comp[b] < 0) return null;
    rooms[comp[b] as number]!.boxes.push(b);
  }
  for (const g of goals) {
    if (comp[g] < 0) return null;
    rooms[comp[g] as number]!.goals.push(g);
  }
  const out: Room[] = [];
  for (const r of rooms) {
    if (r.boxes.length === 0) {
      if (r.goals.length > 0) return null;
      continue;
    }
    if (r.boxes.length !== r.goals.length) return null;
    r.boxes.sort((a, b) => a - b);
    r.goals.sort((a, b) => a - b);
    let door = -1;
    let entry = -1;
    let doorCount = 0;
    for (const c of r.cells) {
      for (const d of DIRS) {
        const q = c + d.dy * w + d.dx;
        if (q < 0 || q >= size) continue;
        if (Math.floor(q / w) === prow && !wall[q]) {
          doorCount++;
          if (door < 0) {
            door = c;
            entry = q;
          }
        }
      }
    }
    if (doorCount !== 1 || door < 0) return null;
    r.door = door;
    r.entry = entry;
    out.push(r);
  }
  return out.length > 0 ? out : null;
}

type SearchOpts = {
  w: number;
  size: number;
  wall: Uint8Array;
  boxCell: Uint8Array;
  playerCell: Uint8Array;
  goals: number[];
  boxes: number[];
  start: number;
  exit: number;
  maxStates: number;
  astar: boolean;
  budget: { remaining: number };
};

/**
 * The fewest-push solution of a board: A* over pushes (or breadth-first over
 * the same states when astar is false, which is the same optimum found the
 * slow way). A state is the boxes' squares and the player's reachable
 * region, named by its lowest square. Returns the pushes, each {from, to} in
 * the board's squares, or null when the state budget runs out or no solution
 * exists. Deterministic: every tie breaks by insertion order.
 */
function searchPush(o: SearchOpts): Push[] | null {
  const { w, size, wall, boxCell, playerCell, goals, boxes, start, exit, maxStates, astar } = o;
  const n = goals.length;
  const goalSet = new Uint8Array(size);
  for (const g of goals) goalSet[g] = 1;
  const sortedBoxes = [...boxes].sort((a, b) => a - b);

  // Live squares: a box there can still be pushed onto some goal. Pulled back
  // from the goals: a square y is live when the square past it holds a live
  // square and the player can stand on the square behind y to push it there.
  const live = new Uint8Array(size);
  const liveQueue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    liveQueue.push(g);
  }
  for (let qi = 0; qi < liveQueue.length; qi++) {
    const x = liveQueue[qi] as number;
    for (const d of DIRS) {
      const dd = d.dy * w + d.dx;
      const y = x - dd;
      const stand = y - dd;
      if (y < 0 || y >= size || stand < 0 || stand >= size) continue;
      if (!boxCell[y] || !playerCell[stand] || live[y]) continue;
      live[y] = 1;
      liveQueue.push(y);
    }
  }
  for (const b of sortedBoxes) if (!live[b]) return null;

  // Floor distances from every goal over the squares a box may occupy.
  const goalDist: Int32Array[] = [];
  for (const g of goals) {
    const dist = new Int32Array(size).fill(-1);
    dist[g] = 0;
    const q: number[] = [g];
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi] as number;
      for (const d of DIRS) {
        const nb = c + d.dy * w + d.dx;
        if (nb < 0 || nb >= size || !boxCell[nb] || dist[nb] >= 0) continue;
        dist[nb] = dist[c] as number + 1;
        q.push(nb);
      }
    }
    goalDist.push(dist);
  }

  // The estimate: the cheapest matching of boxes to goals by floor distance.
  // Every push moves one box one square, so no push sequence beats it.
  const perms: number[][] = [];
  if (astar && n >= 1 && n <= 5) {
    const idx = goals.map((_, i) => i);
    const gen = (a: number[], k: number): void => {
      if (k === 1) {
        perms.push([...a]);
        return;
      }
      for (let i = 0; i < k; i++) {
        gen(a, k - 1);
        const j = k % 2 === 0 ? i : 0;
        const tmp = a[j] as number;
        a[j] = a[k - 1] as number;
        a[k - 1] = tmp;
      }
    };
    gen(idx, idx.length);
  }
  const heuristic = (bs: number[]): number => {
    if (!astar || n === 0) return 0;
    if (n <= 5) {
      let best = Infinity;
      for (const p of perms) {
        let s = 0;
        for (let i = 0; i < n; i++) {
          const dd = goalDist[p[i] as number]![bs[i] as number] as number;
          if (dd < 0) {
            s = Infinity;
            break;
          }
          s += dd;
        }
        if (s < best) best = s;
      }
      return best;
    }
    let s = 0;
    for (const b of bs) {
      let m = Infinity;
      for (let gi = 0; gi < n; gi++) {
        const dd = goalDist[gi]![b] as number;
        if (dd >= 0 && dd < m) m = dd;
      }
      if (m === Infinity) return Infinity;
      s += m;
    }
    return s;
  };

  // Flood fills. `seen` holds the region of the state being expanded, so a
  // push square can be tested against it; `seenTmp` is scratch for the
  // regions a push would make, so those never disturb the test.
  const seen = new Int32Array(size);
  const seenTmp = new Int32Array(size);
  const floodStack = new Int32Array(size);
  let stampA = 0;
  let stampB = 0;
  const floodLow = (from: number, occ: Uint8Array, marks: Int32Array, stamp: number): number => {
    let low = from;
    let sp = 0;
    floodStack[sp++] = from;
    marks[from] = stamp;
    while (sp > 0) {
      const c = floodStack[--sp] as number;
      if (c < low) low = c;
      for (const d of DIRS) {
        const q = c + d.dy * w + d.dx;
        if (q < 0 || q >= size) continue;
        if (!playerCell[q] || occ[q] || marks[q] === stamp) continue;
        marks[q] = stamp;
        floodStack[sp++] = q;
      }
    }
    return low;
  };

  // Whether the box just pushed to t sits in a frozen 2 x 2 block: four
  // squares of walls and boxes holding a box off its goal, which no push can
  // ever move again.
  const bh = Math.floor(size / w);
  const frozenAt = (occ: Uint8Array, t: number): boolean => {
    const tx = t % w;
    const ty = Math.floor(t / w);
    for (let k = 0; k < 4; k++) {
      const ax = tx - (k & 1);
      const ay = ty - (k >> 1);
      let allBlocked = true;
      let offGoalBox = false;
      for (let cy = ay; cy < ay + 2 && allBlocked; cy++) {
        for (let cx = ax; cx < ax + 2; cx++) {
          if (cx < 0 || cy < 0 || cx >= w || cy >= bh) continue;
          const c = cy * w + cx;
          if (!wall[c] && !occ[c]) {
            allBlocked = false;
            break;
          }
          if (occ[c] && !goalSet[c]) offGoalBox = true;
        }
      }
      if (allBlocked && offGoalBox) return true;
    }
    return false;
  };

  const occ = new Uint8Array(size);
  for (const b of sortedBoxes) occ[b] = 1;
  const keyOf = (bs: number[], low: number): string => low + ':' + bs.join(',');

  // The states, in the order found, and the heap over [f, h, seq, state].
  const stBoxes: number[][] = [];
  const stLow: number[] = [];
  const stG: number[] = [];
  const stParent: number[] = [];
  const stFrom: number[] = [];
  const stTo: number[] = [];
  const best = new Map<string, number>();
  type HeapEntry = [number, number, number, number];
  const heap: HeapEntry[] = [];
  const heapLess = (a: HeapEntry, b: HeapEntry): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: HeapEntry): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i] as HeapEntry, heap[p] as HeapEntry)) break;
      const tmp = heap[i] as HeapEntry;
      heap[i] = heap[p] as HeapEntry;
      heap[p] = tmp;
      i = p;
    }
  };
  const heapPop = (): HeapEntry => {
    const top = heap[0] as HeapEntry;
    const last = heap.pop() as HeapEntry;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1] as HeapEntry, heap[c] as HeapEntry)) c++;
        if (!heapLess(heap[c] as HeapEntry, heap[i] as HeapEntry)) break;
        const tmp = heap[i] as HeapEntry;
        heap[i] = heap[c] as HeapEntry;
        heap[c] = tmp;
        i = c;
      }
    }
    return top;
  };
  let seq = 0;

  const h0 = heuristic(sortedBoxes);
  if (h0 === Infinity) return null;
  const low0 = floodLow(start, occ, seenTmp, ++stampB);
  stBoxes.push(sortedBoxes);
  stLow.push(low0);
  stG.push(0);
  stParent.push(-1);
  stFrom.push(-1);
  stTo.push(-1);
  best.set(keyOf(sortedBoxes, low0), 0);
  heapPush([h0, h0, seq++, 0]);

  while (heap.length > 0) {
    const entry = heapPop();
    const s = entry[3];
    const bs = stBoxes[s] as number[];
    const g = stG[s] as number;
    if (best.get(keyOf(bs, stLow[s] as number)) !== g) continue;
    for (const b of bs) occ[b] = 1;
    const regionStamp = ++stampA;
    floodLow(stLow[s] as number, occ, seen, regionStamp);
    let solved = true;
    for (const b of bs) {
      if (!goalSet[b]) {
        solved = false;
        break;
      }
    }
    if (solved && (exit < 0 || seen[exit] === regionStamp)) {
      const pushes: Push[] = [];
      for (let t = s; t > 0; t = stParent[t] as number) {
        pushes.push({ from: stFrom[t] as number, to: stTo[t] as number });
      }
      pushes.reverse();
      for (const b of bs) occ[b] = 0;
      return pushes;
    }
    for (let bi = 0; bi < bs.length; bi++) {
      const b = bs[bi] as number;
      for (const d of DIRS) {
        const dd = d.dy * w + d.dx;
        const dest = b + dd;
        const pushPos = b - dd;
        if (dest < 0 || dest >= size || pushPos < 0 || pushPos >= size) continue;
        if (!boxCell[dest] || occ[dest] || !live[dest]) continue;
        if (!playerCell[pushPos] || seen[pushPos] !== regionStamp) continue;
        const nb = bs.slice();
        nb[bi] = dest;
        nb.sort((x, y) => x - y);
        occ[b] = 0;
        occ[dest] = 1;
        const frozen = frozenAt(occ, dest);
        let newLow = -1;
        if (!frozen) newLow = floodLow(b, occ, seenTmp, ++stampB);
        occ[dest] = 0;
        occ[b] = 1;
        if (frozen) continue;
        const g2 = g + 1;
        const key = keyOf(nb, newLow);
        const prevBest = best.get(key);
        if (prevBest !== undefined && prevBest <= g2) continue;
        const h2 = heuristic(nb);
        if (h2 === Infinity) continue;
        if (stBoxes.length >= maxStates || o.budget.remaining <= 0) {
          for (const x of bs) occ[x] = 0;
          return null;
        }
        best.set(key, g2);
        stBoxes.push(nb);
        stLow.push(newLow);
        stG.push(g2);
        stParent.push(s);
        stFrom.push(b);
        stTo.push(dest);
        heapPush([g2 + h2, h2, seq++, stBoxes.length - 1]);
        o.budget.remaining--;
      }
    }
    for (const b of bs) occ[b] = 0;
  }
  return null;
}

/** Solve one room on its own board: its squares plus the hallway square at its door. */
function solveRoom(level: Level, room: Room, needExit: boolean, budget: { remaining: number }, astar: boolean): Push[] | null {
  const { size, wall } = level;
  const playerCell = new Uint8Array(size);
  const boxCell = new Uint8Array(size);
  for (const c of room.cells) {
    playerCell[c] = 1;
    boxCell[c] = 1;
  }
  playerCell[room.entry] = 1;
  const boardWall = new Uint8Array(size);
  for (let i = 0; i < size; i++) boardWall[i] = wall[i] || !playerCell[i] ? 1 : 0;
  return searchPush({
    w: level.w,
    size,
    wall: boardWall,
    boxCell,
    playerCell,
    goals: room.goals,
    boxes: room.boxes,
    start: room.entry,
    exit: needExit ? room.door : -1,
    maxStates: astar ? ASTAR_MAX_STATES : BFS_MAX_STATES,
    astar,
    budget,
  });
}

/** Fallback for a level that is no set of rooms: solve the whole board at once. */
function solveWhole(level: Level, budget: { remaining: number }, astar: boolean): Push[] | null {
  const { size, wall } = level;
  const playerCell = new Uint8Array(size);
  const boxCell = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    if (!wall[i]) {
      playerCell[i] = 1;
      boxCell[i] = 1;
    }
  }
  return searchPush({
    w: level.w,
    size,
    wall,
    boxCell,
    playerCell,
    goals: level.goals,
    boxes: level.boxes,
    start: level.player,
    exit: -1,
    maxStates: astar ? ASTAR_MAX_STATES : BFS_MAX_STATES,
    astar,
    budget,
  });
}

/** The shortest walk from one square to another around walls and boxes, in lower LURD letters. */
function walkTo(level: Level, occ: Uint8Array, from: number, to: number): string | null {
  if (from === to) return '';
  const { w, size, wall } = level;
  const prev = new Int32Array(size).fill(-1);
  const how = new Array<string>(size);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi] as number;
    if (c === to) break;
    for (const d of DIRS) {
      const q = c + d.dy * w + d.dx;
      if (q < 0 || q >= size || wall[q] || occ[q] || prev[q] !== -1) continue;
      prev[q] = c;
      how[q] = d.ch;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p] as number) s = (how[p] as string) + s;
  return s;
}

/** Play a push sequence out as moves: walk to each push square, then push. */
function replay(level: Level, pushes: Push[]): string | null {
  const { w, wall, goalSet, boxes } = level;
  const size = level.size;
  const occ = new Uint8Array(size);
  for (const b of boxes) occ[b] = 1;
  let player = level.player;
  let moves = '';
  for (const p of pushes) {
    const d = p.to - p.from;
    let dir = null;
    for (const dd of DIRS) {
      if (dd.dy * w + dd.dx === d) {
        dir = dd;
        break;
      }
    }
    if (dir === null) return null;
    const walk = walkTo(level, occ, player, p.from - d);
    if (walk === null) return null;
    moves += walk + dir.push;
    occ[p.from] = 0;
    occ[p.to] = 1;
    player = p.from;
  }
  for (let i = 0; i < size; i++) {
    if (occ[i] && !goalSet[i]) return null;
  }
  return moves;
}

/** Solve one level: room by room, left to right, a room whose door square is a goal last. */
function solveLevel(level: Level, budget: { remaining: number }): string {
  const rooms = findRooms(level);
  if (rooms !== null) {
    const ordered = [...rooms].sort((a, b) => {
      const ag = level.goalSet[a.door] ? 1 : 0;
      const bg = level.goalSet[b.door] ? 1 : 0;
      return ag - bg || a.entry - b.entry;
    });
    const allPushes: Push[] = [];
    for (let i = 0; i < ordered.length; i++) {
      const room = ordered[i] as Room;
      const needExit = i < ordered.length - 1;
      let pushes = solveRoom(level, room, needExit, budget, true);
      if (pushes === null) pushes = solveRoom(level, room, needExit, budget, false);
      if (pushes === null) return '';
      for (const p of pushes) allPushes.push(p);
    }
    const moves = replay(level, allPushes);
    return moves === null ? '' : moves;
  }
  let pushes = solveWhole(level, budget, true);
  if (pushes === null) pushes = solveWhole(level, budget, false);
  if (pushes === null) return '';
  const moves = replay(level, pushes);
  return moves === null ? '' : moves;
}

const budget = { remaining: TOTAL_MAX_STATES };
for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    const level = parseLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
    moves = solveLevel(level, budget);
  } catch {
    moves = '';
  }
  if (moves.length > 65000) moves = '';
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
