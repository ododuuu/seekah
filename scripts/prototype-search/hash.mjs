import { createHash } from "node:crypto";

/** Canonical hash of an ordered result list: identity, rank, source block and its displayed heading/location. */
export function resultHash(results) {
  const hash = createHash("sha256");
  for (const result of results) {
    hash.update(`${result.documentId}\u0001${result.rank}\u0001${result.sourceKind}\u0001${result.ordinal}\u0001${result.heading}\u0001${result.location}\n`);
  }
  return hash.digest("hex");
}

export function snippetHash(snippets) {
  return createHash("sha256").update(JSON.stringify(snippets)).digest("hex");
}
