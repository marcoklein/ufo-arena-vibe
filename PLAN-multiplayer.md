# Plan: co-op multiplayer (WebRTC or WebSocket), single player untouched

A plan for turning UFO Arena into a game you can play with friends — over a WebSocket
server *or* peer-to-peer over WebRTC — without giving up "single player, no server,
no build step".

**Verdict up front:** this is very doable, and the code is in unusually good shape for
it. Roughly **7–11 days** for a solid co-op over the internet, **3–4 days** for two
players on one machine with a genuinely shared world, and **½–1 day** for a cheap
"ghost" co-op. The work is mostly a *refactor of the seam between simulation and
view*, not netcode cleverness.

---

## 1. What the code already gives you

These are facts from the current source, and they remove most of the usual work:

| | |
| --- | --- |
| **No `Math.random` anywhere** in `main.js`, `maze.js`, `themes.js`, `audio.js`, `save.js`. All randomness is `makeRng(seed)` (`maze.js:15`). | Determinism is already the house style. |
| **A level is a pure function of its number.** `startLevel(n)` builds `createLevel({ seed: 1000 + n, … })` (`main.js:3110`), `decor = makeRng(777 + n)` (`3107`), `rng = makeRng(5000 + n)` (`3175`), then `buildWorld(level)`. | Every client that starts level 7 gets the *same* maze, props and monster placement. The "shared map" problem is already solved. |
| **Simulation state is logical, the meshes are driven one-way.** Enemies carry `x, z, hp, speed, state, fireT…` (`main.js:1482`); the step functions do `e.group.position.set(e.x, …, e.z)` (`2321`, `2350`, `3854`). Bullets are plain `{x, z, vx, vz, life, dmg, level}` (`updateBullets`, `3891`). Nothing in the gameplay code reads `ufo.position`. | Replication means serialising small numbers, not scene graphs. |
| **The game already runs headless.** `smoke/loader.mjs` + `smoke/three-mock.js` boot the real `main.js` in Node with `HARNESS.dt = 1/60` and a stepped `HARNESS.loop`. | **The multiplayer server can be the game itself.** No second implementation of the rules to keep in sync — a huge saving. |
| **`window.UFO`** is a debug handle with `start`, `move`, `aim`, `damage`, `kill`, `pods` of state. | A ready-made seam for tests *and* for driving a remote craft. |
| **The simulation is ~800 of 4306 lines**: `step` (47), `updateEnemies` (95), `updateBullets` (119), `updateRifts` (48), `stepShade` (144), `stepWarden` (71), `stepMine` (62), `updateLift` (147), `checkExit` (12), `updateUfo` (53). The rest is world building, view, HUD, audio. | The part that has to change is bounded and known. |
| **Monsters never change properties per level** (a design rule the tests enforce). | Balance is identical for every player, and a snapshot is tiny: ~54 monsters max. |

## 2. What actually blocks it

Six concrete things, in the order they matter:

1. **One craft, as module-level singletons.** `pos`, `yaw`, `hp`, `lift`, `shoveX`,
   `shoveZ`, `falling`, `fireT`, `hurtT`, `bank`, `muzzleT`, plus `GAME.kills`,
   `state`, `clearedT` (`main.js:2929`). Counted: 71 uses of `pos.`, 16 of `yaw`, 26
   of `hp`. → needs a `craft` object, then a `crafts[]` array.
2. **The simulation reads the keyboard directly.** `held("KeyW", "w", "ArrowUp")` and
   `mouseDown` inside `step` (`3757`), `tryFire` (`3514`). → needs an input struct
   passed in, one per craft, per tick.
3. **Variable timestep.** `const dt = Math.min(clock.getDelta(), 0.05)` in the
   animation loop. Two clients integrate different dt's → different worlds. → needs a
   fixed tick (accumulator), which the test harness already fakes.
4. **One RNG stream for build *and* play.** `decor` is seeded per level (`3107`) and
   consumed while building, but also at runtime: warden wind-up (`2469`), rift spawn
   delay (`2648`), spawn type (`2657`), spitter fire timing (`3833`), sparks (`2778`),
   rift motes (`2560`). Runtime consumption depends on frame order. → split into a
   build stream (deterministic, identical everywhere) and a *sim* stream reseeded per
   tick, with visuals on their own stream.
5. **Side effects inside the simulation.** `gameAudio.sfx("hit", …)` is called from
   `updateBullets`, mines and enemies; the sim also writes HUD text and mesh
   transforms. → the sim should *emit events* (`{kind:"hit", x, z}`) that the view
   turns into sound and pixels. (Not strictly required for correctness, but it is
   what makes a server-side sim sane.)
