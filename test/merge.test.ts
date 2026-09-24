import DieselSyncPlugin from "../src/main";
import { Vault } from "obsidian";
// offline: merge logic only
const p = new DieselSyncPlugin({ vault: new Vault(), workspace: { on: () => ({}) } } as any, {} as any);
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} ${n} ${x}`); };
(async () => {
  await p.onload();
  const base = "a\nb\nc\nd\ne\n";
  let m = p.merge3("a\nB\nc\nd\ne\n", base, "a\nb\nc\nd\nE\n", 7);
  check("clean 3-way", m.conflicts === 0 && m.text === "a\nB\nc\nd\nE\n", JSON.stringify(m));
  m = p.merge3("a\nL\nc\nd\ne\n", base, "a\nR\nc\nd\ne", 7);
  check("overlap marked", m.conflicts === 1 && m.text === "a\nvvvvvvv obsidian\nL\n^^^^^^^ vs vvvvvvv diesel v7\nR\n^^^^^^^ end\nc\nd\ne\n", JSON.stringify(m.text));
  m = p.merge3("a\nX\nc\nd\ne\n", base, "a\nX\nc\nd\ne\n", 7);
  check("same edit both sides = clean", m.conflicts === 0);
  check("hasMarkers", p.hasMarkers(p.merge2("x\n", "y\n", 3).text) && !p.hasMarkers("vvvvvvv not a marker\n"));
  m = p.merge2("a\nb\nc\n", "a\nc\nd\n", 3);
  check("2-way marks each difference", m.conflicts === 2, JSON.stringify(m.text));
  console.log(`\n${pass} passed, ${fail} failed`);
})();
