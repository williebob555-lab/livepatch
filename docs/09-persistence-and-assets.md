# 09 — Persistence, Assets, and the Tape System

_Last verified: 2026-08-02. Files: `src/core/persist.ts`, `src/core/session.ts`, `src/core/cassettes.ts`,
`src/core/cassettes.ts`, `src/core/rolls.ts`, `src/core/sampler.ts`,
`src/core/customblocks.ts`, `src/core/factory/*`,
`src/core/prefs.ts`, `src/core/takehistory.ts`,
`src/core/encode/*`,
`src/ui/tape.ts`, `src/ui/clipview.ts`, `src/ui/pianoroll.ts`,
`src/ui/imagepicker.ts`, `electron/main.cjs`._

## Scenes (`persist.ts`)

A scene is the `.lps` document (JSON `Scene`). `persist.ts` runs on the Electron
bridge (`window.livepatchNative`) when present, and falls back to localStorage +
browser file pickers so the renderer is fully usable in a plain browser.

- Native scene registry: `userData/scenes/*.lps` (list/save/load/delete via IPC).
- Import/export via native file dialogs (or a browser download/`<input>`).
- `parseScene(json)` **migrates + fills defaults** so old/partial saves still
  open: it merges `theme` over `defaultTheme()` and `normalizeGraph` backfills
  per-block structure. One malformed block must never break rendering.

## Session autosave (`session.ts`)

The whole working state (scene incl. theme, open subpatch path, camera view) is
autosaved to localStorage (debounced on change, flushed on close/hide) so
relaunch reopens exactly where you left off. Custom blocks are stored separately
(also localStorage) so they're available across all scenes.

> **Dev note:** running the packaged/dev app with `LIVEPATCH_DEV_URL` shares the
> origin's autosaved session. When scripting many test blocks into the running
> app, reset the scene afterward or they persist into the user's workspace.

## Custom blocks (`customblocks.ts`)

A user-saved subgraph → `CustomBlockRecord` (a `Block` snapshot, id/pos
stripped), stored in localStorage, shown in the Library's **Custom** tab.
Instantiated via `doc.instantiateTemplate` (full id remap). Adding a new
id-embedding field means updating that remap — see
[`03-document-model.md`](03-document-model.md).

## Factory content (`src/core/factory/`)

The patches that ship with the app: preset scenes (Scenes panel → **Factory
presets**) and built-in custom blocks (Library, under a **Factory** subheader),
the largest of which is the Mavis panel. They are ordinary document data, built
by the code in `factory/build.ts` rather than checked in as JSON — the reasons
are at the top of that file, and the authoring rules are in
[`08-extending.md`](08-extending.md).

**They are merged on read, never seeded into the user's storage**, and that is
the decision worth understanding. Copying the presets into localStorage on first
run is the obvious implementation, and it means they belong to the user forever:
improving one in a later build reaches nobody who has already launched the app
once, and a preset that shipped half-finished is permanent. So
`getCustomBlocks()` returns `[...user, ...factory]` and the factory entries
carry `factory: true`.

Read-only therefore has to be enforced in three places, because each of them
would otherwise appear to work and be undone by the next launch:

| | |
|---|---|
| `deleteCustomBlock` / `renameCustomBlock` | no-op on a factory key, and the Library's context menu omits both items |
| `updateCustomBlock` | returns `undefined`, and the block menu drops `Save Custom Block "…"` so only **Save as Custom Block…** is offered |
| `doLoadPreset` | loads with `savedAs = null` and `dirty = true`, exactly like an import, so Save asks for a name and writes a copy |

The guarantee that falls out: **you can take any factory preset apart and you
cannot lose it.** Which is the point — the Mavis exists to be opened.

`node scripts/factory-preset-test.mjs` validates every template and scene
structurally (see [`12-testing-checklist.md`](12-testing-checklist.md)).

## The Tape system — cassettes as audio assets

The tape system replaces "pick a file each time" with reusable **cassette**
assets and a `tape` signal kind.

### Cassette store (`cassettes.ts`)

A cassette is one audio file: its original-format bytes plus a small meta record.

```ts
interface CassetteMeta {
  id;            // 'cas_' + timestamp36 + rand
  name; ext; size;
  durationSec?; sampleRate?; channels?;   // filled after first decode
  createdAt; origin: 'import' | 'recording';
  kind?: 'audio' | 'image' | 'midi';      // unset = audio
  scratch?: boolean;                      // a recorder's uncommitted take
}
```

- **Storage:** Electron → `userData/cassettes/<id>.<ext>` + `<id>.json` meta
  (IPC: list/save/load/delete/updateMeta/importPaths/savePcm). Browser →
  IndexedDB. Scene blocks reference a cassette by `params.asset` id only, so
  scenes stay small and reload with audio intact.
- **Caches:** decoded `AudioBuffer`s and waveform peaks are cached here and
  shared by the renderer (waveform display) and the Web engine. `getCassetteBuffer`,
  `getCassettePeaks`, `getCassetteBytes`.
- **Import:** `importAudioFiles` (multi-select) / `importAudioFolder` (recursive
  scan, Electron only). Folder/multi imports copy bytes **main-side**
  (`cassettes:importPaths`) so large libraries never stream through the renderer.
- **Image assets** share the same store: `meta.kind: 'image'` (unset = audio,
  so every pre-existing record stays audio). `imageList()` lists them;
  `cassetteList()` filters them out, which keeps them clear of every audio
  list/decode/tape path — the engine never sees an image id. Imported via
  `importImageFiles` (renderer file input; bytes still land in the shared
  store, Electron main needed **no changes** — meta JSON round-trips as-is).
  Used by block faces/skins; decoded bitmaps cached in `src/ui/images.ts`.

### The play window — the start/stop bars

**The bars are the transport.** A deck plays its cassette between `regStart` and
`regEnd`; material outside them does not sound. There is one playback mode and
one position domain, which is what keeps a reported playhead honest.

