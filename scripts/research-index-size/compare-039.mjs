// Compare complete result hashes before (0.38.1) and after (0.39.0) migration.
import { readFileSync } from "node:fs";
import { dataPath } from "./common.mjs";

const before = JSON.parse(readFileSync(dataPath("val-before.json"), "utf8")).hashes;
const after = JSON.parse(readFileSync(dataPath("val-after.json"), "utf8")).hashes;
const keys = Object.keys(before);
const different = keys.filter(key => before[key].hash !== after[key]?.hash);
console.log(JSON.stringify({ queries: keys.length, identical: keys.length - different.length,
  different: different.map(key => ({ key, before: before[key].count, after: after[key]?.count })),
  totalResults: keys.reduce((sum, key) => sum + before[key].count, 0),
  before038Ms: Object.fromEntries(keys.slice(0, 13).map(key => [key, before[key].ms])),
  after039ExactMs: Object.fromEntries(keys.slice(0, 13).map(key => [key, after[key].ms])) }, null, 1));
