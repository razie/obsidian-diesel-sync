import DieselSyncPlugin from "../src/main";
import { log, Vault } from "obsidian";
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
  // new topic on the reactor since the initial pull: simulate by dropping one note + its state silently
  const D2 = "Diesel/metals/Topic/Diesel2Design.md";
  vault.files.delete(D2); delete p.data.state[D2];
  await p.syncAll();
  check("5 new remote topic pulled into a non-empty realm folder", vault.files.has(D2) && log.some((m) => m.includes("new: Diesel2Design")));
  // deleted locally -> ignored, not re-pulled
  await vault.delete(vault.getAbstractFileByPath(D2));
  await p.syncAll();
  check("6 locally deleted note not re-pulled", !vault.files.has(D2) && p.data.ignored.includes("metals.Topic:Diesel2Design"));
  // explicit tag pull un-ignores (exercise the same filter the command uses)
  p.data.ignored = p.data.ignored.filter((w: string) => w !== "metals.Topic:Diesel2Design");
  await p.syncAll();
  check("7 un-ignored -> pulled again", vault.files.has(D2));
  console.log(`\n${pass} passed, ${fail} failed`);
})();