| | |
|---|---|
| units | 0..1 of the **file** |
| fades | `fadein`/`fadeout` hang off the bars, measured inward from each |
| ▶ / loop | start at the start bar; loop returns to it |
| `seek` | 0..1 of the file, so a scrub reaches material outside the bars too |

They are ordinary CV-modulatable floats, so both engines and the Clip tab see
exactly the same four numbers, and nothing else in the app moves them —
`⇔ Bars → the whole file` in the Clip tab's context menu is the user asking.

> **What used to be here.** Cassettes carried a `clips?: CassetteClip[]` marker
> list, `file-player` carried a serialized `arr` arrangement param, rolls
> carried `RollClip[]`, and the Clip tab was an arrangement editor: split, join,
> move, crossfade, consolidate, flatten. **All of it was removed on 2026-07-23.**
> It was an attempt to be Ableton inside a patching sandbox — the invariants it
> needed (source range vs timeline position, occlusion, one-sided crossfades,
> the "never re-fit the window" latch) were expensive to hold and bought nothing
> the app is actually for. If you find yourself reaching for a timeline here,
> that is the thing to reconsider, not to rebuild. See
> [`README.md`](README.md) and the Sampler below for where that energy goes
> instead.

### Tape blocks

- **`cassette`** — one asset; custom cassette-shell face; a `tape` output. Drag
  onto a player/sampler/writer, or wire the `tape` port.
- **`tape-reader`** — "Read Files…/Folder…" spawns one `cassette` block per file
  beside the reader (and they appear in the Cassettes tab).
- **`tape-recorder`** — see "The take model" below. A deck that writes: it
  holds a live take, auditions it through an audio `out`, punches in at the
  playhead, hands the take out **live** on `tape` (see "The live take"), and is
  turned into a cassette by **Save As…**, never by ■.
- **`tape-writer`** — encodes the inserted cassette to disk; pick filename +
  format. Encoding runs renderer-side (`src/core/encode/`): WAV native, mp3/ogg
  via `wasm-media-encoders`, flac via `libflacjs` — all **lazy `import()`** so
  they stay out of the boot bundle.
- **`file-player`** — plays the window between the bars, with the window's fades
  and a Speed knob. The Web unit uses one `AudioBufferSourceNode` with
  `loop`/`loopStart`/`loopEnd` (sample-accurate laps on the audio clock) and
  schedules the window fades per lap on a separate gain node; the native kernel
  walks `[s0,s1)` and applies the same fades from bounds it recomputes only on
  change.

### The Sampler — the one deliberate Ableton borrowing

Sampling is where the interesting accidents happen, so this block is allowed to
look like Simpler. **The mode decides what a note means, and nothing else
branches on it:**

| mode | a note is… |
|---|---|
| `classic` | a **gate**: the region plays under an ADSR, and with Loop on it cycles `[loopStart, loopStart+loopLen]` for as long as the key is held |
| `oneshot` | a **trigger**: the region plays through and note-off is ignored, so a hit cannot be cut short by a short key press |
| `slice` | a **key**: the region is cut at the slice points and each piece answers to a key. `slicemap` decides which — see below |

- Region = `start`/`end` (0..1 of the file, driven by the `sampleview` widget on
  the block face *and* by the play bars in the Clip tab — they are the same two
  params). `fadein`/`fadeout` are **material** fades; A/D/S/R is the
  **performance** envelope. Both apply, and in the Web unit they are two gain
  nodes per voice on purpose: folding them into one curve would mean recomputing
  every ramp on note-off.
- **Full velocity means unity, and how much velocity takes away is a knob**
  (`velAmp` in `src/core/sampler.ts`, hand-copied into the kernel).
  A voice is `material × envelope × velAmp(velocity, velamp) × gain`. It used to
  be raw `velocity × gain` with `gain` defaulting to **0.8**, which put an
  ordinary v80 press at **−6 dB** and v64 at −8 dB — reported as "recorded
  samples play a lot quieter than they should" (2026-08-01) with nothing wrong
  anywhere in the tape path: capture, commit and decode all measure bit-exact,
  the instrument simply gave the level away before it started. `Vel → Amp` at
  **0** makes every trigger full level, which is what a loop or one-shot lifted
  off the tape recorder wants; at **1** it is the old linear response.
  `scripts/slice-pitch-test.cjs` holds the numbers, and it is what catches the
  two copies drifting apart.
- **Loop points are clamped into the region at note-on**, in both engines, so
  dragging the region can never leave the loop pointing at audio the region
  excludes.
- `loopFade` crossfades the loop seam — the fade **between laps**, as opposed to
  `fadein`/`fadeout`, which only bound the first and last one. It overlaps the
  loop's own head (the tail fades out over the last `loopFade` while
  `[loopA, loopA+fade)` fades in, and the lap wraps to `loopA + fade`), so it
  needs no material outside the loop and works on the loop the Clip tab hands
  you. It used to reach *backwards* into the run-up before `loopStart`, which is
  the textbook shape but is zero-length on that loop — so the control silently
  did nothing in the case everyone reaches. A lap is therefore the bracket minus
  the fade, which the toolbar states. **Native only.** An
  `AudioBufferSourceNode` has loop points but no seam fade, and faking one needs
  a second source per lap; the Web engine is the fallback path, so it loops
  without the crossfade rather than growing a scheduler for it.
- **Every mode runs the ADSR, including the slice modes**, and a voice's release
  starts early enough to *finish* as its material runs out — cutting a voice off
  with the envelope still open is a click, and it was what every slice ended on.
  `slicehold` picks whether note-off releases a slice (Gate, the default) or it
  plays out as a hit (One-Shot).
