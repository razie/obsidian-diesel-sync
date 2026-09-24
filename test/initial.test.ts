import DieselSyncPlugin from "../src/main";
import { Vault } from "obsidian";
const AUTH = process.env.DIESEL_AUTH; if (!AUTH) { console.error("set DIESEL_AUTH"); process.exit(1); }
const [user, password] = Buffer.from(AUTH, "base64").toString().split(/:(.*)/s);
const vault = new Vault();
const app = { vault, workspace: { on: () => ({}), getActiveFile: () => null, getLeaf: () => ({ openFile: async () => {} }) } };
const p = new DieselSyncPlugin(app as any, {} as any);
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} ${n} ${x}`); };
(async () => {
  await p.onload();
  Object.assign(p.data.settings, { user, password, initialPullQuery: "topic/-hq" });
  await p.syncAll();
  check("0 no root folder -> nothing pulled", vault.files.size === 0);
  vault.folders.add("Diesel"); vault.folders.add("Diesel/metals");
  await p.syncAll();
  const pulled = [...vault.files.keys()].filter(k => k.startsWith("Diesel/metals/Topic/"));
  check("1 empty realm folder -> initial pull of topic/-hq", pulled.length >= 51, `pulled=${pulled.length}`);
  check("2 excluded hq topics not pulled", !pulled.some(k => /HQ-/.test(k)));
  check("3 content is byte-identical", vault.files.get("Diesel/metals/Topic/Diesel2.md")?.startsWith("Specification for diesel2") === true);
  const n = vault.files.size; await p.syncAll();
  check("4 second sync: no re-pull, all in-sync", vault.files.size === n && Object.keys(p.data.state).length === pulled.length);
  console.log(`\n${pass} passed, ${fail} failed`);
})();
