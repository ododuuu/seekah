// zstdDecompressSync with the default 16 KiB chunkSize versus a larger output chunk.
import { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";
const [database] = process.argv.slice(2);
const db = new DatabaseSync(database, { readOnly: true });
const rows = db.prepare("SELECT text FROM document_chunks WHERE length(text) > 8000 ORDER BY id LIMIT 3000").all();
for (const [label, options] of [["default", {}], ["chunkSize 256K", { chunkSize: 256 * 1024 }], ["chunkSize 1M", { chunkSize: 1024 * 1024 }]]) {
  let bytes = 0;
  const started = performance.now();
  for (let run = 0; run < 2; run++) for (const row of rows) bytes += zstdDecompressSync(row.text, options).length;
  const ms = performance.now() - started;
  console.log(`${label.padEnd(16)} ${(ms / rows.length / 2).toFixed(3)} ms/chunk  ${(bytes / 2 ** 20 / (ms / 1000)).toFixed(0)} MiB/s`);
}
