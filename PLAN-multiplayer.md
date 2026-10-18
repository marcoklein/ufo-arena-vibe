# Plan: co-op multiplayer — walking the maze together

A plan for turning UFO Arena into a game you can play with friends over a WebSocket
server *or* peer-to-peer over WebRTC — without giving up "single player, no server,
no build step". The goal for the first version is not deathmatch and not a race: it
is **two to four saucers walking the same maze together**.

**Verdict:** very doable, and the code is in unusually good shape for it.
**Playable co-op over WebSocket: ~8–11 days.** Two players on one machine with the
real rules: **~4 days**. Adding lag polish and the WebRTC transport on top: **10–14
days**. The work is mostly a *refactor of the seam between simulation and view*, plus
one pass of co-op rules — not netcode cleverness.

---

## 1. What the code already gives you

Facts from the current source, and they remove most of the usual work:

| | |
| --- | --- |
| **No `Math.random` anywhere** in `main.js`, `maze.js`, `themes.js`, `audio.js`, `save.js`. All randomness is `makeRng(seed)` (`maze.js:15`). | Determinism is already the house style. |
| **A level is a pure function of its number.** `startLevel(n)` builds `createLevel({ seed: 1000 + n, … })` (`main.js:3110`), `decor = makeRng(777 + n)` (`3107`), `rng = makeRng(5000 + n)` (`3175`), then `buildWorld(level)`. | Every client that starts level 7 gets the *same* maze, props and monster placement. The "shared map" problem is already solved. |
| **Simulation state is logical, the meshes are driven one-way.** Enemies carry `x, z, hp, speed, state, fireT, homeX/homeZ, leash…` (`main.js:1482`); the step functions do `e.group.position.set(e.x, …, e.z)` (`2321`, `2350`, `3854`). Bullets are plain `{x, z, vx, vz, life, dmg, level}` (`3891`). Nothing in the gameplay code reads `ufo.position`. | Replication means serialising small numbers, not scene graphs. |
| **Every monster step starts with the same two lines**: `const dx = pos.x - e.x; const dz = pos.z - e.z;` — in `stepShade` (`2305`), `stepWarden` (`2450`), `stepMine` (`3451`), and the roamer code in `updateEnemies`. | "Target a craft instead of *the* craft" is a mechanical change, not a redesign. |
| **The game already runs headless.** `smoke/loader.mjs` + `smoke/three-mock.js` boot the real `main.js` in Node with `HARNESS.dt = 1/60` and a stepped `HARNESS.loop`. | **The multiplayer server can be the game itself.** No second implementation of the rules to keep in sync — a huge saving. |
| **`window.UFO`** is a debug handle (`start`, `move`, `aim`, `damage`, `kill`, state getters). | A ready-made seam for tests *and* for driving a remote craft. |
| **The simulation is ~800 of 4306 lines**: `step` (47), `updateEnemies` (95), `updateBullets` (119), `updateRifts` (48), `stepShade` (144), `stepWarden` (71), `stepMine` (62), `updateLift` (147), `checkExit` (12), `updateUfo` (53). | The part that has to change is bounded and known. |
| **The generator already guarantees open floor around the start.** Nothing is built on, or right beside, the start cell (the fix from the last round). | Four saucers can spawn in a ring at the start on **every** level without ever being boxed in. That work pays off here. |
| **Sound is positional already**: `gameAudio.sfx("hit", { x, z })` and `gameAudio.listener(pos.x, pos.z, yaw)`. | A teammate's shot 20 units away is audible as *there*, with no audio work at all. |
| **The lamp is a per-craft object** (`playerLight`, `main.js:543`). | Each saucer brings its own light — see §5.1, this is the whole co-op feeling, for free. |
| **Monsters never change properties per level** (a rule the tests enforce). | Balance is identical for everyone, and a snapshot is tiny: ~54 monsters max. |

## 2. What actually blocks it

Six concrete things, in the order they matter:

1. **One craft, as module-level singletons.** `pos`, `yaw`, `hp`, `lift`, `shoveX`,
   `shoveZ`, `falling`, `fireT`, `hurtT`, `bank`, `muzzleT`, `bank`, plus `GAME.kills`,
   `state`, `clearedT` (`main.js:2929`). Counted: 71 uses of `pos.`, 16 of `yaw`, 26 of
   `hp`. → needs a `craft` object, then a `crafts[]` array.
