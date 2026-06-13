# God Object Refactoring — Regression Testing Guide

## The Problem

A God Object is a single class/module that handles too many responsibilities.
Track.ts in MidiWriterJS is a classic example: 366 lines, 15+ public methods,
handling event management, tempo, time signature, track merging, and serialization.

When you split a God Object into smaller classes, you need to verify that:
1. The final output hasn't changed
2. Each extracted piece still works correctly
3. The interaction between new classes produces the same behavior

## Strategy: Top-Down Cluster Addition

### Step 1: Capture the Full Contract First

Before splitting anything, create clusters that test the **complete output**
of the God Object's primary use cases:

```json
{
  "clusters": [
    {
      "id": "god-simple-note",
      "entry": "buildSimpleMidi",
      "file": "regrets-entry.mjs",
      "watches": [],
      "inputs": [{"events": [{"pitch": ["C4"], "duration": "4"}]}]
    },
    {
      "id": "god-track-merge",
      "entry": "buildMergedMidi",
      "file": "regrets-entry.mjs",
      "watches": [],
      "inputs": [{"tracks": 2}]
    }
  ]
}
```

These are your **anchor clusters** — they must stay GREEN throughout the refactor.

### Step 2: Add Method-Level Clusters

Once you have anchor clusters, add clusters that test individual methods
using `instanceMethods`:

```json
{
  "id": "track-add-event",
  "entry": "buildSimpleMidi",
  "file": "regrets-entry.mjs",
  "watches": ["Track", "NoteEvent"],
  "instanceMethods": {
    "Track": ["addEvent", "buildData"]
  },
  "fingerprintLevel": "watched"
}
```

### Step 3: Split, Then Validate

When you extract `TrackBuilder` from `Track`:

1. Run all clusters. Anchor clusters must be GREEN.
2. Update method-level clusters to point to the new class.
3. Add new clusters for the extracted class.

### Step 4: Verify Cross-Class Interaction

Use chain testing to validate multi-step flows:

```json
{
  "chains": [
    {
      "id": "build-midi-flow",
      "steps": [
        {"cluster": "create-track", "input": null},
        {"cluster": "add-events", "input": {"pitch": ["C4"], "duration": "4"}},
        {"cluster": "build-file", "input": null}
      ]
    }
  ]
}
```

## Key Principles

1. **Never delete anchor clusters** during a refactor — they're your safety net.
2. **Add clusters, don't replace them** — each extraction should add new clusters,
   not modify existing ones.
3. **Fix code, not .regret files** — if a cluster goes RED after splitting,
   the split broke behavior. Fix the code.
4. **Method-level clusters are optional** — if `fingerprintLevel: "entry"`
   gives you enough confidence, skip `instanceMethods` for simplicity.

## Example: Splitting Track into TrackBuilder + TrackSerializer

```
BEFORE:
  Track
    - addEvent()
    - setTempo()
    - setTimeSignature()
    - buildData()        ← serialization
    - mergeTrack()
    - removeEventsByName()

AFTER:
  TrackBuilder
    - addEvent()
    - setTempo()
    - setTimeSignature()

  TrackSerializer
    - buildData()
    - mergeTrack()

  Track (thin wrapper)
    - builder: TrackBuilder
    - serializer: TrackSerializer
```

Anchor clusters test `Writer(track).buildFile()` — the final Uint8Array output.
This stays GREEN if Track delegates correctly to its new sub-objects.

Method-level clusters test `TrackBuilder.addEvent()` and `TrackSerializer.buildData()`
separately, catching regressions in the extracted code.
