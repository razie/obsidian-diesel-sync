import DieselSyncPlugin from "../src/main";
import { Vault } from "obsidian";
// offline: topics deleted on the reactor (0.5.0), with the remote faked. npm run test:deletes
const vault = new Vault();
const app = { vault, workspace: { on: () => ({}), getActiveFile: () => null, getLeaf: () => ({ openFile: async () => {} }) } };
const p = new DieselSyncPlugin(app as any, {} as any);
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} ${n} ${x}`); };
const remote = new Map<string, string>();
(p as any).getRemote = async (w: string) => remote.has(w) ? { realm: w.split(".")[0], category: "Topic", name: w.split(":")[1], content: remote.get(w), ver: 1, tags: [] } : null;
(p as any).tagQuery = async () => [];
const note = (i: number) => `Diesel/metals/Topic/n${i}.md`, w = (i: number) => `metals.Topic:n${i}`;
(async () => {
  await p.onload(); Object.assign(p.data.settings, { user: "u", password: "p", initialPullQuery: "" });
  for (let i = 0; i < 10; i++) { remote.set(w(i), `# n${i}\n`); vault.files.set(note(i), `# n${i}\n`); }
  await p.syncAll();
  check("0 linked", Object.keys(p.data.state).length === 10);
  remote.delete(w(0)); remote.delete(w(1)); vault.files.set(note(1), "# n1\nedited\n");
  await p.syncAll();
  check("1 unedited note of a deleted topic is trashed", !vault.files.has(note(0)) && !p.data.state[note(0)]);
  check("2 an edited one is kept, still linked", vault.files.has(note(1)) && !!p.data.state[note(1)]);
  check("3 not put on the ignored list", !p.data.ignored.includes(w(0)));
  remote.set(w(0), "# n0 back\n"); await p.syncOneReport(vault.getAbstractFileByPath(note(1)) as any);
  for (let i = 2; i < 10; i++) remote.delete(w(i));
  await p.syncAll();
  check("4 most of a realm gone at once: nothing deleted", [2, 3, 4, 5, 6, 7, 8, 9].every(i => vault.files.has(note(i))));
  p.data.settings.deleteRemoved = false; remote.set(w(2), "# n2\n"); for (let i = 3; i < 10; i++) remote.set(w(i), `# n${i}\n`); remote.delete(w(9));
  await p.syncAll();
  check("5 setting off: kept", vault.files.has(note(9)));
  p.data.settings.deleteRemoved = true; await p.syncAll();
  check("6 a few at once: deleted", !vault.files.has(note(9)));
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