2. **The simulation reads the keyboard directly.** `held("KeyW", "w", "ArrowUp")` and
   `mouseDown` inside `step` (`3757`), `tryFire` (`3514`). → needs an input struct per
   craft per tick.
3. **Variable timestep.** `const dt = Math.min(clock.getDelta(), 0.05)` in the
   animation loop. Two clients integrate different dt's → different worlds. → needs a
   fixed tick (accumulator); the test harness already fakes exactly this.
4. **One RNG stream for build *and* play.** `decor` is seeded per level (`3107`) and
   consumed while building, but also at runtime: warden wind-up (`2469`), rift spawn
   delay (`2648`), spawn type (`2657`), spitter fire timing (`3833`), sparks (`2778`),
   rift motes (`2560`). Runtime consumption depends on frame order. → split into a
   build stream (identical everywhere) and a sim stream reseeded per tick, with
   visuals on their own stream.
5. **Side effects inside the simulation.** `gameAudio.sfx(…)` is called from
   `updateBullets`, mines and enemies; the sim also writes HUD text and mesh
   transforms. → the sim should *emit events* (`{kind:"hit", x, z}`) that the view
   turns into sound and pixels.
6. **Run state is global.** `state`, `GAME.level`, `GAME.kills`, `clearedT`, and the
   overlay functions (`3030`–`3096`). In co-op the world must keep running while one
   player is down, so death can no longer be a global state. → session state with
   per-craft sub-state.

Not blockers, checked: `later()` (`1651`) is a purely visual fx queue (3 call sites);
`spawnEnemy` / `killEnemy` / `detonateMine` already take plain arguments.

## 3. Architecture

**Host-authoritative with snapshots — not deterministic lockstep.**

Lockstep (everyone simulates, only inputs are exchanged) is tempting because the maps
are already deterministic, but it requires *bit-exact* floating point across clients.
`Math.hypot`, `Math.sin`, `Math.exp` are not guaranteed to agree between V8,
SpiderMonkey and JavaScriptCore. Two Chrome windows would very likely stay in sync; a
Chrome + Safari game would drift eventually — and the failure mode is silent
divergence, which is miserable to debug. Snapshots make the whole class of problem
disappear.

