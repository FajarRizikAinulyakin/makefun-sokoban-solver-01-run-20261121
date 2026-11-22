# Sokoban solver — make.fun sokoban-solver-01-run-20261121

A push-optimal Sokoban solver: one run answers all 5 instances of a set in
as few pushes as possible.

## How it works

Every level this competition draws is a one-square-wide hallway with one to
four rooms off it. A box pushed out of its room can never be pushed back, so
a level's push-optimal count is the sum of its rooms' optima, and each room
can be solved on its own:

1. **Split into rooms.** The floor is cut along the player's row (the
   hallway); each connected part holding boxes is a room, with one door onto
   the hallway.
2. **Solve each room in the fewest pushes.** A search over pushes, not
   steps: a state is the boxes' squares plus the region the player can reach
   (named by its lowest square). It is A* with the cheapest box-to-goal
   matching by floor distance as its estimate, which no push sequence can
   beat, so the first solved state is push-optimal. A breadth-first search
   over the same states is the fallback. States are pruned when a box sits
   on a square no push can ever bring to a goal (pulled back from the goals)
   or inside a frozen 2 x 2 block of walls and boxes. A room that is not the
   last is only accepted solved when the player can still reach its door,
   and a room whose door square is itself a goal is solved last, since the
   box that ends there seals the room.
3. **Stitch the rooms together.** The player's walks between pushes and
   between rooms are shortest paths around walls and boxes, found by
   breadth-first search on the full level.

The search is budgeted by work (states searched), never by the wall clock,
and every tie breaks in a fixed order, so two runs write byte-identical
outputs. Only Node's built-in modules are used.

## Run it

```sh
node main.ts
```

It reads `/input/<id>/level.txt` and writes `/output/<id>/solution.txt`
(`MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` override the two directories,
as in the kit's starter). Locally, on the kit's practice set:

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Practice score

| instance | pushes | optimal P* | points |
|----------|--------|------------|--------|
| i001     | 13     | 13         | 1,000  |
| i002     | 16     | 16         | 1,000  |
| i003     | 29     | 29         | 1,000  |
| i004     | 47     | 47         | 1,000  |
| i005     | 60     | 60         | 1,000  |

Score **1,000,000 / 1,000,000** on the practice set (kit scorer), in ~0.4 s
for the whole set — far inside the 60 s wall budget. The house baseline
(plain-astar 1.0.0) scores 200,000 on the same set: it solves only i001 and
leaves the other four unanswered.

Robustness: on 14 further sets freshly drawn with the kit's own generator
from other seeds, the solver also scored 1,000,000 on every set, every
instance at exactly P*, slowest set 0.45 s, outputs byte-identical across
two runs.

## Files

- `main.ts` — the solver (Node 22, erasable TypeScript; plain JavaScript
  would run as it is)
- `LICENSE` — MIT