- **Slice points are authored state, not derived** (`src/core/sampler.ts`): a
  JSON array of 0..1 positions on the `slices` string param, exactly the way
  `seqgrid` ships its steps — so `CompiledGraph` stays engine-agnostic and the
  native kernel parses the same string itself. `divideEvenly` and
  `detectTransients` fill it; the Clip tab drags, adds (Ctrl-click) and deletes
  individual points.
  - Only the **interior** points are stored. The edges are the region, so
    moving a bar re-spaces nothing and every stored point keeps its meaning.
  - A point the region no longer covers is **dropped, not clamped**. Clamping
    would pile several markers onto the region edge and hand out silent keys.
  - `detectTransients` runs on the peak envelope the waveform cache already
    holds, so detection costs no extra decode — and it reads the same picture
    the user is looking at, which is what makes the result predictable. It is a
    rectified-energy onset detector with a trailing-average threshold, not a
    beat tracker; every point it produces is draggable afterwards.
  - **Detection awaits its scan** (`getCassettePeaksAsync`). The drawing only
    warms the bucket counts it needs, and a button that gave up when its own
    scan was cold did nothing the first time it was pressed.
- **Which key a slice answers to is `slicemap`.** Dealing the pieces out in the
  order they happen to appear is fine for a drum kit, where the keyboard is a
  set of buttons; it is useless for anything played, because C3 gets whatever
  came first and the instrument you get back has no relationship to the one
  that was recorded.
  - `Chromatic` — slice *i* on `root + i`, at its own pitch. A kit. The
    original behaviour and still the default for a fresh block.
  - `Pitched` — each slice carries the key it was **detected** to sound
    (`slicekeys`, a JSON array parallel to the slice list, written by the Clip
    tab's `♪ Keys`), and any note plays the slice whose key is nearest,
    transposed onto it. Every key on the keyboard sounds, and it sounds the
    sample that needs stretching least — which is how a sampled instrument is
    built. Slices where nothing pitched was found keep their chromatic slot but
    **lose every tie** to a detected one: a placeholder key must not steal a
    note from a slice that was actually heard to play it.
  - Detection is YIN's cumulative-mean-normalized difference function on the
    decoded buffer, decimated to ~16 kHz (`detectPitchHz`). It has to be YIN
    rather than plain autocorrelation because the cheap version answers an
    octave low on anything with a strong second harmonic, and an octave error
    here is not an inaccuracy — it lands the slice twelve keys away. Material
    with no periodicity comes back as "none" rather than as a guess.
  - The keys are **positional**, so re-cutting the region drops them: slice *i*
    is now different audio, and keeping the old keys would map notes to
    material nothing ever listened to.
  - `sliceForNote` (`src/core/sampler.ts`) is the resolution both engines
    implement — the native kernel carries a hand-copy, the same mirroring
    arrangement as the rig and trajectory math. **Change one, change both.**

### The take model (both recorders)

A recorder is a **deck that writes**, not a one-shot capture box. It holds one
live *take*, and the same four buttons mean what they do on any tape machine:

| | |
|---|---|
| ● Rec | starts writing **at the playhead**. That is the whole of punch-in: material before the head survives, material after it is overwritten in place, and the take extends if the pass runs past the end. A fresh recorder punches in at 0, which is an ordinary recording. |
| ▶ Play | auditions the take between the bars, through the recorder's audio `out`. This is how you hear a take *before* keeping it. |
| ■ Stop | ends capture and commits the take to a **scratch** asset (see below). |
| Clear | drops the take. It deliberately does **not** delete anything already saved. |

- **Only "Save As…" produces a Library asset.** The samples have to be
  materialized somewhere — the Clip tab draws them and the audition re-reads
  them — so ■ writes a real file, but its meta carries `scratch: true` and
  `cassetteList()`/`rollListRaw()` filter those out. `saveTakeAs(id, name)`
  **copies** the bytes into an ordinary listed asset: a copy, not a rename, so
  the recorder keeps its take and can be punched into and saved again under
  another name. Committing a *listed* asset on every ■ is what turned the
  Cassettes tab into litter.
- **The take draws itself while you record.** There is no cassette to scan
  mid-take, so the recorder publishes the picture: `VisualFeed.wave` (min/max
  pairs spanning the whole take) and `VisualFeed.notes` for MIDI. Both kernels
  keep that incrementally — the dirty frame range is rescanned, and the bucket
  size doubles as the take outgrows the fixed array — so a ten-minute take
  costs exactly what a two-second one does. Rescanning on a timer would stall
  the pump the engine process shares with its audio callback.
- **The committed id reaches the document through `EngineAdapter.onAsset`.**
  Engines own the samples and never the document; one handler in `main.ts`
  writes the id onto the block's `asset` param.
- **A punch-in rewrites bytes under a live id**, so the renderer's decode
  cache and every waveform scan keyed on that id are stale.
  `invalidateCassette(id)` drops them; the native path signals it with
  `tape-created { rewrote: true }`. Forgetting this leaves the Clip tab drawing
  the take as it was before the punch, indefinitely.
- Capture allocates one ~0.5 MB chunk per ~2.7 s of recording (native) rather
  than a slice per quantum, which is what the old accumulate-and-join recorder
  did. Capture has to put samples *somewhere*; this is the least the audio path
  can do it in, and the audition reads those chunks in place.
- **`midi-recorder` has no asset output port.** Its `roll` out was removed on
  2026-07-23: a MIDI take reaches the rest of the patch through the Library,
  once Save As… has named it. `RETIRED_PORTS` in `persist.ts` drops it (and any
  wire that reached it) from scenes saved before that — `backfillDefPorts` only
  ever *adds*, so a retired port would otherwise live on forever in every
  existing scene, wired and apparently working while the engine ignored it.
  `tape-recorder`'s `tape` out went the same way and **came back on 2026-08-01**
  as something else entirely — see below.
- `node scripts/recorder-kernel-test.cjs` drives both kernels headless and
  asserts capture, the punch (before survives / middle replaced / after
  survives), the same-id rewrite, audition output, Clear keeping the asset, the
  live take, and that the MIDI recorder records at all. **The probe is async on
  purpose**: committing streams the WAV to disk a slice at a time and the live
  take is republished off a pump timer, so neither has happened when ■ returns.
  Reading the cassette directory synchronously after ■ tests the race, not the
  recorder — which is exactly what it used to do.

### The live take — `tape-recorder`'s `tape` out

The recorder's `tape` output is **not** "the cassette it committed". It is the
capture buffer itself, published while recording, so a Sampler wired to it plays
what you just played — no ■, no Save As…, no trip through the Library. That is
the one thing the retired port could not do, and the reason it is back.

- **Live assets are an in-memory overlay on the asset store**, keyed
  `live_<nodeId>`: `AssetStore.setLive` (native, `engine/src/assets.ts`) and
  `setLiveTake` (renderer, `src/core/cassettes.ts`). They shadow the disk store,
  because between punches the take in memory is ahead of the file. The ids are
  never persisted, never listed and never written.
- **`tape` presents the live take while the recorder holds one**, and falls back
  to the committed cassette when it does not — which is what a freshly loaded
  scene has, and what Clear leaves behind. ■ therefore does **not** swap a
  wired sampler onto the file it just wrote; that would re-decode the same audio
  and then fall behind the next punch.
- **The native mirror is incremental** (`LiveTake`, `engine/src/dsp.ts`). A
  `Take` is chunked and a `DecodedAudio` is one flat array per channel, so the
  mirror is a real copy — but the engine's event loop **is** the audio pump
  (docs/10, the same fact that put the disk commit on a `WriteStream`), so a
  whole-take memcpy on a pump pass is a quarter-second of xruns. Growth is
  therefore *staged*: capacity doubles into a second array filled a slice at a
  time while the old one stays published, and steady state copies only the
  frames that arrived (`Take.mirrorFrom/mirrorTo`, its own dirty range so the
  waveform picture and the mirror cannot rob each other). `channels[ch]` is a
  `subarray` view, and **the published object identity never changes** — that is
  what lets a sampler hold the take and watch it lengthen.
- **The Web engine rebuilds instead**, because an `AudioBuffer` cannot grow and
  cannot be viewed into. Every refresh is a full copy on the main thread, so the
  rate self-limits: never more than ~5% of wall time (`liveCost * 20`). A phrase
  refreshes every frame; a ten-minute take rarely, and a ten-minute take is not
  what anyone is live-sampling. Fallback-engine behaviour, like the sampler's
  loop crossfade.
- **Growth is announced through `assetChanged`** — `AssetStore.onLiveChange` →
  `GraphExec` sweeps every kernel (native), `UnitEnv.assetChanged` →
  `WebAudioEngine.assetChanged` (web). A deck that re-hydrates must **keep its
  playhead** when the id and the object are the same material that grew;
  re-seating it at the start bar 16 times a second is what a naive re-hydrate
  does.
- **The Sampler is the block this is for.** It reads the region off
  `channels[0].length` at note-on, so a growing take simply means the next note
  reaches further; a sounding voice keeps the material it started on. A *deck*
  fed from a live take also follows it, but its bars are fractions of the file,
  so a take that is still growing moves the window under it — inherent, not a
  bug, and the reason the port is documented as a sampling route.
- **The UI does not draw a live take on a downstream block.** `resolveAssetFor`
  hands the Clip tab a `live_…` id it has no peaks for, so a sampler wired to a
  recording shows an empty waveform until the take is committed. The recorder's
  own face and Clip tab are unaffected — they draw `VisualFeed.wave`.

### Tape routing

`tape` nets carry an **asset id**, routed like MIDI (event push), not audio.
`src/ui/tape.ts` `resolveAssetFor(block)` finds which cassette feeds a block on
the document side (a wired tape input wins over the block's own `asset` param) —
used for waveform display and the writer. The engines resolve the id to a buffer
themselves.

### Engine asset access

- **Web engine:** `getCassetteBuffer(id)` (decode cache).
- **Native engine** (`engine/src/assets.ts`): reads bytes straight from the
  cassette dir (no IPC round-trip). It decodes **WAV natively** (`wav.ts`); for
  compressed formats it emits `need-asset`, the renderer decodes with Web Audio
  and writes a `.pcm` cache (`LPCM` header + interleaved float32), then replies
  `asset-ready` and the engine loads the cache.

## The `.pcm` cache format (`engine/src/wav.ts`)

`'LPCM'` | u32 sampleRate | u32 channels | u32 frames | f32 interleaved. This is
the renderer↔engine handoff for any format the engine can't decode itself.

## Encoders (`src/core/encode/`)

`encodeAudio(buffer, 'wav'|'mp3'|'ogg'|'flac')`. WAV is a hand-rolled 16-bit PCM
writer (also used by the recorder). mp3/ogg from `wasm-media-encoders` (WASM
inlined — no Vite asset config). flac from `libflacjs` (the asm.js build,
deliberately, to avoid `.wasm` asset loading issues under `file://`). All
verified to round-trip (encode → decode back correctly).

## MIDI rolls (`src/core/rolls.ts`)

A **roll** is the note-data counterpart of a cassette: a note list plus a
tempo, stored in the same byte store with `kind: 'midi'` and extension
`lproll`, bytes = UTF-8 JSON. Electron main needed **no changes** — the same
trick image assets used.

```ts
RollNote { n, t, d, v }        // pitch, start beat, length beats, velocity
RollData { bpm, beats, notes }
```

- **A roll is its own timeline.** There is no clip layer between the notes and
  the player, so what the piano roll draws *is* the list the Pianola is handed.
  `rollPlayEnd` is the span a player loops over (the last sounding beat,
  **floored at the declared `beats`**, so trailing silence counts), and a
  reported playhead is a fraction of exactly that.

  **The length is pushed to the engines, never re-derived there** — as the
  `beats` param, alongside `notes`, by `syncRolls`. Both engines had been
  computing it from the note list alone (`max(1, last note end)`), which drops
  the trailing silence. Since `d.beats` is rounded *up* to a whole beat, almost
  every roll has some, so almost every roll had two different lengths — and
  `regStart`/`regEnd` and the reported playhead are all **fractions** of it:
  - the playhead ran fast and reached the right edge before the music did,
    drifting further the longer the roll ("the bar gets out of sync");
  - the repeat bars resolved to the wrong beats, so the loop cut early ("it
    doesn't repeat exactly on the repeat bars"). Measured: an 8-beat roll whose
    last note ended at beat 1 looped **every 0.5 s instead of every 4 s**.

  Three implementations must agree: `rollPlayEnd` (`core/rolls.ts`), `rollEnd`
  (native kernel), `rollBeats` (web unit). **Change one, change all three.**
- **The drawn playhead is dead-reckoned between engine fixes.** Transport
  arrives on the visuals timer at ~15 Hz while the canvas draws at 60, so
  painting the raw value steps in ~66 ms jumps and sits a frame behind the
  notes you hear. `clipview` treats each engine value as a fix and advances it
  by wall-clock × tempo, wrapping at the repeat bars and capped at 0.25 s so a
  stopped engine can never let the bar run away on its own.
- **Time is in beats, not seconds**, so a roll can be re-tempoed without
  touching the notes and a take can be quantized after the fact.
- `parseRoll` **ignores** a `clips` key rather than rejecting the file: rolls
  saved while the clip system existed still open, and their notes are the roll.
- `getRollData` mirrors the waveform caches: synchronous, null while loading,
  event on arrival. That event goes through `notifyAssets()` — the *shared*
  asset event — because derived state (a player's `notes` param) is re-synced
  from there and would otherwise never catch up after an async load.
- `cassetteList()` is an **allow-list** (`(kind ?? 'audio') === 'audio'`), not a
  deny-list. A new asset kind must not be able to leak into the audio lists,
  the decode cache and the tape ports simply because nobody remembered to
  exclude it. It also drops `scratch` records — see the take model above.
- Blocks: `midi-roll` (holder), `midi-recorder` (records + thru), `midi-player`
  (plays out as MIDI). All three have native kernels — the parity rule.
- The `roll` **SignalKind** transports exactly like `tape` (an asset id pushed
  to sinks, reusing the same `tapeIn`/`tapeOut` hooks); they are separate kinds
  only so a cassette cannot be patched into a note player, or a roll into an
  audio deck, where it would silently do nothing.
- Note data reaches the engines as the `notes` string param via `syncRolls()` —
  the same derived-state pattern the retired arrangement `arr` used.
- MIDI **file** import/export is real SMF (`src/core/midifile.ts`, hand-rolled,
  no dep). It parses format 0 and 1 (all tracks merged onto one note list) and
  writes format 0 at 480 ppq. Round-trips exactly. The parser measures every
  event — including sysex and meta it skips — because a length off by one byte
  desyncs the rest of the track.

### `syncRolls` — the derived `notes` param

The asset owns the truth; `syncRolls()` re-derives the engine-facing copy and
writes **only where it differs**, so the common case costs one string compare
per player. It runs from three places, and all three are needed:

1. **On every asset change** (`onCassettesChange` in `main.ts`) — edits,
   imports, undo, and an async roll load landing.
2. **On every structure change.** *Wiring is what decides which roll a player is
   holding.* Without this, dropping a roll from the Library into a wired Pianola
   — or pulling the wire out again — left the player on whatever note list it
   already had: it went on playing the old roll, or played nothing, until some
   unrelated asset event happened to fire.
3. **Once after a scene load** (`afterSceneLoad` / boot), because a scene edited
   elsewhere can hold a stale copy.

### Rolls in the Library

Rolls appear under a **Rolls** category, built to the same shape as Cassettes
because they are assets in the same sense: **＋ Add files… / ＋ Add folder…**
(MIDI, folder only under Electron) plus **＋ New roll**. Drag or double-click to
drop a **Piano Roll** block bound to the roll (`addBlockAt('roll:<id>')`),
right-click for Export .mid… / Rename / Delete.

- MIDI import returns **bytes**, not paths — the opposite of the audio side, and
  deliberately: an audio library can be gigabytes so it is copied main-side,
  while a MIDI file is a few kilobytes and has to be *parsed* by the renderer
  (which owns the SMF reader) before it can become a roll.
- **A roll tile draws the Piano Roll block with that roll's notes punched into
  the paper** (`renderRollThumbnail`), not a generic box: a roll and a cassette
  sit next to each other in the same grid and the drawing is the only thing
  telling them apart at a glance.

> **The data-loss bug.** `getRollData` starts an async load when the cache is
> empty and, when the bytes arrive, writes them into the cache. But an edit
> (draw/import/undo) can populate the cache *while the load is in flight* — and
> the stale on-disk version then clobbers the live edit. That is the
> intermittent "MIDI data gets deleted when I come back to a roll." The load's
> `.then` bails if the cache was filled during the load (`dataCache.has`); the
> live edit persisted itself, so nothing is lost.

> **The delete bugs (found 2026-07-23).** Three of them, all from the same
> place — an asset's *bytes* are gone but state derived from them is not:
>
> 1. **`deleteCassette` did not evict the roll data cache.** A deleted roll went
>    on drawing in the Clip tab *and* went on being pushed to its player's
>    `notes` param — i.e. it kept **playing**. Fixed with `onAssetDeleted`, a
>    hook fired *before* the change event so no listener can repaint a world
>    where the record is gone but its data is still cached.
> 2. **A load in flight could resurrect a deleted roll**, re-caching bytes with
>    no meta behind them — an entry nothing could ever delete again. The same
>    `.then` guard now also checks `getCassette(id)`.
> 3. **Undo could resurrect one too**, because a history snapshot predating the
>    delete still held its notes. `installRollHistory`'s `restore` skips ids
>    with no meta: deleting an asset is a Library action, not an undoable
>    document edit.

### The piano roll (`src/ui/pianoroll.ts`)

The Clip tab's second mode, chosen when the selection holds a roll. Its toolbar
is transport + draw/select + snap grid + delete + quantize + fit + import/export
— it shares nothing with the waveform view, because a roll has no play window.

- **Selecting an empty Piano Roll mints its roll and opens the editor.** The
  block exists to hold notes; a "press New Roll to begin" wall was a step in the
  way of the only thing you can do next. `ensureRoll` is idempotent and
  re-entrant-safe (a `minting` set), and re-checks the block still exists when
  the async save lands. Only `midi-roll` — a Pianola plays whatever is wired to
  it, and minting a roll there would silently detach the wire.
- **`yn` floors, it does not round.** A row's whole visual band must map to
  that row; rounding splits at the half-row, so clicks in a row's lower half
  land a semitone below the cursor — the "note doesn't match the cursor" bug.
  Drawing floor-snaps the start (`snapFloor`) so the note fills the cell you
  clicked instead of jumping to the next line.
- **Double-tap / double-click a note deletes it** — no right-click, no mode
  switch, same under a finger. Matched on the note's *identity* (pitch+start),
  not its array index, which shifts after a re-sort.
- **Scroll wheel zooms** (time on plain, pitch on Ctrl, scroll on Shift/Alt),
  anchored at the cursor.
- **Touch**: single finger draws/drags through pointer events; a second finger
  promotes to pinch-zoom + two-finger pan (`beginGesture`/`applyGesture` in
  `clipview.ts`, shared by the waveform and piano-roll surfaces). A second
  finger aborts any single-finger edit in progress, exactly like the workspace
  canvas.
- Editing is audible: gestures preview through the player the roll feeds
  (`previewOn`/`previewOff`), and preview notes are tracked **separately** from
  scheduled ones so an audition can never cut short a note that playback is
  holding at the same pitch.
- **Undo/redo works** via `beforeEdit`, a hook the roll fires *before* its first
  mutation so history snapshots the pre-edit note list (pushing after would
  capture the result and make undo a no-op).

> **The other trap here.** The Clip tab's `nodeIdOf` addressed the *selected*
> block by its path but every other block the same way, so the roll bar's ▶ sent
> transport to the roll holder instead of the Pianola downstream — nothing
> sounded. Only the target uses the tab's path; anything else resolves through
> `runtime.nodeId`.

## Undoing non-Scene state (`registerHistorySide`)

Undo snapshots the Scene — but not everything the user edits is in it. Roll
notes belong to the *asset*, shared by every block and scene that uses that
roll, yet drawing a note is still an edit and Ctrl+Z has to reverse it.

`GraphDoc` therefore keeps a **list** of `HistorySide` providers (it was one
slot until a second registrant silently displaced the first). `capture()` runs
for every snapshot, `restore()` when one is applied; `installRollHistory()`
registers from `main.ts`.

- Captures must stay small — this runs on **every** `pushHistory()`. Never put
  audio, images or decoded buffers here.
- `restore()` only re-persists rolls that actually differ, so an ordinary
  block-move undo does no IO at all — and it **skips ids with no meta**, so an
  undo cannot resurrect a deleted asset (see the delete bugs above).
- **`restore()` swaps in a fresh `scene` object.** Anything holding a `Block`
  reference across an undo is holding a detached one; re-resolve by id/path.
  The Clip tab does exactly that (`doc.blockByPath(targetPath)` per access).
- **Push history before the mutation.** A `pushHistory()` after the edit
  captures the new state and undo becomes a no-op. Equally, don't push for an
  edit that turns out to be a no-op, or the stack fills with entries that
  appear to do nothing.
- `reset()` is the optional third hook: the document was *replaced*, so every
  snapshot naming this side's state is gone and whatever it held for them can
  be dropped. `loadScene` calls it. For rolls that saves nothing; for takes it
  frees audio.

### The take store (`core/takehistory.ts`) — undo for bytes

Cutting a range out of a take rewrites the asset's bytes, and that has to be
undoable: a confirmation asks the user to be certain *before* they can hear the
result, which is the wrong instrument for an edit you judge by ear.

It is **not** shaped like the roll side, and the reason is the constraint that
should govern any future side provider:

- `capture()` runs on **every** `pushHistory()` — every block drag. The roll
  side copies its whole cache each time, which is fine for note lists and
  unaffordable for audio (a few minutes of stereo 48 kHz is ~90 MB).
- So the capture is a **version token per asset** (an integer) and the bytes sit
  in a bounded side store: `MAX_BYTES` / `MAX_VERSIONS`, oldest evicted first,
  never the version an asset currently sits at. Snapshots stay cheap; only real
  edits cost memory.
- `noteTakeBaseline(id, bytes, meta)` → `doc.pushHistory()` → write →
  `noteTakeVersion(id, bytes, meta)`. The baseline call is a no-op when the
  store already holds the asset's present bytes, so consecutive edits don't
  keep two copies of the same audio. `clipview.ts`'s `rewriteTake` is the only
  caller, deliberately: one funnel for every destructive take write.
- **Meta rides with the bytes.** A cut changes the duration; restoring samples
  without it leaves every waveform scaled to a length the file no longer has.
- **Anything that rewrites take bytes outside the undo stack must call
  `forgetTakeHistory(id)`** — the web recorder's `commit` and the native
  engine's `tape-created { rewrote }`. Recording is not an undoable edit, so no
  snapshot names the punched bytes; without this the store still claims the
  take sits at its pre-punch token, and undoing the *previous* edit would write
  older audio straight over the pass just recorded.
- Running out of history **says so** (a banner via the `onEvicted` hook). A
  Ctrl+Z that quietly does nothing reads as a broken app; the cap is a real
  bargain with memory, not something to hide.

## The Dock's contents live in the Scene

`Scene.dock = { widgets: DockWidget[] }` holds the mirrored widgets in the
Dock's Widgets tab. It is in the **scene**, not localStorage, for two reasons:
the entries name block ids (which are scene-scoped and meaningless anywhere
else), and being inside the scene puts them inside the undo snapshot — so
undoing a block delete brings its docked widgets back with it.

- `DockWidget.path` is the block's **absolute path from the scene root**
  (`['b7','b3']`) — the same segment list that forms a compiled node id — so a
  clone resolves identically no matter which subgraph is open.
- `doc.pruneDock()` drops entries whose source block (or the child a
  `link:`/`expose:` ref names) is gone. It runs after every block delete and on
  scene load, so a hand-edited or partially-migrated `.lps` can't leave orphans.
- `parseScene` backfills a missing/malformed `dock` (`normalizeDock`): scenes
  saved before the Dock existed simply have no key and load with an empty one.
- The Dock's *panel layout* (height, which tab was open) stays in localStorage
  with the other panel state — that is per-machine preference, not document.

## Image assets and the image library (`src/ui/imagepicker.ts`)

Images share the cassette store (`kind: 'image'`) and are referenced by id from
two places: a face `image:<assetId>` layout item and a block's `style.bgImage`
skin. `imageList()` is the audio-free view of the store, so no engine ever sees
them.

`pickImage()` is the **only** UI for them — the block Skin row and the block
menu's `Add image…` both call it, and the top bar's Options ▸ Image library…
opens it with nothing to pick. It imports, renames, deletes, and reports a
**usage count** taken over the whole scene (every subgraph, both reference
kinds) before a delete, because an image can be on a block three subpatches
down. Before it existed, images accumulated forever: a flat context-menu list
with an Import item on the end and no way to remove anything.

> **Delete and rename are inline inside the picker, and must stay that way.**
> `buildModal` **empties `#modal-layer`** — modals do not stack. A
> `confirmModal`/`promptModal` opened from inside the picker tears the picker
> down: you get exactly one delete per visit and then land back on the canvas
> with the dialog gone. So ✕ arms itself (a second click commits) and rename
> swaps the caption for an input. Any new in-dialog action has the same
> constraint.

## Saved speaker rigs (`savedRigs` in `src/core/rig.ts`)

`rigPresets` is the built-in standards (Stereo → 9.1.6). The layout you actually
own is the one you dragged to match your room, so it can be saved by name —
`saveRigPreset` / `deleteRigPreset`, listed in the Rig tab's picker under
"Saved". These live in **localStorage**, not the Scene: a rig preset is a
property of the room, not of a patch. Both save and load deep-copy, so a scene's
subsequent speaker drags never write back into the preset. Every stored entry is
re-validated through `parseRig` on read.

**Calibrations travel with the rig** (2026-07-31) — into the scene file *and*
into the saved preset, which is the point: a measurement is a property of the
room, exactly like the layout, and re-measuring it in every new scene is the
work presets exist to avoid.

What is stored is **curves, not filter taps**: `resp` (the measured response)
and `corr` (the correction), each ~121 numbers on the fixed 1/12-octave grid in
`core/calibrate.ts`, plus a gain, a delay and the geometry baseline. About
1.5 kB per speaker, so a 16-speaker saved rig is ~24 kB — comfortably inside the
localStorage quota, which storing taps (4× the size) would start to threaten.
The engine derives the actual FIR when the rig reaches it, so the same stored
calibration is correct at any sample rate; taps would have to be rebuilt anyway.

**The grid is a compatibility contract.** `CAL_F0` / `CAL_PPO` / `CAL_N` are
duplicated in `engine/src/rig.ts`, and every calibration ever saved is a bare
array of numbers against them. Appending points is safe; changing the start
frequency or the resolution silently reinterprets every existing calibration as
describing different frequencies. `parseCal` rejects a wrong-length or
non-finite curve outright — it reads as "not calibrated", never as a filter.

## Application preferences (`src/core/prefs.ts`)

The settings that belong to the *installation*, not to a scene: default device
per hardware block type (`audio-in` / `audio-out` / `asio-in` / `asio-out`), the
engine to start with, and whether audio comes up running. Top bar → **Options**.

- `GraphDoc.makeBlock` applies `defaultDeviceFor(type, api)` to a new block's
  `device` param — so a hardware block arrives on the right interface instead of
  "(default)". No preference set leaves the def's default alone.
- **A blank `device` resolves to the preference at COMPILE time, not just at
  creation time** (`resolveDevice`, `compile.ts`, 2026-08-01). Applying it only
  in `makeBlock` made the setting a template for *new* blocks: every block that
  predated it — and every block in every scene shared, imported or built by the
  factory presets — stayed on the operating system's default forever, and
  changing the preference moved nothing. Resolving on the compiled node instead
  keeps the document portable (the scene still says "(default)", so handing it
  to someone else still means *their* default) while this machine opens the card
  this machine was told to use. `onPrefsChange` raises `'structure'` so the
  change actually reaches the engine, and Properties spells the resolved name
  out — two blocks both reading "(default device)" could otherwise open
  different cards with nothing on screen to say which.
  Deliberately narrow: only the id `device`, only when it is empty, and only for
  the types `defaultDeviceFor` names — MIDI In/Out also carry a `device` param
  and must never be handed an audio endpoint. Multi In and Speaker Rig carry
  both worlds on one block, so their `api` param picks which of the four
  preferences applies.
- `applyStartupPrefs()` (shell) runs **after the session scene is restored**;
  starting audio before that would spin the engine up on an empty graph and
  immediately rebuild it.
- Preferences never enter the undo stack — changing one is not an edit to the
  document.

## Invariants

- **Scene blocks reference assets by id, never by path or bytes.** Keeps scenes
  small and portable.
- **An app preference never goes in the Scene, and scene state never goes in
  localStorage.** Devices, engine choice, UI scale, Library pins and saved rigs
  describe the machine; a patch handed to someone else must not carry them.
- **The rig belongs to the room, not to the patch** (2026-08-01). A speaker
  layout describes where the user's speakers physically are; opening a different
  scene does not move them. It used to live only in `Scene.rig`, so loading a
  patch — your own from yesterday, a factory preset, anything shared — silently
  repointed every panner at somebody else's room, and the only way back was to
  rebuild the layout by hand. So the *active* rig is app-level state
  (`livepatch.rig`, beside saved rig presets) and `Scene.rig` becomes a record
  of what the scene was authored against: still written, still exported, still
  what a hand-built test scene compiles with, but overridden on load. The
  calibration rides along, which is the other half of the point — two minutes of
  sweeps per speaker is not something to redo per scene.
  - Two write points and no others: `GraphDoc.setRig` (every route into the rig
    already funnels through it — drag, inspector, preset, ±speaker) and
    `restore`, because **undoing a rig edit is a rig edit** and Ctrl+Z would
    otherwise move the speakers on screen while leaving the stored layout at the
    value the next scene load would put straight back.
  - **Discarding a scene's layout is not allowed to be silent.** It changes the
    channel count and therefore how the patch sounds, so `loadScene` records
    `rigOverride` and the shell banners it ("built for 9.1.6 (16 ch) — using
    your rig …"). Reported only when the count or the name actually differs.
  - The opt-out (Rig tab → *Same rig in every scene*) is a **switch**, not
    "delete the stored rig": deleting would re-arm on the very next speaker
    drag, since `setActiveRig` runs on every edit, and an opt-out that undoes
    itself the first time you touch the editor is not an opt-out. Turning it
    back on adopts what is on screen rather than whatever was stored last.
- **Assets are never edited destructively.** Nothing in the app rewrites a
  cassette's samples. The one exception is a recorder acting on *its own take*,
  under an id it already owns: punching in, and (2026-07-25) the Clip tab's
  `Delete` on a window selection. Both keep the id so every deck holding the
  take follows the edit, and both must evict the engine's decoded copy
  (`runtime.assetChanged`). The `Delete` is **undoable** (see the take store
  below) and therefore asks nothing first; the punch is not, because recording
  is not a document edit. A player's cassette is never a candidate; that is why
  those buttons exist only for `recorder` roles.
- **There is one playback mode and one position domain.** A deck plays its file
  between the bars, and a position is 0..1 of that file. Anything that adds a
  second mode brings back two position domains, and with them a playhead that
  lies about where the audio is. **The Clip tab is a viewer, not a timeline** —
  see [`README.md`](README.md) before adding an edit to it.
- **A recorder's take commits to one scratch id, and only Save As… makes a
  Library asset.** Minting a listed cassette per pass turns an edit into litter;
  minting a *new* id per pass strands whatever was already holding the take.
- **Derived engine params re-derive on structure changes too**, not just asset
  changes — wiring is what decides which asset a block is holding.
- **Deleting an asset must evict everything derived from its bytes**
  (`onAssetDeleted`), or the deleted thing goes on drawing and on sounding.
- **State the user can edit must be undoable.** If it isn't in the Scene, it
  goes through `registerHistorySide` — it does not get to skip Ctrl+Z. Deleting
  an *asset* is not one of those: it is a Library action, and undo must not
  bring it back.
- **Retiring a port means listing it in `RETIRED_PORTS`.** `backfillDefPorts`
  only ever adds, so a port dropped from a definition survives in every scene
  that already had one — wired and apparently working, ignored by the engine.
- **`Scene.dock` entries are cleaned, never trusted.** Prune on load and on
  delete; a dangling entry must degrade to "not drawn", not to a crash.
- **Never round-trip large audio through the renderer** when main can copy it
  (folder import). Bytes cross IPC one cassette at a time, on demand.
- **`parseScene` must keep tolerating old/partial scenes** — add migrations, not
  hard requirements.

---

## The library on a remote surface

`cassettes.ts` picks its backend **once, at module scope**, from
`window.livepatchNative`. Electron → `%APPDATA%/cassettes`. No bridge → a
per-device IndexedDB.

A phone driving the Dock over the LAN falls in the second case, and its
IndexedDB is empty. The Clip tab draws nothing, the Library is bare, and every
tape widget resolves to no audio — with nothing on screen to say why. Same
shape as the saved-rigs bug in `core/appstate.ts`: **installation state that
does not travel.** `appstate` covers the localStorage half (rigs, custom
blocks, prefs); the on-disk asset store is this half.

The host serves it read-only over the LAN server:

| route | what |
|---|---|
| `GET /library/list` | the cassette index (same records `cassettes:list` returns) |
| `GET /library/<id>` | the bytes, **streamed** |

Streamed because a take can be hundreds of megabytes and this is the process
supervising the audio engine — reading one into a Buffer would spike it every
time a phone opened the Clip tab. Served over HTTP rather than pushed down the
link because the link is a control channel carrying value frames many times a
second.

### Two traps, both hit while building this

**Do not install a partial `window.livepatchNative` shim.** The obvious fix is
to fake the bridge on the remote so `cassettes.ts` takes the native path. It
blanks the page: `persist.ts` and others read `!!window.livepatchNative` as
"this is Electron", so a shim missing `listScenes` throws during boot. The
backend choice belongs *inside* `cassettes.ts`, which is the module that
actually knows what it needs.

**Do not mount these under `/assets`.** Vite emits every bundle into
`dist/assets/`, and dynamic routes are consulted *before* static files — so
`/assets/list` also shadows `/assets/index-<hash>.js`, and the remote loads a
white page. Hence `/library`.

`remoteAssets` stays false until the probe actually succeeds, so a plain
browser dev session — also http(s), but with no host serving `/library` —
keeps its IndexedDB store instead of silently losing it.

Writes are refused, not faked: a control surface that appeared to import a file
and then lost it on reconnect is worse than one that plainly cannot.

Last verified 2026-08-02: `dock.html` served with `/library` routes booted and
fetched the index at startup (200).
