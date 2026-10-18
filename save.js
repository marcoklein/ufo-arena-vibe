/* Saved progress.
 *
 * One thing is remembered between sessions: the highest level you have reached.
 * It only ever goes up, so a run can always be picked up at the deepest level
 * you have seen, and the kill count that got you there is kept with it. The
 * record carries a version so that later additions (a score, unlocked modes,
 * per-level times) can be read from an older save without guessing.
 *
 * Pure and storage-agnostic on purpose: every function takes the store it works
 * on, so the offline tests drive it with a fake one and the game drives it with
 * localStorage.
 */

export const SAVE_KEY = "ufo-arena.save";
export const SAVE_VERSION = 1;

// a localStorage-shaped fallback, for browsers that refuse storage (private
// mode, blocked third-party storage, an iframe without the right flags)
export function memoryStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

// the browser's own storage if it works, a memory store if it does not: a
// refused save must never stop the game from starting
export function pickStore(win) {
  try {
    const s = win && win.localStorage;
    if (!s) return memoryStore();
    const probe = `${SAVE_KEY}.probe`;
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return memoryStore();
  }
}

export function blank() {
  return { version: SAVE_VERSION, best: 0, last: 0, kills: 0 };
}

// anything unreadable, truncated or hand-edited reads as an empty save rather
// than throwing in the middle of a level transition
export function parseSave(raw) {
  if (!raw) return blank();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return blank();
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return blank();
  const num = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return {
    version: num(data.version) || SAVE_VERSION,
    best: num(data.best),
    last: num(data.last),
    kills: num(data.kills),
  };
}

export function readSave(store) {
  try {
    return parseSave(store.getItem(SAVE_KEY));
  } catch {
    return blank();
  }
}

export function writeSave(store, data) {
  try {
    store.setItem(SAVE_KEY, JSON.stringify(data));
  } catch {
    // full, or refused: the run goes on, it just will not be remembered
  }
  return data;
}

/* Reaching a level. `best` is only ever pushed up, never down, and the kills
   that got you there are stored with it - so "continue at the best level" also
   brings back the score you had when you first got that far. */
export function reachLevel(data, level, kills = 0) {
  const n = Math.max(1, Math.floor(level) || 1);
  const out = { ...data, version: SAVE_VERSION, last: n };
  if (n > out.best) {
    out.best = n;
    out.kills = Math.max(0, Math.floor(kills) || 0);
  }
  return out;
}
