import DieselSyncPlugin, { clientLog } from "../src/main";
import { Vault, log as notices, status } from "obsidian";
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
  await repeats();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();

// 0.8.2: an auto-sync (quiet) notices only what is new. A failure repeating unchanged is shown once, then counted in the
// status bar as repeating; it notices again once it has cleared and come back. A realm refusing the login, and a d1 realm
// that is also a d2 project, are said once a day. A manual Sync all always shows its summary.
async function repeats() {
  const v = new Vault(), a = { vault: v, workspace: { on: () => ({}), getActiveFile: () => null, getLeaf: () => ({ openFile: async () => {} }) } };
  const q = new DieselSyncPlugin(a as any, {} as any);
  let now = Date.parse("2026-10-10T08:00:00Z"); q.now = () => now;
  let home = 401, isD2 = false;   // metals.Topic:HomeTwoDoors on d1 answers this; d2's health names metals when isD2
  (q as any).getRemote = async (w: string) => {
    if (w === "metals.Topic:HomeTwoDoors" && home !== 200) throw new Error(`read ${w}: HTTP ${home} (401 can also mean "no such topic")`);
    if (w.startsWith("d2spec.")) throw new Error(`read ${w}: HTTP 401 (log in: user/password, or a token for this project)`);
    return { realm: w.split(".")[0], category: "Topic", name: w.split(":")[1], content: "# x\n", ver: 1, tags: [] };
  };
  (q as any).http = async (o: { url: string }) => /metals\.ai-putty\.com\/api\/v2\/health/.test(o.url) && isD2 ? { status: 200, json: { ok: true, project: "metals" }, text: "" } : { status: 404, json: null, text: "" };
  (q as any).autoUpload = async () => {}; (q as any).saveLog = async () => {};
  await q.onload();
  Object.assign(q.data.settings, { user: "u", password: "p", d1Sync: true, d2Projects: "", initialPullQuery: "", pullNewTopics: false, logOnErrors: false });
  const link = (path: string, wpath: string) => { v.files.set(path, "# x\n"); q.data.state[path] = { wpath, ver: 1, hash: "a0b1", at: 0 } as any; };
  link("Diesel/metals/Topic/HomeTwoDoors.md", "metals.Topic:HomeTwoDoors");
  link("Diesel/metals/Topic/Fine.md", "metals.Topic:Fine");
  const n0 = () => notices.length, quiet = async (k: number) => { for (let i = 0; i < k; i++) { await q.syncAll(true); now += 60_000; } };
  const said = (from: number, re: RegExp) => notices.slice(from).filter((m) => re.test(m)).length;

  // (a) three quiet syncs with the same 401: one notice, and the status bar says repeating
  let at = n0(); await quiet(3);
  check("a1 same 401 on 3 quiet syncs: 1 notice", said(at, /HomeTwoDoors/) === 1 && notices.length - at === 1, notices.slice(at).join(" | "));
  check("a2 the status bar says repeating", /1 error \(repeating\)/.test(status.text), status.text);
  check("a3 remembered in the plugin's data (a restart doesn't re-notify)", Object.keys(q.data.repeats).includes("metals.Topic:HomeTwoDoors|401"), JSON.stringify(q.data.repeats));
  // a restart: a fresh plugin over the same saved data doesn't notice it again
  const q2 = new DieselSyncPlugin(a as any, {} as any); (q2 as any).stored = (q as any).stored; q2.now = () => now;
  (q2 as any).getRemote = (q as any).getRemote; (q2 as any).http = (q as any).http; (q2 as any).autoUpload = async () => {}; (q2 as any).saveLog = async () => {};
  await q2.onload(); at = n0(); await q2.syncAll(true);
  check("a4 after a restart the same 401 stays quiet", said(at, /HomeTwoDoors/) === 0, notices.slice(at).join(" | "));

  // (b) the 401 clears, then returns: a second notice
  home = 200; at = n0(); await quiet(2);
  check("b1 cleared: no notice, forgotten", notices.length === at && !Object.keys(q.data.repeats).some((k) => k.startsWith("metals.Topic:HomeTwoDoors")), JSON.stringify(q.data.repeats));
  home = 401; at = n0(); await quiet(3);
  check("b2 back again: a 2nd notice, once", said(at, /HomeTwoDoors/) === 1, notices.slice(at).join(" | "));
  // a day on, still repeating: said again, once
  now += 86_400_000; at = n0(); await quiet(2);
  check("b3 still repeating a day later: said once more", said(at, /HomeTwoDoors/) === 1, notices.slice(at).join(" | "));
  home = 200; await quiet(1);

  // (c) a realm refusing the login on 3 quiet syncs: 1 notice, naming the fix
  q.data.settings.d2Projects = "d2spec = d2t_x"; link("Diesel/d2spec/Topic/Spec.md", "d2spec.Topic:Spec"); link("Diesel/d2spec/Topic/Other.md", "d2spec.Topic:Other");
  at = n0(); await quiet(3);
  check("c1 refused login on 3 quiet syncs: 1 notice in all", notices.length - at === 1, notices.slice(at).join(" | "));
  check("c2 it names the fix", said(at, /d2spec refused the token: make a new one at https:\/\/d2spec\.ai-putty\.com\/ai\/tokens and put it on its line/) === 1, notices.slice(at).join(" | "));
  now += 86_400_000; at = n0(); await quiet(2);
  check("c3 the next day: said once more", said(at, /d2spec refused the token/) === 1, notices.slice(at).join(" | "));
  q.data.settings.d2Projects = ""; v.files.delete("Diesel/d2spec/Topic/Spec.md"); v.files.delete("Diesel/d2spec/Topic/Other.md");
  delete q.data.state["Diesel/d2spec/Topic/Spec.md"]; delete q.data.state["Diesel/d2spec/Topic/Other.md"];

  // (d) a d1 realm that is also a d2 project: 1 notice per day, and nothing moved
  isD2 = true; now += 86_400_000; at = n0(); await quiet(3);
  check("d1 d1 realm that is a d2 project: 1 notice on 3 syncs", said(at, /metals is synced with d1 \(metals\.dieselapps\.com\), but it is also one of your d2 projects: add `metals` to \*d2 projects\*/) === 1 && notices.length - at === 1, notices.slice(at).join(" | "));
  check("d2 nothing moved: metals is still d1", !q.d2("metals") && q.data.settings.d2Projects === "");
  now += 86_400_000; at = n0(); await quiet(2);
  check("d3 the next day: said once more", said(at, /also one of your d2 projects/) === 1, notices.slice(at).join(" | "));
  isD2 = false;

  // (e) a manual Sync all still shows its summary each time, repeating error or not
  home = 401; at = n0(); await q.syncAll(); await q.syncAll(); await q.syncAll();
  check("e1 manual Sync all: its summary every time", notices.slice(at).filter((m) => /^Diesel: .*1 error/.test(m)).length === 3, notices.slice(at).join(" | "));
}