So: **one authority runs the simulation** (a server, or the host's browser); everyone
else sends input and draws what it is told. Determinism then only has to hold for
*level generation*, which gets a cheap grid checksum so a mismatch is loud instead of
mysterious.

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

### 3.1 Recommendation: **WebSocket first, WebRTC as a later transport swap**

I would build the first playable co-op on a **WebSocket server**, and treat WebRTC as
a second transport plugged into the same message layer once the rules feel right.

Why WebSocket wins *for this game*:

- **NAT and TURN disappear.** WebRTC needs signalling, STUN, and — on hotel, campus or
  company networks — a TURN relay, which is bandwidth you pay for and one more thing
  to run. A WebSocket just works from anywhere.
- **The authority is a plain Node process, and this game already runs headless.** The
  server is a thin wrapper around the real `main.js` (see §1). No new rules code, no
  "host's browser" fragility (a backgrounded tab, a sleeping laptop, or the host's
  uplink capping everyone).
- **Debuggability.** One process to log, replay and test. The co-op tests can run two
  headless clients in CI **without launching a browser at all** — which is also true
  for the divergence checks in §8.
- **Latency is a non-issue here.** A WebSocket through a server adds one hop: ~10–40 ms
  in Europe. You drive at 16 units/s in a maze where the exit is a pad you must *stand
  on*. WebRTC's latency advantage matters for twitch shooters; not for this.
- **Cost and ops are near zero.** A Node process for 2–4 players is a few MB of RAM
  and negligible CPU — it can live on the Dokku server that already exists in the
  infra. Even a €4 VPS would do.
- **The escape hatch stays open.** The protocol is transport-agnostic. If you later
  want "no server, ever", the same messages go over a datachannel with the host's
  browser as the authority — and because the authority code *is* the game, that is a
  small change, not a rewrite.

When WebRTC would be the better call: if you specifically want LAN play or
serverless/p2p (no hosting, no cost, no ops), or competitive latency later. It is
+1–2 days and the riskiest single piece (NAT traversal), which is exactly why I would
prove the game logic first and swap transports afterwards.

### 3.2 Single player stays exactly as it is

The game only ever talks to a `Transport` interface (`send`, `onMessage`, `close`):

| Transport | Who simulates | Needs | Used by |
| --- | --- | --- | --- |
| `local` | this browser | nothing | **single player — the default; no sockets, no net code fetched** |
| `ws` | Node server (the headless game) | one small process | first co-op release |
| `rtc` | the host's browser | signalling + STUN (TURN fallback) | later option |

`net/*.js` is imported lazily, only when someone clicks *Co-op* on the start screen.
The published GitHub Pages build keeps working with no server at all.

## 4. Protocol (sketch)

```js
// client → authority
{t:"hello", name, ver}                             // ver = save/schema version
{t:"input", seq, tick, thrust, turn, fire, lift, revive}   // 30 Hz, small
{t:"ready", level}                                  // lobby handshake

// authority → client
{t:"welcome", id, tick, level, seed, players:[{id, name, color, hp, down}], mods}
{t:"snap", tick, level, phase, kills,
   crafts:[{id, x, z, yaw, hp, lift, falling, down, reviveT}],
   enemies:[{i, t, x, z, st, hp, tgt}],            // i = stable index, t = type, tgt = target id
   bullets:[{x, z, vx, vz, lvl}],
   rifts:[{i, x, z, hp}],
   gate:[id, …]}                                    // who is standing on the exit pad
{t:"event", kind, x, z, a, b, id}                   // sfx/boom the client should play
{t:"level", n, seed, phase}                         // advance / countdown / cleared
{t:"bye", id}                                       // a player dropped
```

Decisions baked in, all chosen for simplicity at this scale:

- **Full snapshots, no delta encoding.** ≤54 monsters, ~20 bullets → a few hundred
  bytes at 20 Hz ≈ 10–15 kB/s per client. Delta compression is a later micro-optimisation.
- **Firing is an intent.** The authority spawns the bullet from the authoritative craft
  position, so nobody shoots from a place they are not.
- **Replication of monsters includes their current target** (`tgt`), which makes the
  aggro state visible and testable, and lets a client draw "it is after you".
- **Other crafts are interpolated** between snapshots; your own is predicted locally
  and corrected (P5). Before that, a 60–100 ms input delay is perfectly playable: at
  16 units/s that is ≈0.4 cells.
- **No collision between crafts** (they pass through each other). Bumping adds netcode
  jank for no fun.

## 5. Co-op rules: what changes when you walk the maze together

### 5.1 The design core: the dark is the game, so a teammate is a beacon

This game is about seeing nothing. Put a second saucer in it and you get a mechanic
for free: **each craft carries its own lamp** (`playerLight`), so a friend's light
shows up in the black long before you can see them — around a corner, across a hall,
through a doorway. Nobody had to design that; it falls out of the existing lighting.

That single fact decides the co-op philosophy: **do not force the group together
mechanically** (no tether, no leash, no shared health pool). Give them reasons to
*choose* to stay close:

1. the exit only opens when everyone is standing on it (the gathering gate),
2. a destroyed saucer can only be brought back by a teammate who comes to it (revive),
3. monsters now pick a target and *hold* it, so pulling one off a friend is a real,
   learnable skill.

Everything else in this section follows from those three.

### 5.2 Rule by rule

| | Today (single player) | In co-op | Why |
| --- | --- | --- | --- |
| **Exit** | `checkExit()`: you are within `CELL*0.5` of the exit on the floor (`lift <= 0.05`) → `state = "cleared"` → next level after 1.7 s | The exit is a **gathering gate**: the level advances when **every living craft** is on the pad. HUD shows `2/3 at the gate`; the pad lights up per player; the exit column pulses while waiting. Dead/downed players never block it. | This is the rule that makes it co-op instead of a race, without a tether. |
| **Death** | `killPlayer()` → `state = "dead"` → overlay "GAME OVER … R restarts level N" | **Downed, not over.** A destroyed saucer leaves a burning wreck with a beacon. A teammate who comes within ~3 units and holds station for **1.5 s** revives you (full HP, 2 s invulnerability). If nobody comes within **20 s**, you respawn at the start pad. The session never stops. | One player's mistake must not restart the level for everyone — and the revive is the strongest "stay together" incentive there is. |
| **Monsters** | Every step function targets `pos` directly | Each monster picks the **nearest living craft** and **locks** it for 1.5–2 s (or until the target is down/out of leash). Ties broken by lowest player id, so the sim stays deterministic. Warden `craftLevel()` and mine `airborne()` become per-craft. | Aggro becomes a co-op tool: one player pulls, the other flanks. Locking avoids the "randomly switching target" feel. |
| **Damage** | `hurtPlayer(dmg)` on the global craft | Per craft, identical numbers. **Friendly fire off by default**: a teammate's mine or a warden blast aimed at a friend does **not** hurt you (blasts still hurt monsters, and still hurt the shooter). | You will be within blast radius of each other constantly; accidental damage would be pure frustration, not tension. |
| **Hover / falling / lift** | Global `lift`, `hover`, `falling` | Per craft, unchanged otherwise. Craft may be on different storeys (one scouting up top) — the exit gate regroups them. | The two-level layout becomes a genuine co-op tactic. |
| **Kills / score** | `GAME.kills` global, shown in the HUD | Kills attributed to the craft that landed the shot. HUD shows **team kills** plus your own; the level card shows the per-player breakdown. | Team score keeps it co-op; per-player detail is the fun part. |
| **Spawning** | Craft at `level.start`; monsters placed "far from `pos`"; rifts spawn "far from `pos`" | Craft spawn in a **ring on the start pad** (start cell + its guaranteed-open neighbours — already true for every level). Monster/rift placement uses the **start pad position** instead of `pos` (identical to today at level start) or the distance to the *nearest* craft for rift respawns. | Prevents stacking, keeps level-start placement identical to single player. |
| **Monster count** | `levelEnemies(n)` etc., no scaling | **No per-player scaling.** Same monsters, now with several targets. | Consistent with "difficulty must not be more and more and more". Two lamps do make the maze brighter, so the group *chooses* difficulty instead — see below. |
| **Difficulty** | Fixed per level | **Host-chosen session modifiers**: `Normal`, `Darker` (lamp reach and fog pulled in), `Fragile` (no respawn — down means out until the level is cleared), `Swarm` (×1.5 monsters). | Creative, player-chosen difficulty instead of automatic escalation. |
| **Level start** | Level builds, you drive | **Lobby → ready-up → 3-2-1 countdown**, then the level starts for everyone. Level intro tip shown to all. | Nobody is left standing still while the others have already driven off. |
| **Pause** | `state` machine can pause | **No pause in a session.** Host can abandon the session; a player who leaves despawns (their craft disappears, the gate stops counting them). | You cannot pause a shared world. |
| **Late join** | — | Allowed between levels via the lobby; during a level a late joiner **beams in next to the nearest living teammate** (reusing the respawn mechanic). | Reuse, not new rules. |
| **Save** | `{version, best, last, kills}` in localStorage | Host picks the level (continue their best / new run / pick a level). Guests record the session level they cleared locally. | Keeps the existing save model; nobody loses their own progress. |
| **HUD** | Level, kills, monsters, spawners, HP, hover | Plus: teammate list with **HP, down/revive timer, and a direction+distance arrow** at the screen edge; per-player hull colour; `N/M at the gate` while waiting at the exit. | In the dark you *will* get separated; this is the one HUD addition that is not optional. |
| **Level advance** | Automatic after 1.7 s | Still one shared `cleared` state: the whole group advances together (no per-player level). | Keeps the group in the same maze. |

### 5.3 Knobs worth deciding now (they are cheap now, expensive later)

- **Revive vs plain respawn**: revive (recommended, more co-op) or just a 5 s respawn
  at the start pad (simpler, and easier for a first slice).
- **Friendly fire**: off (recommended) / on / half damage.
- **Session level**: host's best / lowest of the group / explicit level picker.
- **Modifiers**: which set ships in v1 (recommend `Normal` + `Darker` + `Fragile`).
- **Max players**: 4 is a good target (spawn ring, 4 lamps, monster targeting reads
  fine). More than 4 needs a different spawn rule and a brighter maze.

## 6. What the rules mean in the code

Mechanical, grounded in the current functions:

| Change | Where |
| --- | --- |
| `craft` object instead of singletons, then `crafts[]` | `pos`, `yaw`, `hp`, `lift`, `liftUp`, `shoveX/Z`, `falling`, `fireT`, `hurtT`, `bank`, `muzzleT`, `elapsed`, `charge`, `overHole()` → `craft.*` |
| Input per craft | `held()` / `mouseDown` reads in `step` (`3757`), `tryFire` (`3514`) → `inputOf(craft)` |
| Fixed tick | the `setAnimationLoop` body → accumulator + `TICK = 1/60`; the view interpolates |
| RNG split | `decor` → `decorBuild` (build only), `simRng` (reseeded per tick), `fxRng` (visuals). Touches `2469`, `2648`, `2657`, `3833` (sim) and `2560`, `2778` (visual) |
| Sim emits events | `gameAudio.sfx(...)` inside `updateBullets`/`stepMine`/`stepShade`/`stepWarden` → `emit({kind, x, z, id})`; the view plays it (positional audio already works) |
| Target per monster | `stepShade`/`stepWarden`/`stepMine`/roamer code: `pos` → `tgt` (a craft), plus `e.tgtId`, `e.retargetT`; `craftLevel()` → `craftLevelOf(tgt)`, `airborne()` → `airborneOf(tgt)` |
| Per-craft damage | `hurtPlayer(dmg)` → `hurtCraft(craft, dmg)`; `blastDamage(d)` applied per craft; `detonateMine` credits and hurts per craft |
| Down / revive / respawn | `killPlayer()` → `downCraft(craft)`; the global `state = "dead"` path stays **only** for the single-player case (or when all crafts are down) |
| Exit gate | `checkExit()` → `gateOpen()`: every living craft within `CELL*0.5` and `lift <= 0.05`; sets the shared `cleared` state |
| Spawn ring | `startLevel(n)` — craft spawn on the start cell + its guaranteed-open neighbours |
| Team HUD + colours | `updateHud()`; hull material per player (`buildCraft` once per craft, tinted) |
| Lobby / ready / countdown | `showMenu()` (`3043`), `chooseStart()` (`3062`), `startLevel()` (`3097`); new `index.html` UI (Host / Join, room code, player list) |
| Save | `save.js` (unchanged model); guests write `reachLevel(sessionLevel)` |

**Single-player guarantee.** With `crafts.length === 1` the new code paths collapse to
the old ones: nearest craft = the craft, retargeting never fires, friendly fire has no
target, the exit gate is a one-craft check, and "all crafts down" is the existing
`GAME OVER`. The 244 maze + 368 gameplay checks must stay **unchanged and green** after
every step — that is the regression gate for the whole refactor.

## 7. Phases

| # | What | Days | Risk | Gate |
| --- | --- | --- | --- | --- |
| **P0** | **The seam.** Fixed tick; `craft` object; input struct; RNG split (build/sim/fx); sim emits sound+fx events; session state instead of global run state. Pure refactor, nothing visible changes. | 1.5–2 | med | the existing 612 checks stay green, unchanged |
| **P1** | **Two-craft headless harness.** `smoke/net.mjs`: boot the game with two crafts in one process, same level, scripted input, compare a per-tick state hash. The divergence alarm. | 0.5 | low | hash equality for 60 s of scripted play |
| **P2** | **Local co-op, no network.** `crafts[]`, second input source (second key set / gamepad), shared monsters, per-craft hp/down, camera framing. Proves the model. | 1.5–2 | med | two crafts shoot the same monster; kills attributed correctly |
| **P3** | **WebSocket authority — "slice A".** `server/server.mjs` = the headless game + socket relay. Client sends input, applies snapshots, interpolates. Room codes. Still the *old* rules (first at the exit advances, death = restart). | 2–3 | med | two browser clients, one level, a kill on one screen appears on the other |
| **P4** | **Co-op rules — "slice B".** Gathering gate, down/revive/respawn, monster target locking, no friendly fire, team HUD + colours + teammate arrows, lobby/ready/countdown, modifiers. | 2.5–3.5 | med | §8 co-op suite green; 4 players on one level |
| **P5** | **Lag polish.** Own-craft prediction + reconciliation, interpolation tuning, jitter buffer, reconnect. | 1–2 | med | playable at 120 ms RTT, 2 % loss |
| **P6** | **WebRTC transport.** Same protocol over a datachannel, host-authoritative; signalling relay, STUN, TURN fallback. | 1–2 | high | a game between two machines on different networks |

**Totals.** P0–P4 (playable co-op over the internet) ≈ **8–11 days**. P0–P6 ≈ **10–14
days**. P0–P2 (two players, one machine, real rules) ≈ **3.5–4.5 days** — the cheapest
honest way to find out whether the co-op is *fun* before spending days on sockets.

## 8. Co-op test plan

Everything below runs headless (no browser) on top of the existing mock + loader:

- **Exit gate**: one craft on the pad → no advance; both → advance. Downed craft never
  blocks. Craft hovering (`lift > 0.05`) does not count.
- **Down & revive**: a teammate within range for 1.5 s → back at full HP with
  invulnerability; nobody comes within 20 s → respawn at the start pad.
- **Friendly fire off**: a mine/blast next to a teammate → 0 HP lost; the same blast
  still kills a monster next to it.
- **Target locking**: two crafts, monster picks the nearest, holds it for the lock
  window, switches when the target goes down; equal distance → lowest id (so the same
  input script produces the same hash twice).
- **Attribution**: the craft that fired gets the kill; the team total matches the sum.
- **Spawn ring**: all four spawn cells are open floor on **all 20 levels** (an
  extension of the existing 20-level sweep).
- **Drop**: a client disconnects mid-level → its craft despawns, the gate stops
  counting it, the run continues.
- **Single player unchanged**: the full existing suite, untouched, plus a check that
  `crafts.length === 1` takes no new branch.
- **Divergence alarm** (P1): per-tick state hash from the authority vs the client's own
  prediction, logged on mismatch.

## 9. Open questions

1. **Revive mechanic or plain respawn** for v1? (I would do revive, with the respawn
   timer as the fallback either way.)
2. **Friendly fire**: off (my recommendation) or on?
3. **Session level**: host's best, lowest of the group, or an explicit level picker?
   (I would do host's best **plus** a picker — the picker is nearly free and makes
   testing co-op on level 6/9 trivial.)
4. **Modifiers in v1**: `Normal` + `Darker` + `Fragile` enough?
5. **Max players**: 4?
6. **Hosting**: the existing Dokku server, or a separate small VPS?

## 10. What I would *not* do

- **Deterministic lockstep** — float differences between browsers, silent divergence.
- **A separate server implementation of the rules** — the rules already run headless;
  duplicating them guarantees they drift.
- **Per-player monster scaling** — against the whole design ethos; modifiers instead.
- **A tether, shared health, or forced proximity** — the dark and the lamps do the job
  better, and forced proximity in a maze is just irritating.
- **Split screen for online co-op** — everyone has their own screen; it only comes up
  for the local two-player phase (P2), where a single camera framing both crafts is
  simpler and reads better.
- **Delta compression, interest management, matchmaking, accounts** — nothing here
  needs them at 4 players and 54 monsters.
- **Making single player depend on the net code** — it must keep working from a static
  host with no server, exactly as today.

## 11. Risks

- **The P0 refactor touches ~800 lines of the sim.** Mitigation: behaviour-preserving
  by construction, small commits, and the existing 612 checks + 20-level sweep as the
  net.
- **The rules pass (P4) is bigger than it looks** — revive/respawn, target locking,
  lobby, HUD, modifiers all land at once. Mitigation: it is split into two slices
  (P3 = net with old rules, P4 = rules), so a playable networked game exists before any
  rule changes.
- **Revive tuning** (radius, channel time, respawn delay) will need playtesting; it is
  the one rule where numbers matter more than structure.
- **WebRTC NAT traversal** is the classic time sink — deferred to P6, behind a
  transport interface.
- **Server ops**: one persistent Node process; Dokku path exists.
- **Cross-browser divergence in level generation** is unlikely (seeded, integer grid)
  but not impossible; the grid checksum turns it into a clear error.
- **Scope creep** — touch input, matchmaking, spectators, leaderboards. Out of scope
  until asked.
