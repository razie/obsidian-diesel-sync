import DieselSyncPlugin, { clientLog } from "../src/main";
import { Vault } from "obsidian";
// offline (0.8.1): what a sync leaves out on purpose is skipped and said once, never an error; a realm answering 5xx is
// left alone for the rest of the sync; base d2 is never asked of a d1 reactor. The reactors are faked at http().
// npm run test:skips
const vault = new Vault();
const app = { vault, workspace: { on: () => ({}), getActiveFile: () => null, getLeaf: () => ({ openFile: async () => {} }) } };
const p = new DieselSyncPlugin(app as any, {} as any);
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} ${n} ${x}`); };
const urls: string[] = [];
(p as any).http = async (o: { url: string }) => {
  urls.push(o.url);
  const u = o.url;
  if (/\/api\/v2\/topics\/CompanyCard:/.test(u)) return { status: 400, json: { ok: false, error: { code: "E_ARG", message: "unknown topic category 'CompanyCard' (Topic, Spec)" } }, text: "" };
  if (/\/api\/v2\/topics\/Shared\?/.test(u)) return { status: 200, json: { name: "Shared", text: "# s\n", ver: 3, project: "d2" }, text: "" };
  if (/other\.dieselapps\.com/.test(u)) return { status: 502, json: null, text: "bad gateway" };
  return { status: 404, json: null, text: "" };
};
const st = (path: string, wpath: string) => { vault.files.set(path, "# x\n"); p.data.state[path] = { wpath, ver: 1, hash: "stale", at: 0 } as any; };
(async () => {
  await p.onload();
  Object.assign(p.data.settings, { user: "u", password: "p", d1Sync: true, d2Projects: "metals", initialPullQuery: "", pullNewTopics: false, logOnErrors: false });
  st("Diesel/d2/Help/Apps.md", "d2.Help:Apps");
  st("Diesel/d2/Topic/Nav.md", "d2.Topic:Nav");
  st("RazInvest/Cards/A.md", "metals.CompanyCard:A");
  st("RazInvest/Cards/B.md", "metals.CompanyCard:B");
  st("Diesel/metals/Topic/Shared.md", "metals.Topic:Shared");
  st("Diesel/other/Topic/X.md", "other.Topic:X");
  st("Diesel/other/Topic/Y.md", "other.Topic:Y");
  clientLog.lines = [];
  await p.syncAll();
  const log = clientLog.lines.map(l => `${l.level} ${l.msg}`), summary = log.find(l => l.includes("sync all:")) ?? "";
  check("1 base d2 unlisted: never asked of d2.dieselapps.com", !urls.some(u => u.includes("d2.dieselapps.com")), urls.filter(u => u.includes("d2.")).join(" "));
  check("2 base d2 unlisted: said once, as a warning", log.filter(l => l.startsWith("warn skipped: d2 is base d2")).length === 1, log.join(" | "));
  check("3 d1-only category on d2: said once for both notes", log.filter(l => l.includes("'CompanyCard' isn't a d2 category")).length === 1);
  check("4 a shared topic is skipped, not an error", log.some(l => l.startsWith("warn skipped: metals.Topic:Shared is d2's shared topic")));
  check("5 a realm answering 502: one line, its second note not asked", log.filter(l => l.includes("other answered HTTP 502")).length === 1 && !urls.some(u => u.includes("other.Topic:Y")), urls.join(" "));
  check("6 the summary: only the 502 is an error, the rest skipped", /1 error/.test(summary) && /6 skipped/.test(summary), summary);
  check("7 notes kept", ["Diesel/d2/Help/Apps.md", "RazInvest/Cards/A.md", "Diesel/metals/Topic/Shared.md", "Diesel/other/Topic/Y.md"].every(f => vault.files.has(f)));
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
