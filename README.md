# Fathom

A one-tap diving game. You pilot a submersible down a pitch-black trench, and
your only instrument is sonar.

**Tapping does two opposed things at once.** It thrusts you toward your finger,
and it fires a ping that lights the cave walls — but the ping is loud, and the
things down here hunt by sound. Seeing where you are tells them where you are.

That tension is the entire game.

## The loop

- **Tap** — thrust toward the touch point, and ping.
- **The ping is a ring, not a floodlight.** Only geometry the expanding
  wavefront is crossing gets lit, so the cave arrives in slices and then fades
  back to black. You navigate mostly from memory.
- **Silence pays.** A multiplier climbs to ×3 the longer you go without
  pinging. Every ping wipes it.
- **Noise attracts.** The meter rises with each ping. Above the line, drifting
  hunters stop drifting and start converging on where they heard you.

## The daily dive

By default every dive is **the day's dive**: the cave is generated from a seed
derived from the date, so everyone who plays on the same day flies the same
trench and the scores are worth comparing. The day is your *local* day — a
puzzle that turns over at midnight where you are reads correctly; one that
turns over at midnight UTC does not.

The post-mortem offers the run as something you can paste:

```
Fathom · Day 1
612 pts · 284m · 9 pings · 2 decoys · ×2.6 peak
https://boldenbvinny.github.io/fathom/
```

`ENDLESS` on the title screen rerolls a fresh trench every dive instead. Bests
are kept separately: endless under `fathom.best`, each day under its own key.

Only world generation is seeded. Cosmetic jitter stays on `Math.random`, and
physics still depends on frame timing, so the guarantee is *the same cave* —
not a replay.

## Running it

No build step, no dependencies — it's plain Canvas 2D.

```sh
python3 -m http.server 8080
```

Then open `http://localhost:8080`. On a phone, use your machine's LAN IP
(you may need to allow incoming connections through your firewall).

It's an installable PWA: "Add to Home Screen" gives you a fullscreen app that
works offline.

## Layout

| File | Purpose |
|---|---|
| `game.js` | The whole game — physics, sonar, collision, rendering, states |
| `index.html`, `style.css` | Full-bleed canvas, notch-safe, no zoom or scroll |
| `manifest.json`, `sw.js` | PWA shell and offline cache |
| `og.png` | 1200x630 social preview card, referenced by the `og:`/`twitter:` tags |
| `cover.png` | 630x500 itch.io cover art |
| `icons/` | App icons, generated programmatically |

## Tuning

Every number that controls feel lives in one block at the top of `game.js`.
The two that matter most:

- `SILENT_RAMP` — how fast the silence multiplier builds.
- `halfWidthAt()` — how quickly the trench narrows with depth.

## Design constraints worth preserving

Two invariants are load-bearing, and both have been measured rather than
guessed:

1. **The sonar wave must decisively outrun the player.** `PING_SPEED` is ~3.7×
   `MAX_FALL` so that revealed geometry always arrives as a warning. When these
   were close together, 59% of the cave was never lit before you reached it.

2. **The virtual world is 640 units tall on every device.** Warning time is
   proportional to how far ahead you can see, so viewport height is locked and
   only width flexes with the aspect ratio. Scaling is *contain*, never cover.

## Tests

```sh
node test/run.js
```

No dependencies. `test/harness.js` provides one shared browser stub — a single
place to add a browser API when the game starts using one, which is what keeps
the suite from drifting out of sync with the game.

The suite guards the two load-bearing invariants (reaction window and fixed
world height) across phone, tablet and desktop viewports, plus the silence
multiplier actually paying, decoy mechanics, pause, reduced motion, audio
scheduling, and that the game still runs with `audio.js` absent.
