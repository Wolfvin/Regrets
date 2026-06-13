# Binary Builder Pattern — Multi-Step Construction APIs

## The Problem

Many libraries have APIs that require multi-step construction:

```js
const track = new Track();
track.addEvent(new NoteEvent({pitch: 'C4', duration: '4'}));
track.setTempo(120);
const writer = new Writer(track);
const output = writer.buildFile(); // Uint8Array
```

Regrets expects `entry → output`, but these APIs need `construct → configure → build`.

Writing a separate wrapper function for every test scenario creates massive boilerplate.
The **binary builder pattern** solves this with a single parameterized builder.

## The Pattern

Create one wrapper module with a parameterized entry function:

```js
// regrets-entry.mjs
import MidiWriter from '../build/index.js';

export function buildMidi(scenario) {
  const track = new MidiWriter.Track();

  if (scenario.tempo) track.setTempo(scenario.tempo);
  if (scenario.timeSignature) track.setTimeSignature(...scenario.timeSignature);
  if (scenario.keySignature) track.setKeySignature(scenario.keySignature);
  if (scenario.copyright) track.addCopyright(scenario.copyright);
  if (scenario.trackName) track.addTrackName(scenario.trackName);

  for (const evt of scenario.events || []) {
    track.addEvent(new MidiWriter.NoteEvent(evt));
  }

  return new MidiWriter.Writer(track).buildFile();
}
```

Then in `regrets/manifest.json`:

```json
{
  "clusters": [
    {
      "id": "simple-note",
      "entry": "buildMidi",
      "file": "regrets-entry.mjs",
      "watches": [],
      "inputs": [
        { "events": [{"pitch": ["C4"], "duration": "4"}] }
      ]
    },
    {
      "id": "note-with-tempo",
      "entry": "buildMidi",
      "file": "regrets-entry.mjs",
      "watches": [],
      "inputs": [
        { "tempo": 120, "events": [{"pitch": ["C4"], "duration": "4"}] }
      ]
    },
    {
      "id": "chord",
      "entry": "buildMidi",
      "file": "regrets-entry.mjs",
      "watches": [],
      "inputs": [
        { "events": [{"pitch": ["C4", "E4", "G4"], "duration": "4"}] }
      ]
    }
  ]
}
```

One builder function, many behavioral contracts. Each cluster tests a different
combination of API features.

## Key Rules

1. **Always create fresh instances** — never reuse Track/Writer across calls.
   Some libraries mutate internal state during `buildData()`, making the instance
   unusable for a second call.

2. **Use `Writer.base64()` or `Writer.buildFile()`** — both are deterministic.
   `base64()` produces compact string output (better for .regret file readability).
   `buildFile()` produces `Uint8Array` (works with Regrets' TypedArray support).

3. **Don't try to watch instance methods** unless you need `fingerprintLevel: "watched"`.
   For most refactoring, `fingerprintLevel: "entry"` with the builder pattern
   is sufficient — it validates the final output.

4. **If you DO need watched instance methods**, use the `instanceMethods` manifest option:

```json
{
  "id": "track-methods",
  "entry": "buildMidi",
  "file": "regrets-entry.mjs",
  "watches": ["Track", "NoteEvent", "Writer"],
  "instanceMethods": {
    "Track": ["addEvent", "buildData", "setTempo"],
    "Writer": ["buildFile"]
  },
  "fingerprintLevel": "watched"
}
```

## When to Use

- **Binary output** (MIDI, images, PDFs, encoded data)
- **Class-based APIs** with mutable state
- **Builder/configure patterns** (construct → set options → build)
- **Multi-class collaboration** (Track + Writer, Parser + Serializer)

## Avoiding Pitfalls

### Mutable State After buildData()

Some libraries expand internal data structures during build. For example,
MidiWriterJS replaces `NoteEvent` objects with `NoteOnEvent` + `NoteOffEvent`
in the Track's events array during `buildData()`. This means:

```js
const track = new Track();
track.addEvent(new NoteEvent({pitch: 'C4', duration: '4'}));
new Writer(track).buildFile();  // first call: events = [NoteOn, NoteOff]
new Writer(track).buildFile();  // second call: different internal state!
```

The output is still identical (deterministic), but if you're using
`fingerprintLevel: "watched"`, the call sequence will differ between runs.
Always use fresh instances for each capture/validate run.
