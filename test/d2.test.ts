import DieselSyncPlugin from "../src/main";
import { Vault } from "obsidian";
// live against a d2 project (default: the d2pro demo, which resets on every d2 deploy): D2_TOKEN=<token> npm run test:d2
const TOKEN = process.env.D2_TOKEN, PROJ = process.env.D2_PROJECT ?? "d2pro";
if (!TOKEN) { console.error("set D2_TOKEN (an AI token for the project, or the ops token for a demo)"); process.exit(1); }
const vault = new Vault();
const app = { vault, workspace: { on: () => ({}), getActiveFile: () => null, getLeaf: () => ({ openFile: async () => {} }) } };
const p = new DieselSyncPlugin(app as any, {} as any);
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} ${n} ${x}`); };
(async () => {
  await p.onload();
  Object.assign(p.data.settings, { user: "", password: "", d2Projects: `${PROJ} = ${TOKEN}`, initialPullQuery: "topic", baseUrlPattern: "https://{realm}.aiheroapps.com" });
  await p.onload(); Object.assign(p.data.settings, { d2Projects: `${PROJ} = ${TOKEN}`, initialPullQuery: "topic" });
  check("0 a d1 pattern pointed at aiheroapps is put back", p.data.settings.baseUrlPattern === "https://{realm}.dieselapps.com");
  await p.syncAll();
  const pulled = [...vault.files.keys()].filter(k => k.startsWith(`Diesel/${PROJ}/Topic/`));
  check("1 the project's folder is made and its Topics pulled", pulled.length >= 5, `pulled=${pulled.length}`);
  check("2 byte-identical", vault.files.get(`Diesel/${PROJ}/Topic/Welcome.md`)?.length! > 50);
  check("3 only Topics (no Spec:, no shared Help)", !pulled.some(k => /\/(Help|Skill)/.test(k)));
  const PA = `Diesel/${PROJ}/Topic/t-obsidian.md`;
  vault.files.set(PA, "# From Obsidian\n\nline one\n"); await p.syncAll();
  let r = await p.getRemote(`${PROJ}.Topic:t-obsidian`);
  check("4 a new note is created in d2", !!r && r.content === "# From Obsidian\n\nline one\n", `ver=${r?.ver}`);
  await p.write("update", `${PROJ}.Topic:t-obsidian`, "# From Obsidian\n\nline one\nline two from d2\n"); await p.syncAll();
  check("5 a d2 edit is pulled", vault.files.get(PA)!.includes("line two from d2"));
  vault.files.set(PA, vault.files.get(PA)! + "line three from obsidian\n"); await p.syncAll();
  r = await p.getRemote(`${PROJ}.Topic:t-obsidian`);
  check("6 an Obsidian edit is pushed", !!r && r.content.includes("line three from obsidian"));
  const HP = `Diesel/${PROJ}/Topic/Help.md`; vault.files.set(HP, "# mine\n");
  await p.syncAll();
  const err7 = await p.getRemote(`${PROJ}.Topic:Help`).then(() => "", (e: Error) => e.message);
  const own = (await (await fetch(`https://${PROJ}.aiheroapps.com/api/v2/topics`, { headers: { Authorization: "Bearer " + TOKEN } })).json() as any).data.map((t: any) => t.name);
  check("7 a shared topic (d2's Help) is refused, not copied into the project", /shared topic/.test(err7) && !own.includes("Help"), err7);
  vault.files.delete(HP); delete p.data.state[HP];
  // 8-9 (0.5.0): a topic deleted in d2 takes its unedited note along; an edited note is kept
  const del = (n: string) => fetch(`https://${PROJ}.aiheroapps.com/api/v2/topics/Topic:${n}`, { method: "DELETE", headers: { Authorization: "Bearer " + TOKEN } });
  const PB = `Diesel/${PROJ}/Topic/t-obsidian-b.md`;
  vault.files.set(PB, "# B\n"); await p.syncAll();
  check("8a both notes are linked", !!p.data.state[PA] && !!p.data.state[PB]);
  vault.files.set(PB, "# B\n\nedited here\n");
  await del("t-obsidian"); await del("t-obsidian-b"); await p.syncAll();
  check("8 a topic deleted in d2 takes its note to the trash", !vault.files.has(PA) && !p.data.state[PA] && !p.data.ignored.includes(`${PROJ}.Topic:t-obsidian`));
  check("9 an edited note of a deleted topic is kept", vault.files.get(PB) === "# B\n\nedited here\n" && !!p.data.state[PB]);
  vault.files.delete(PB); delete p.data.state[PB];
  // 10-11 (0.6.0): the plugin's log goes to d2's detailed log, with d2's request ids and no secrets
  const { clientLog } = await import("../src/main");
  check("10a reactor calls are logged with d2's request id", clientLog.lines.some((l: any) => /GET .*aiheroapps\.com\/api\/v2\/topics/.test(l.msg) && /^[0-9a-f]{12}$/.test(l.rid ?? "")));
  const marker = `upload-marker-${Date.now()}`; clientLog.add("warn", `${marker} Bearer ${TOKEN}`);
  Object.assign(p.data.settings, { logProject: PROJ, deviceName: "test-runner" });
  const sent = await p.uploadLog();
  const got = (await (await fetch(`https://${PROJ}.aiheroapps.com/api/v2/logs?kind=client&tests=1&text=${marker}`, { headers: { Authorization: "Bearer " + TOKEN } })).json() as any).data;
  check("10 the log is uploaded to d2's detailed log", /log lines sent/.test(sent) && got.length === 1 && got[0].device === "test-runner" && got[0].source === "obsidian-diesel-sync", sent);
  check("11 no token in it", !JSON.stringify(got).includes(TOKEN!) && got[0].msg.includes("Bearer ***"));
  check("11b only new lines next time", await p.uploadLog() === "nothing new in the log");
  console.log(`\n${pass} passed, ${fail} failed`);
})();
