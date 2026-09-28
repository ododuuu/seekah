// Print trace phases and counts of one search on a fresh read-only connection.
import path from "node:path";
import { pathToFileURL } from "node:url";
const [dist, database, query] = process.argv.slice(2);
const { IndexStore } = await import(pathToFileURL(path.join(dist, "src", "store.js")).href);
const search = await import(pathToFileURL(path.join(dist, "src", "search.js")).href);
for (let run = 0; run < 2; run++) {
  let started = performance.now();
  const store = new IndexStore(database, { readOnly: true });
  const openMs = performance.now() - started;
  started = performance.now();
  const set = search.createSearchResultSet(store, query);
  const setMs = performance.now() - started;
  started = performance.now();
  set.page(1, 20);
  const pageMs = performance.now() - started;
  const trace = set.trace;
  const phases = Object.fromEntries(Object.entries(trace.phaseSelfMs).filter(([, v]) => v > 1).map(([k, v]) => [k, Math.round(v)]));
  const counts = Object.fromEntries(Object.entries(trace.counts).filter(([, v]) => v).map(([k, v]) => [k, Math.round(v)]));
  console.log(JSON.stringify({ run, openMs: Math.round(openMs), setMs: Math.round(setMs), pageMs: Math.round(pageMs), total: set.total, phases, counts }));
  store.close();
}
