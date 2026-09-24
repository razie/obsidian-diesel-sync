import DieselSyncPlugin from "../src/main";
import { Vault, TFile, log } from "obsidian";
const AUTH = process.env.DIESEL_AUTH; // base64 of user:pass
if (!AUTH) { console.error("set DIESEL_AUTH=base64(user:pass)"); process.exit(1); }
const [user, password] = Buffer.from(AUTH, "base64").toString().split(/:(.*)/s);
const vault = new Vault();
const app = { vault, workspace: { on: () => ({}), getActiveFile: () => null, getLeaf: () => ({ openFile: async () => {} }) } };
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
    check("5b overlap is marked inline", vault.files.get(PA)!.includes("vvvvvvv obsidian") && vault.files.get(PA)!.includes("remote both"));
    vault.files.set(PA, vault.files.get(CP)! + "local both\n");
    await p.forcePush(vault.getAbstractFileByPath(PA) as TFile); r = await p.getRemote(A);
    check("6 force push resolves", !!r && r.content.includes("remote both\nlocal both") && !vault.files.has(CP));
    await p.syncAll();
    check("7 after resolve: in-sync, no new conflict", !vault.files.has(CP));
    await p.write("create", Bw, "# Sync B\n\nremote only\n");
    const pb = p.pathFor(Bw); await p.syncPair(pb, Bw);
    check("8 remote-only topic pulled to mapped path", pb === "Scratch/CT-ClaudeTestSyncB.md" && vault.files.get(pb)?.includes("remote only") === true, pb);
    let err = ""; try { await p.getRemote("metals.Topic:NoSuchTopicXyz"); } catch (e) { err = String(e); }
    check("9 missing topic reads as null", err === "");
    // --- inline merge (0.3.0) ---
    const edit = async (f: (c: string) => string) => { const x = await p.getRemote(A); await p.write("update", A, f(x!.content)); await p.confirm(A, x!.ver, ""); };
    vault.files.set(PA, vault.files.get(PA)!.replace("line one", "line ONE local"));
    await edit((c) => c + "remote tail\n");
    let o = await p.syncPair(PA, A); r = await p.getRemote(A);
    check("11 non-overlapping edits auto-merge", o === "merged" && vault.files.get(PA)!.includes("line ONE local") && vault.files.get(PA)!.includes("remote tail")
      && r!.content.includes("line ONE local") && r!.content.includes("remote tail") && !vault.files.has(CP), o);
    vault.files.set(PA, vault.files.get(PA)!.replace("line two local", "line two L"));
    await edit((c) => c.replace("line two local", "line two R"));
    o = await p.syncPair(PA, A); r = await p.getRemote(A);
    const L = vault.files.get(PA)!;
    check("12 overlapping edit -> markers + conflict copy", o === "conflict" && /vvvvvvv obsidian\nline two L\n\^{7} vs vvvvvvv diesel v\d+\nline two R\n\^{7} end/.test(L)
      && vault.files.has(CP) && r!.content.includes("line two R") && !r!.content.includes("vvvvvvv"), o);
    const ver12 = r!.ver;
    o = await p.syncPair(PA, A); r = await p.getRemote(A);
    check("13 marked note is not pushed", o === "unresolved" && r!.ver === ver12 && !r!.content.includes("vvvvvvv"), o);
    await p.forcePush(vault.getAbstractFileByPath(PA) as TFile); r = await p.getRemote(A);
    check("14 force push refused while markers remain", r!.ver === ver12 && log.some((m) => m.includes("conflict markers")));
    vault.files.set(PA, L.replace(/vvvvvvv obsidian\n[\s\S]*?\^{7} end\n/, "line two LR\n"));
    o = await p.syncPair(PA, A); r = await p.getRemote(A);
    check("15 resolved note pushes, conflict copy dropped", o === "pushed" && r!.content.includes("line two LR") && !r!.content.includes("line two R\n") && !vault.files.has(CP), o);
    vault.hidden.clear();
    vault.files.set(PA, vault.files.get(PA)!.replace("# Sync A", "# Sync A local"));
    await edit((c) => c + "remote again\n");
    o = await p.syncPair(PA, A);
    check("16 no base -> two-way, every difference marked", o === "conflict" && (vault.files.get(PA)!.match(/vvvvvvv obsidian/g) || []).length === 2 && log.some((m) => m.includes("no merge base")), o);
    await p.forcePull(vault.getAbstractFileByPath(PA) as TFile); r = await p.getRemote(A);
    check("17 force pull clears markers + copy", vault.files.get(PA) === r!.content && !vault.files.has(CP));

    // --- sync only local edits (0.3.2) ---
    p.s.syncOnlyLocalEdits = true; p.dirty.clear();
    vault.files.set(PA, "via obsidian sync\n" + vault.files.get(PA)!); // written, not typed here
    await edit((c) => c + "remote meanwhile\n");
    let r0 = await p.getRemote(A);
    o = await p.syncPair(PA, A); r = await p.getRemote(A);
    check("18 untyped local change left alone", o === "elsewhere" && r!.ver === r0!.ver && !vault.files.get(PA)!.includes("vvvvvvv"), o);
    p.dirty.add(PA);
    o = await p.syncPair(PA, A); r = await p.getRemote(A);
    check("19 typed here -> merged + dirty cleared", o === "merged" && r!.content.includes("via obsidian sync") && r!.content.includes("remote meanwhile") && !p.dirty.has(PA), o);
    await edit((c) => c + "diesel web edit\n");
    o = await p.syncPair(PA, A);
    check("20 remote-only change still pulls", o === "pulled" && vault.files.get(PA)!.includes("diesel web edit"), o);
    p.s.syncOnlyLocalEdits = false;

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
