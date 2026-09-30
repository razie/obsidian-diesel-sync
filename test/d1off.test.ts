import DieselSyncPlugin from "../src/main";
import { Vault } from "obsidian";
// offline: "Sync d1 reactors" off (0.7.0), with the remote faked. npm run test:d1off
const vault = new Vault();
const app = { vault, workspace: { on: () => ({}), getActiveFile: () => null, getLeaf: () => ({ openFile: async () => {} }) } };
const p = new DieselSyncPlugin(app as any, {} as any);
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} ${n} ${x}`); };
const remote = new Map<string, string>(), asked: string[] = [], written: string[] = [], queried: string[] = [];
(p as any).getRemote = async (w: string) => {
  asked.push(w);
  if (w.includes(".CompanyCard:")) throw new Error(`read ${w}: HTTP 400 — unknown topic category 'CompanyCard'`);
  return remote.has(w) ? { realm: w.split(".")[0], category: w.split(".")[1].split(":")[0], name: w.split(":")[1], content: remote.get(w), ver: 2, tags: [] } : null;
};
(p as any).write = async (_k: string, w: string, c: string) => { written.push(w); remote.set(w, c); };
(p as any).confirm = async () => ({ ver: 3 });
(p as any).tagQuery = async (realm: string) => { queried.push(realm); return []; };
const st = (path: string, wpath: string, text: string, host?: string) => {
  vault.files.set(path, text); p.data.state[path] = { wpath, ver: 1, hash: (p as any).constructor && "", at: 0, ...(host ? { host } : {}) } as any;
};
(async () => {
  await p.onload();
  Object.assign(p.data.settings, { user: "u", password: "p", d1Sync: false, d2Projects: "metals", initialPullQuery: "topic" });
  // links made while metals was d1 (no host), one d2 topic of the same name, a d1-only realm, an empty d1 realm folder
  st("RazInvest/Cards/Card-A.md", "metals.CompanyCard:A", "# A\n");
  st("Diesel/metals/Topic/Old.md", "metals.Topic:Old", "# old\n");
  st("Diesel/metals/Topic/Same.md", "metals.Topic:Same", "# same\n"); remote.set("metals.Topic:Same", "# same\n");
  st("Diesel/other/Topic/X.md", "other.Topic:X", "# x\n");
  vault.files.set("Diesel/metals/Topic/New.md", "# new\n");
  (vault as any).folders?.add?.("Diesel/empty1");
  for (const [n, h] of Object.entries(p.data.state)) (h as any).hash = "stale";   // pretend edited or not: must not matter
  await p.syncAll();
  check("1 d1-only realm: never called", !asked.some(w => w.startsWith("other.")) && vault.files.has("Diesel/other/Topic/X.md"));
  check("2 d1 category in a d2 folder (400): left alone", vault.files.has("RazInvest/Cards/Card-A.md") && !written.includes("metals.CompanyCard:A"));
  check("3 old link missing on d2: not deleted, not recreated", vault.files.has("Diesel/metals/Topic/Old.md") && !written.includes("metals.Topic:Old"));
  check("4 old link found on d2: adopted (host recorded)", p.data.state["Diesel/metals/Topic/Same.md"]?.host === "metals.aiheroapps.com");
  check("5 a new note in the d2 folder is created", written.includes("metals.Topic:New"));
  check("6 no tag query for d1 realms", !queried.includes("other") && !queried.includes("empty1"), queried.join(","));
  // 7 a note last synced with d1 (host dieselapps) is left alone even though d2 has the name
  p.data.state["Diesel/metals/Topic/Same.md"].host = "metals.dieselapps.com"; asked.length = 0; remote.set("metals.Topic:Same", "# changed on d2\n");
  await p.syncAll();
  check("7 host = d1: left alone", !asked.includes("metals.Topic:Same") && vault.files.get("Diesel/metals/Topic/Same.md") === "# same\n");
  // 8 d1 on again: the d1 realm syncs as before
  p.data.settings.d1Sync = true; asked.length = 0; await p.syncAll();
  check("8 d1 on: d1 realm read again", asked.includes("other.Topic:X"));
  // 9 (0.7.1): base d2 is the bare domain
  p.data.settings.d2Projects = "d2\nd2spec";
  check("9 d2 -> aiheroapps.com, others keep their host", p.baseUrl("d2") === "https://aiheroapps.com" && p.baseUrl("d2spec") === "https://d2spec.aiheroapps.com", p.baseUrl("d2"));
  // 10: a d2 note recorded under the old d2.aiheroapps.com host still syncs
  Object.assign(p.data.settings, { d1Sync: false });
  vault.files.set("Diesel/d2/Topic/Z.md", "# z\n"); p.data.state["Diesel/d2/Topic/Z.md"] = { wpath: "d2.Topic:Z", ver: 1, hash: "x", at: 0, host: "d2.aiheroapps.com" } as any;
  remote.set("d2.Topic:Z", "# z\n"); asked.length = 0; await p.syncAll();
  check("10 old d2.aiheroapps host: synced, host moved to aiheroapps.com", asked.includes("d2.Topic:Z") && p.data.state["Diesel/d2/Topic/Z.md"].host === "aiheroapps.com");
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
