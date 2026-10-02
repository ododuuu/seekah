import assert from "node:assert/strict";
import test from "node:test";
import {
  listDefaultExclusions,
  matchDefaultExclusion,
  type DefaultExclusionPathResolver,
} from "../src/default-exclusions.js";

const WIN32 = "win32" as const;

const syntheticRealpath: DefaultExclusionPathResolver = value => {
  const normalized = value.replaceAll("/", "\\");
  const aliases = new Map([
    ["C:\\", "C:\\"],
    ["C:\\PROGRA~1\\Seekah\\README.txt", "C:\\Program Files\\Seekah\\README.txt"],
    ["S:\\", "C:\\Mounted\\Docs"],
    ["S:\\Windows\\notes.txt", "C:\\Mounted\\Docs\\Windows\\notes.txt"],
  ]);
  const resolved = aliases.get(normalized);
  if (!resolved) throw new Error(`synthetic path not mapped: ${normalized}`);
  return resolved;
};

const options = { resolvePath: syntheticRealpath };

test("M101 normalizes 8.3 names and does not treat a subst alias as a volume root", () => {
  const shortName = matchDefaultExclusion(
    "C:\\",
    "C:\\PROGRA~1\\Seekah\\README.txt",
    false,
    WIN32,
    options,
  );
  assert.equal(shortName.source, "volume-default");
  assert.equal(shortName.ruleId, "volume-default:program-files");
  assert.equal(shortName.matchedPath, "C:\\Program Files");

  const substRules = listDefaultExclusions("S:\\", WIN32, options);
  assert.deepEqual(substRules.map(rule => rule.id), [
    "builtin:.git", "builtin:node-modules", "builtin:localdocsearch", "builtin:office-temp",
  ]);
  const substWindows = matchDefaultExclusion("S:\\", "S:\\Windows\\notes.txt", false, WIN32, options);
  assert.equal(substWindows.source, "not-excluded");

  const withoutResolution = matchDefaultExclusion(
    "C:\\",
    "C:\\PROGRA~1\\Seekah\\README.txt",
    false,
    WIN32,
    { resolvePath: value => value },
  );
  assert.equal(withoutResolution.source, "not-excluded");
});
