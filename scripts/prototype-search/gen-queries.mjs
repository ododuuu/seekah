// Deterministic differential query set.
//   node gen-queries.mjs [--seed 20260927] [--out queries.json]
// 1,000 substrings sampled from real blocks + 1,000 synthetic (mostly absent) strings.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { SnapshotReader, dataDir, mulberry32, openSnapshot, parseArgs } from "./common.mjs";

const args = parseArgs(process.argv.slice(2));
const seed = Number(args.seed ?? 20260927);
const out = args.out ?? path.join(dataDir, "queries.json");
const random = mulberry32(seed);
const pick = list => list[Math.floor(random() * list.length)];
const int = (min, max) => min + Math.floor(random() * (max - min + 1));

const db = openSnapshot();
const reader = new SnapshotReader(db);
const maxBlockId = Number(db.prepare("SELECT max(id) AS id FROM blocks").get().id);
const indexedDocuments = db.prepare(`SELECT d.id FROM documents d
  WHERE EXISTS (SELECT 1 FROM document_payloads p WHERE p.document_id = d.id)`).all().map(row => Number(row.id));
const blockAtOrAfter = db.prepare("SELECT id, document_id, heading FROM blocks WHERE id >= ? ORDER BY id LIMIT 1");
const blocksOfDocument = db.prepare("SELECT id, document_id, heading FROM blocks WHERE document_id = ?");

function script(value) {
  const cjk = /[぀-ヿ㐀-鿿豈-﫿ｦ-ﾟ]/u.test(value);
  const ascii = /[\x21-\x7e]/u.test(value);
  const other = /[^\x00-\x7e　-ヿ㐀-鿿豈-﫿＀-￯]/u.test(value);
  return other ? "other" : cjk && ascii ? "mixed" : cjk ? "cjk" : "ascii";
}

/** One random block (half uniform over blocks, half uniform over indexed documents). */
function randomBlock() {
  for (;;) {
    let block;
    if (random() < 0.5) block = blockAtOrAfter.get(int(1, maxBlockId));
    else {
      const blocks = blocksOfDocument.all(pick(indexedDocuments));
      if (blocks.length) block = pick(blocks);
    }
    if (!block) continue;
    const useHeading = block.heading && random() < 0.12;
    const text = useHeading ? block.heading
      : reader.blockContents(Number(block.document_id), [Number(block.id)]).get(Number(block.id));
    if (text && text.trim()) return { text, source: useHeading ? "heading" : "content", documentId: Number(block.document_id), blockId: Number(block.id) };
  }
}

const cjkCharacter = /[぀-ヿ㐀-鿿豈-﫿]/u;
/** requireCjk: the substring must start at a CJK character (rejection sampling over blocks). */
function randomSubstring(length, requireCjk = false) {
  for (let attempt = 0; attempt < 20000; attempt++) {
    const block = randomBlock();
    const characters = [...block.text];
    if (characters.length < length) continue;
    let start = int(0, characters.length - length);
    if (requireCjk) {
      const starts = [];
      for (let index = 0; index + length <= characters.length; index++) if (cjkCharacter.test(characters[index])) starts.push(index);
      if (!starts.length) continue;
      start = pick(starts);
    }
    const raw = characters.slice(start, start + length).join("");
    if (!raw.trim() || raw.trim() !== raw) continue;
    return { raw, source: block.source, documentId: block.documentId, blockId: block.blockId };
  }
  throw new Error(`no substring of length ${length}`);
}

const queries = [];
const seen = new Set();
const add = (raw, kind, extra = {}) => {
  if (seen.has(raw) || !raw.trim()) return false;
  seen.add(raw);
  queries.push({ id: queries.length, raw, kind, length: [...raw.trim()].length, script: script(raw), ...extra });
  return true;
};

// Existing substrings, stratified by length; half of each bucket must start with a CJK character.
const plan = [[1, 1, 80], [2, 2, 140], [3, 3, 140], [4, 6, 260], [7, 12, 280]];
for (const [min, max, count] of plan) {
  let made = 0;
  while (made < count) {
    const sample = randomSubstring(int(min, max), made % 2 === 1);
    if (add(sample.raw, "substring", { source: sample.source, sampledDocument: sample.documentId })) made++;
  }
}
// Normalization-sensitive variants of real substrings (must match through NFKC + lowercase).
const fullwidth = value => [...value].map(c => { const p = c.codePointAt(0); return p >= 0x21 && p <= 0x7e ? String.fromCodePoint(p + 0xfee0) : c; }).join("");
let normalizationMade = 0;
while (normalizationMade < 70) {
  const sample = randomSubstring(int(3, 10));
  if (!/[a-z]/iu.test(sample.raw)) continue;
  const variant = normalizationMade % 2 ? sample.raw.toUpperCase() : fullwidth(sample.raw);
  if (variant !== sample.raw && add(variant, "normalization", { source: sample.source, sampledDocument: sample.documentId })) normalizationMade++;
}
for (const special of ["İ", "ı", "ς", "Σ", "ß", "ẞ", "ﬁ", "ﬀ", "Ａ", "ｱ", "㍿", "①", "™", "Å", "Å", "é",
  "ǅ", "ｽﾍﾟｯｸ", "ＳＰＥＣ．ＭＤ", "Ⅻ", "ｶﾞ", "㈱", "℡", "…", "–", "µ", "ＳＰＥＣ", "Ｅｘｃｅｌ", "ﾃｽﾄ", "㌔"]) {
  add(special, "normalization-special");
}
while (queries.length < 1000) add(randomSubstring(int(2, 8)).raw, "substring");

// Synthetic strings: random characters, spliced real grams, and marker tokens.
const cjkRange = () => String.fromCodePoint(int(0x4e00, 0x9fa5));
const asciiChar = () => pick([..."abcdefghijklmnopqrstuvwxyz0123456789-_."]);
while (queries.length < 1400) {
  const length = int(3, 10);
  const mode = random();
  const make = mode < 0.4 ? cjkRange : mode < 0.8 ? asciiChar : () => (random() < 0.5 ? cjkRange() : asciiChar());
  add(Array.from({ length }, make).join(""), "synthetic-random");
}
while (queries.length < 1700) {
  const left = randomSubstring(int(3, 5)).raw;
  const right = randomSubstring(int(3, 5)).raw;
  add(left + right, "synthetic-spliced");
}
while (queries.length < 2000) add(`zq${Math.floor(random() * 0xffffffff).toString(16)}`, "synthetic-marker");

writeFileSync(out, JSON.stringify({ seed, generatedAt: new Date().toISOString(), count: queries.length, queries }, null, 1) + "\n");
const summary = {};
for (const query of queries) summary[`${query.kind}/${query.script}`] = (summary[`${query.kind}/${query.script}`] ?? 0) + 1;
console.log(JSON.stringify({ out, count: queries.length, summary }, null, 1));
