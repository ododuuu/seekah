// Quick sanity run: node smoke.mjs A,B "SPEC.md" "測試"
import { createEngine } from "./engines.mjs";
import { resultHash } from "./hash.mjs";
const [names, ...queries] = process.argv.slice(2);
for (const name of names.split(",")) {
  const engine = await createEngine(name);
  for (const query of queries) {
    const { ranked, snippets, metrics } = engine.search(query, { pages: [1] });
    console.log(name, JSON.stringify(query), ranked.length, resultHash(ranked).slice(0, 12),
      JSON.stringify({ totalMs: Math.round(metrics.totalMs), postingMs: Math.round(metrics.postingMs), payloadReads: metrics.payloadReads,
        decompressedMB: +(metrics.decompressedBytes / 1e6).toFixed(1), verifiedBlocks: metrics.verifiedBlocks, fpDocs: metrics.falsePositiveDocs }),
      JSON.stringify(snippets[1]?.[0] ?? "").slice(0, 80));
  }
  engine.close();
}
