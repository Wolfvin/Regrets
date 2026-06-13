# Chrome Extension Regression Testing

Chrome extensions present unique challenges for Regrets because they run in
multiple isolated contexts (background service worker, content scripts,
side panel, popup) that communicate via message passing rather than direct
function calls.

## The Problem

When I tried to set up Regrets on a Chrome extension project
(Coretax-Auto-Downloader), I found three major gaps:

### 1. Content Scripts Have No Exports

Content scripts in Chrome extensions typically use IIFEs or top-level code
with no `export` statements. Regrets' `capture.js` uses `await import()`
to load the target module — but if nothing is exported, there's nothing
to fingerprint.

**Solution: Adapter Modules**

Create thin adapter files that import from the compiled output and re-export
the functions you want to fingerprint:

```js
// regrets/adapters/xhr-exporter.mjs
import { exportXLSX, exportCSV, formatPeriod } from '../../js/xhr-mode/exporter.js'

export { exportXLSX, exportCSV, formatPeriod }
```

Point your manifest `file` field at the adapter:

```json
{
  "id": "xhr-export",
  "entry": "exportXLSX",
  "watches": ["exportXLSX", "formatPeriod"],
  "file": "regrets/adapters/xhr-exporter.mjs",
  "stack": "js"
}
```

### 2. Multi-Process Communication

Chrome extensions use `chrome.runtime.sendMessage()`,
`chrome.tabs.sendMessage()`, and `window.postMessage()` to communicate
between contexts. These message handlers are invisible to Regrets because
they're callback-based, not entry functions.

**Solution: Test the Message Handler's Logic, Not the Channel**

Extract the pure logic from message handlers into testable functions:

```js
// Before: logic is inside the message listener
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'EXPORT_XLSX') {
    // 200 lines of export logic mixed with response handling
    const result = buildXlsxBuffer(msg.data, msg.options);
    sendResponse({ success: true, buffer: result });
  }
});

// After: logic is a pure function
export function buildXlsxBuffer(data, options) {
  // Pure transformation — testable by Regrets
  return /* ... */;
}

// Message listener becomes a thin wrapper
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'EXPORT_XLSX') {
    const result = buildXlsxBuffer(msg.data, msg.options);
    sendResponse({ success: true, buffer: result });
  }
});
```

Then fingerprint `buildXlsxBuffer` via an adapter module.

### 3. Stateful Background Service Workers

Background scripts maintain global state that content scripts and side panels
read/write via messages. This state is mutable and shared across the extension.

**Solution: Fingerprint State Transitions**

Create clusters that test state transition functions — pure functions that
take current state + an event and return new state:

```js
// Before: state mutation is inline
function handleJobStart(jobId) {
  state.jobs[jobId].status = 'running';
  state.jobs[jobId].startTime = Date.now();
  state.activeJobCount++;
}

// After: pure state transition
export function transitionJobStart(state, jobId, now) {
  return {
    ...state,
    jobs: {
      ...state.jobs,
      [jobId]: { ...state.jobs[jobId], status: 'running', startTime: now }
    },
    activeJobCount: state.activeJobCount + 1
  };
}
```

## TypeScript + Chrome Extension Build Pipeline

Chrome extension TypeScript projects often use a dual build:

1. `tsc` compiles TS → JS
2. `esbuild` bundles content scripts into IIFEs (Chrome doesn't support
   ES module imports in content scripts)

For Regrets, point adapters at the **compiled JS output** (step 1), NOT
the bundled output (step 2). The bundled output strips exports and wraps
everything in an IIFE, making it incompatible with `await import()`.

```json
{
  "preBuild": "npx tsc",
  "clusters": [
    {
      "file": "regrets/adapters/export-adapter.mjs",
      "entry": "exportXLSX",
      "stack": "js"
    }
  ]
}
```

## Chain Testing for Extension Flows

Use `chains.json` to test multi-step extension flows:

```json
{
  "chains": [
    {
      "id": "fm-download-pipeline",
      "steps": [
        { "cluster": "fm-find-invoices", "input": { "year": "2026", "month": "01" } },
        { "cluster": "fm-extract-rows", "input": { "invoiceIds": ["FP-001", "FP-002"] } },
        { "cluster": "fm-export-xlsx", "input": { "format": "xlsx" } }
      ]
    }
  ]
}
```

Each cluster tests a pure function that corresponds to one step in the
extension's message flow. The chain validates that the full pipeline
produces consistent output.

## Known Limitations

- **DOM-dependent functions** cannot be tested by Regrets — functions that
  require `document.querySelector()` or `window` objects need either a
  DOM mock or must be refactored to accept DOM elements as parameters.

- **Chrome API calls** (`chrome.storage`, `chrome.cookies`, etc.) require
  the extension runtime. Functions using these must be refactored to
  accept the data as parameters for Regrets testing.

- **Event listeners** registered with `chrome.runtime.onMessage.addListener()`
  cannot be directly fingerprinted. Extract the handler logic into a
  separate testable function.
