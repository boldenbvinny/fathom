# Fathom

A one-tap sonar diving game. Plain Canvas 2D, no dependencies, no build step.
`game.js` is one IIFE over a full-bleed canvas; `index.html` loads it directly.

## Commands

```sh
node test/run.js          # the whole suite (also `npm test`)
node --check game.js      # syntax only
python3 -m http.server 8080   # play it locally
```

CI runs `node --check` over every JS file, then the suite, on pushes to `main`
and on every PR.

## Non-obvious rules

**Never ship debug hooks in `game.js`.** The game's internals are module-scoped
inside the IIFE. `loadGame([names])` in `test/harness.js` exposes them by
injecting a probe line at load time, so tests reach internals without the real
file carrying test scaffolding. If a test needs a new internal, add its name to
the expose list — do not export it from `game.js`.

**One browser stub, shared.** Every test builds its fake browser with
`install()` from `test/harness.js`. When the game starts using a new browser
API, add it there once. Tests used to hand-roll their own stubs and drifted:
the game began listening for `visibilitychange`, and the stubs lacking
`document.addEventListener` threw while the one that had it passed.

**The harness pins `Date`.** World generation is seeded from the local date, so
an unpinned clock would make every terrain assertion expire at midnight. Pass
`opts.date` to test a specific day. Note that `opts.seed` only overrides
`Math.random`, which now drives cosmetics alone — seeding it will not make
terrain deterministic.

**Seeded vs. not.** Everything shaping the cave (wander, pillars, hunter spawn
points) draws from `rnd()`, the mulberry32 stream seeded per dive. Cosmetic
jitter — motes, screen shake, hunter micro-wander — stays on `Math.random`.
Keep that split: the daily promises *the same cave*, not a replay, and physics
rides frame timing regardless.

**Bump `CACHE` in `sw.js` when shipping asset changes.** The service worker is
cache-first; returning players are served the old build until the version
string changes.

**`og.png` and `cover.png` are real captured frames**, not mock art, and the
`og:`/`twitter:` URLs in `index.html` are absolute because scrapers reject
relative image paths. They point at the GitHub Pages origin and need updating
if the game moves to a custom domain.

## Load-bearing invariants

Both are measured, not guessed, and both are guarded by the suite across phone,
tablet and desktop viewports. Read `## Design constraints worth preserving` in
`README.md` before changing either.

1. **`PING_SPEED` must decisively outrun `MAX_FALL`** (~3.7x). Revealed
   geometry has to arrive as a warning. When these were close, 59% of the cave
   was never lit before the player reached it.
2. **The virtual world is 640 units tall on every device.** Warning time is
   proportional to how far ahead you can see, so height is locked and only
   width flexes. Scaling is *contain*, never cover — cropping would cost the
   player reaction time.

## Tuning

Every number controlling feel is in one block at the top of `game.js`. Change
values there rather than threading new constants through the code.
