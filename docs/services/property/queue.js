/* Offline property-lookup queue. When a lookup is attempted with the device
   offline, the request is queued here instead of firing, and drained
   sequentially (not in parallel, 500ms between each) the moment the browser
   reports 'online'. Same Store-backed localStorage mechanism as everything
   else in the app — see docs/index.html's Store helper. */
const PropertyQueue = (() => {
  const KEY = 'beaconwatch_property_queue';
  let draining = false;

  function all() { return Store.get(KEY, []); }
  function push(entry) { const q = all(); q.push(entry); Store.set(KEY, q); }
  function shift() { const q = all(); const e = q.shift(); Store.set(KEY, q); return e; }
  function size() { return all().length; }
  function isQueued(jobId) { return jobId != null && all().some(e => e.jobId === jobId); }

  // runLookup(entry) -> Promise, called once per queued entry, sequentially.
  async function drain(runLookup) {
    if (draining) return;
    draining = true;
    try {
      while (all().length && navigator.onLine) {
        const entry = shift();
        if (!entry) break;
        try { await runLookup(entry); } catch { /* fail-soft, same contract as lookupProperty */ }
        if (all().length) await new Promise(r => setTimeout(r, 500));
      }
    } finally {
      draining = false;
    }
  }

  return { push, shift, size, all, drain, isQueued };
})();