6. **Run state is global.** `state`, `GAME.level`, `GAME.kills`, `clearedT`, the
   overlay functions (`3030`–`3096`). → has to become "session state" with per-craft
   sub-state (alive, at the exit, …).

Not blockers, checked: `later()` (`1651`) is a purely visual fx queue (3 call sites),
and `spawnEnemy`/`killEnemy`/`detonateMine` are already called from the sim with plain
arguments.

## 3. Architecture

**Host-authoritative with snapshots — not deterministic lockstep.**

Lockstep (everyone simulates, only inputs are exchanged) is tempting because the maps
are already deterministic, but it requires *bit-exact* floating point across clients.
`Math.hypot`, `Math.sin`, `Math.exp` are not guaranteed to agree between V8,
SpiderMonkey and JavaScriptCore. Two Chrome windows would very likely stay in sync;
a Chrome + Safari game would eventually drift, and the failure mode is a silent
divergence that is miserable to debug. Snapshot replication makes the whole class of
problem disappear.

So: **one authority runs the simulation** (a server, or the host's browser), everyone
else sends input and draws what it is told. Determinism then only has to hold for
*level generation* — and even that gets a cheap grid checksum so a mismatch is loud
instead of mysterious.

```
                ┌───────────────────────────────┐
   input 30 Hz  │        authority sim          │  snapshots 15–20 Hz
  ┌────────────►│  (Node server, or host's      ├─────────────┐
  │             │   browser; the real main.js   │             ▼
┌─┴──────┐      │   under the three.js mock)    │      ┌──────────────┐
│ client │      └───────────────────────────────┘      │   clients    │
│  craft │◄──────── own-craft correction ──────────────│ predict self │
└────────┘                                             │ interpolate  │
                                                       │ others       │
                                                       └──────────────┘
```

**Transport-agnostic message layer.** The same protocol runs over:

| Transport | Who simulates | Needs | When |
| --- | --- | --- | --- |
| `local` | this browser | nothing | **single player — the default, no sockets, no net code loaded** |
| `ws` | a Node server (imports the headless game) | one small process | easiest to get right, no NAT issues; Dokku already exists in the infra |
| `rtc` | the host's browser | signalling only + STUN (TURN for bad NAT) | no server cost, lowest latency, more debugging |

The game only ever talks to a `Transport` interface (`send`, `onMessage`, `close`).
Single player uses the `local` transport, so the published Pages build keeps working
with no server at all — and the net code is only fetched when someone clicks *Co-op*.

## 4. Protocol (sketch)

```js
// client → authority
{t:"hello", name, ver}                            // ver = save/schema version
{t:"input", seq, tick, thrust, turn, fire}        // 30 Hz, small
{t:"ready"}                                        // level start / restart handshake

// authority → client
{t:"welcome", id, tick, level, seed, players:[…]}
{t:"snap", tick, level, kills, closed,
   crafts:[{id, x, z, yaw, hp, lift, falling, dead}],
   enemies:[{i, t, x, z, st, hp}],                // i = stable index, t = type
   bullets:[{x, z, vx, vz, lvl}],
   rifts:[{i, x, z, hp}]}
{t:"event", kind, x, z, a, b}                     // sfx/boom the client should play
{t:"level", n, seed, grid}                        // advance (grid = optional checksum)
```

Decisions baked in, all chosen for simplicity at this scale:

- **Full snapshots, no delta encoding.** ~54 monsters, ~20 bullets → a few hundred
  bytes at 20 Hz ≈ 10–15 kB/s per client. Delta compression is a later micro-optimisation.
- **Firing is an intent.** The authority spawns the bullet from the authoritative
  craft position, so nobody can shoot from a place they are not.
- **Monsters target the nearest craft** — the only gameplay change needed in the AI,
  and it is small (the aggro checks already take a position).
- **No collision between crafts** (they pass through each other). Bumping adds
  netcode jank for no fun.
- **Other crafts are interpolated** between snapshots; your own craft is predicted
  locally and corrected (phase 5 — before that, a 60–100 ms input delay is perfectly
  playable in a maze where you drive 16 units/s ≈ 0.4 cells per 100 ms).

## 5. Phases (each one leaves single player working)

| # | What | Days | Risk | Test gate |
| --- | --- | --- | --- | --- |
| **P0** | **The seam.** Fixed-tick accumulator; `craft` object instead of `pos`/`yaw`/`hp`/…; input struct instead of `held()` inside the sim; split the RNG streams (build / sim / fx); sim emits sound+fx events instead of calling them; run state in a `session` object. Pure refactor, no visible change. | 1–1.5 | med | the existing 244 maze + 368 gameplay checks stay green, unchanged |
| **P1** | **Two-client headless harness.** `smoke/net.mjs`: boot the game twice in one process, feed both the same level and an input script, compare a per-tick state hash. This is the divergence alarm. | 0.5 | low | hash equality for 60 s of scripted play |
| **P2** | **Local co-op, no network.** `crafts[]` with a second input source (second key set or a gamepad), shared monsters, per-craft hp/death, camera follows your own craft. Proves the "world with N crafts" model with zero netcode. | 1–2 | med | two crafts both shoot the same monster; kills attributed |
| **P3** | **WebSocket authority.** `server/server.mjs` = the headless game + a socket relay; client sends input, applies snapshots, interpolates. Room codes, 2–4 players. | 2–3 | med | a kill by player B appears on A's screen; both reach the exit |
| **P4** | **Co-op rules.** Level advance, death, restarts, shared kills, save semantics, pause, late join, drop/reconnect. | 1–2 | low | drop one client mid-level, the other plays on; reconnect resumes |
| **P5** | **Lag polish.** Own-craft prediction + reconciliation, snapshot interpolation tuning, lag compensation for hits, jitter buffer. | 1–2 | med | playable with 120 ms RTT and 2 % loss (simulated) |
| **P6** | **WebRTC transport.** The same protocol over a datachannel, host-authoritative. Signalling via a tiny relay (or manual offer/answer copy-paste to start), STUN, TURN as fallback. | 1–2 | high | a game between two machines on different networks |

**Totals:** P0–P4 (internet co-op over WebSocket) ≈ **5.5–8.5 days**; P0–P6 ≈ **7–11
days**. P0–P2 alone (**3–4 days**) already gives a two-player shared world on one
machine, which is the honest way to find out whether the co-op is *fun* before
spending days on sockets.

**The cheap alternative, for comparison:** "ghost co-op" — each player simulates
their own world, and only craft positions are exchanged over a datachannel. You see
and race each other, but you cannot shoot each other's monsters, cannot share a
spawner, and both players' levels drift apart. **½–1 day.** It is not really co-op;
worth knowing it exists, not worth building.

## 6. Open questions (need your call)

1. **What is co-op to you?** A shared world (real co-op: shoot the same monsters,
   split up, cover each other) or just racing the same maze? — everything above
   assumes shared; racing is cheaper.
2. **Which transport first?** I recommend **WebSocket** first (simplest to get right,
   no NAT/TURN pain, and Dokku hosting already exists in your infra), then WebRTC as a
   transport swap once the protocol is proven. Or WebRTC first if you specifically
   want "no server, ever".
3. **Level advance:** everyone alive at the exit, or the first one there advances
   everyone? (Recommend: all — it is co-op, and it keeps people together.)
4. **Death:** respawn at the level start after a few seconds, spectate until the level
   is cleared, or run over for everyone?
5. **Save/progress in co-op:** each player keeps their own best level locally, or does
   the session share the highest reached?
6. **Friendly fire:** do mines and warden blasts hurt your friends? (Fun, but it needs
   a decision on griefing.)
7. **Where does it run?** Dokku (existing infra), a small VPS, or peer-to-peer only?
   And what is the target: 2–4 friends, or something more public?

## 7. What I would *not* do

- **Deterministic lockstep** — float differences between browsers, silent divergence.
- **A separate server implementation of the rules** — the rules already run headless;
  duplicating them guarantees they drift.
- **Delta compression / interest management / a physics engine** — nothing here needs
  them at 4 players and 54 monsters.
- **Making single player depend on the net code** — it must keep working from a static
  host with no server, exactly as today.

## 8. Risks

- **The P0 refactor touches ~800 lines of the sim.** Mitigation: it is
  behaviour-preserving by construction, and the two existing suites (612 checks) plus
  the level-1-to-20 sweep are the safety net; the work lands in small commits.
- **WebRTC NAT traversal** is the classic time sink. Mitigation: it is a transport
  swap behind an interface, and WebSocket proves the game logic first.
- **Server ops.** A persistent process to host and watch. Dokku path exists; the
  process is small (one Node file + the game).
- **Cross-browser divergence in level generation** is unlikely (seeded, integer-grid)
  but not impossible; the grid checksum makes it a clear error instead of a weird bug.
- **Scope creep** — mobile/touch input, matchmaking, accounts. Out of scope until
  asked for.
