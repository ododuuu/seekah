// How much of blocks(heading, location_kind, location_value) is derivable from the ordinal?
import { dataPath, openDb } from "./common.mjs";

const db = openDb(dataPath("snapshot.db"), { readOnly: true });
console.log(db.prepare("SELECT location_kind, count(*) n, sum(heading IS NOT NULL) headed FROM blocks GROUP BY location_kind ORDER BY n DESC").all());
// For 'line' blocks: is location_value always ordinal+1 (or a plain line number)?
const lines = db.prepare("SELECT ordinal, location_value FROM blocks WHERE location_kind = 'line' LIMIT 200000").all();
const derivable = lines.filter(r => String(r.ordinal + 1) === r.location_value || `第 ${r.ordinal + 1} 行` === r.location_value).length;
console.log({ sampledLineBlocks: lines.length, valueIsOrdinalPlusOne: derivable, examples: lines.slice(0, 5) });
console.log("distinct headings", db.prepare("SELECT count(DISTINCT heading) n FROM blocks WHERE heading IS NOT NULL").get());
