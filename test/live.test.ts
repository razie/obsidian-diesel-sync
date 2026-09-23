import DieselSyncPlugin from "../src/main";
import { Vault, TFile } from "obsidian";
const AUTH = process.env.DIESEL_AUTH; // base64 of user:pass
if (!AUTH) { console.error("set DIESEL_AUTH=base64(user:pass)"); process.exit(1); }
const [user, password] = Buffer.from(AUTH, "base64").toString().split(/:(.*)/s);
const vault = new Vault();
const app = { vault, workspace: { getActiveFile: () => null, getLeaf: () => ({ openFile: async () => {} }) } };
const p = new DieselSyncPlugin(app as any, {} as any);
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} ${name} ${extra}`); };
const A = "metals.Topic:ClaudeTestSyncA", Bw = "metals.Topic:ClaudeTestSyncB";
const PA = "Scratch/CT-ClaudeTestSyncA.md";
(async () => {
  await p.onload();
  Object.assign(p.data.settings, { user, password, mappings: "Scratch | metals.Topic | CT- | claude,test" });
  try {
    vault.files.set(PA, "# Sync A\n\nline one\n");
    await p.syncAll(); let r = await p.getRemote(A);
    check("1 create from local", !!r && r.content.includes("line one") && r.tags.includes("claude") && r.tags.includes("test"), JSON.stringify(r?.tags));
    const before = vault.files.get(PA);
    await p.syncAll();
    check("2 second sync is in-sync", p.statusEl && vault.files.get(PA) === before && !vault.files.has(PA.replace(".md", ".diesel-conflict.md")));
    vault.files.set(PA, "# Sync A\n\nline one\nline two local\n");
    await p.syncAll(); r = await p.getRemote(A);
    check("3 local edit pushed", !!r && r.content.includes("line two local"), `ver=${r?.ver}`);
    await p.write("update", A, "# Sync A\n\nline one\nline two local\nline three remote\n"); await p.confirm(A, r!.ver, "");
    await p.syncAll();
    check("4 remote edit pulled", vault.files.get(PA)!.includes("line three remote"));
    r = await p.getRemote(A);
    await p.write("update", A, r!.content + "remote both\n"); await p.confirm(A, r!.ver, "");
    vault.files.set(PA, vault.files.get(PA)! + "local both\n");
    await p.syncAll();
    const CP = PA.replace(".md", ".diesel-conflict.md");
    check("5 both edited -> conflict copy", vault.files.has(CP) && vault.files.get(CP)!.includes("remote both") && vault.files.get(PA)!.includes("local both"));
    vault.files.set(PA, vault.files.get(PA)!.replace("local both\n", "remote both\nlocal both\n"));
    await p.forcePush(vault.getAbstractFileByPath(PA) as TFile); r = await p.getRemote(A);
    check("6 force push resolves", !!r && r.content.includes("remote both\nlocal both") && !vault.files.has(CP));
    await p.syncAll();
    check("7 after resolve: in-sync, no new conflict", !vault.files.has(CP));
    await p.write("create", Bw, "# Sync B\n\nremote only\n");
    const pb = p.pathFor(Bw); await p.syncPair(pb, Bw);
    check("8 remote-only topic pulled to mapped path", pb === "Scratch/CT-ClaudeTestSyncB.md" && vault.files.get(pb)?.includes("remote only") === true, pb);
    let err = ""; try { await p.getRemote("metals.Topic:NoSuchTopicXyz"); } catch (e) { err = String(e); }
    check("9 missing topic reads as null", err === "");
    const st = p.data.state[PA]; await vault.handlers.rename({ path: "Scratch/CT-Renamed.md" }, PA);
    check("10 rename keeps link", p.data.state["Scratch/CT-Renamed.md"]?.wpath === A && !p.data.state[PA]);
  } finally {
    for (const w of [A, Bw]) {
      const res = await fetch(`https://metals.dieselapps.com/api/v1/wiki/delete/${w}`, { method: "POST", headers: { Authorization: "Basic " + AUTH } });
      console.log("cleanup", w, res.status);
    }
    console.log(`\n${pass} passed, ${fail} failed`);
  }
})();
