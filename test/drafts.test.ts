import DieselSyncPlugin from "../src/main";
import { Vault, log as notices, status } from "obsidian";
// offline (0.9.0): d2 wins, local edits go as drafts. A local edit is saved as the topic's draft, never onto the topic;
// d2 moving under a local edit, or a discarded draft, puts d2's text in the note and the local text in
// <name>.local-conflict.md; no conflict markers are ever written. d2 is faked at http(). npm run test:drafts
const vault = new Vault();
const app = { vault, workspace: { on: () => ({}), getActiveFile: () => null, getLeaf: () => ({ openFile: async () => {} }) } };
const p = new DieselSyncPlugin(app as any, {} as any);
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} ${n} ${x}`); };

// a fake d2 project: published topics and this account's drafts
const topics = new Map<string, { text: string; ver: number }>(), drafts = new Map<string, { text: string; dver: number }>();
let topicWrites = 0, draftPuts = 0;
const json = (status: number, j: any, headers: Record<string, string> = {}) => ({ status, json: j, text: JSON.stringify(j), headers });
(p as any).http = async (o: { url: string; method?: string; headers?: Record<string, string>; body?: string }) => {
  const m = o.method ?? "GET", u = new URL(o.url), path = decodeURIComponent(u.pathname);
  let k: RegExpExecArray | null;
  if ((k = /^\/api\/v2\/topics\/(.+)$/.exec(path))) {
    if (m !== "GET") { topicWrites++; return json(500, { error: "a topic write" }); }
    const t = topics.get(k[1]); return t ? json(200, { name: k[1], text: t.text, ver: t.ver }) : json(404, { ok: false });
  }
  if (path === "/api/v2/topics") return json(200, { data: [] });
  if ((k = /^\/api\/v2\/drafts\/(.+)$/.exec(path))) {
    const d = drafts.get(k[1]), etag = d ? `"d${d.dver}"` : `"none"`;
    if (m === "GET") return d ? json(200, { text: d.text, dver: d.dver, base: topics.get(k[1])?.ver ?? 0 }, { etag }) : json(404, { ok: false, error: { code: "E_NOT_FOUND" } });
    if (m === "PUT") {
      draftPuts++;
      if (o.headers?.["If-Match"] !== etag) return json(409, { ok: false, error: { code: "E_DRAFT_CHANGED", message: `the draft is at ${etag}` } });
      const n = { text: o.body!, dver: (d?.dver ?? 0) + 1 }; drafts.set(k[1], n);
      return json(200, { ok: true, draft: true, dver: n.dver }, { etag: `"d${n.dver}"` });
    }
  }
  return json(404, { ok: false });
};
const publish = (n: string) => { const d = drafts.get(n)!; topics.set(n, { text: d.text, ver: (topics.get(n)?.ver ?? 0) + 1 }); drafts.delete(n); };
const d2edit = (n: string, text: string) => topics.set(n, { text, ver: topics.get(n)!.ver + 1 });
const markers = () => [...vault.files.entries()].filter(([, c]) => /^(vvvvvvv obsidian|\^\^\^\^\^\^\^ (vs|end))/m.test(c)).map(([f]) => f);
const sync = async () => { const n = notices.length; await p.syncAll(); return notices.slice(n); };

(async () => {
  await p.onload();
  Object.assign(p.data.settings, { user: "", password: "", d1Sync: true, d2Projects: "proj = d2t_x", initialPullQuery: "", pullNewTopics: false, logOnErrors: false });
  const A = "Diesel/proj/Topic/A.md", ALC = "Diesel/proj/Topic/A.local-conflict.md";
  topics.set("A", { text: "# A\n\none\n", ver: 1 }); vault.files.set(A, "# A\n\none\n");
  await sync();
  check("0 linked in sync", p.data.state[A]?.ver === 1 && !p.data.state[A]?.dhash);

  // 1 an edit makes a draft, not a topic version
  vault.files.set(A, "# A\n\none\ntwo from obsidian\n"); await sync();
  check("1 an edit makes a draft, not a topic version", drafts.get("A")?.text === "# A\n\none\ntwo from obsidian\n" && topics.get("A")!.ver === 1 && topicWrites === 0, JSON.stringify(drafts.get("A")));
  check("1b the state keeps the draft's version, ETag and hash", p.data.state[A].dver === 1 && p.data.state[A].etag === '"d1"' && !!p.data.state[A].dhash && p.data.state[A].ver === 1);
  check("1c the status bar says draft pending, linking to the draft in d2", /1 drafted/.test(status.text) && p.statusLink === "https://proj.ai-putty.com/topics/A?draft=1", `${status.text} ${p.statusLink}`);
  let puts = draftPuts; await sync();
  check("2 the note equals its draft: nothing pushed or pulled", draftPuts === puts && /1 draft pending/.test(status.text) && p.statusLink.endsWith("/topics/A?draft=1"), status.text);
  vault.files.set(A, "# A\n\none\ntwo from obsidian\nthree\n"); await sync();
  check("2b a further edit saves the draft again over its ETag", drafts.get("A")?.dver === 2 && drafts.get("A")!.text.endsWith("three\n") && p.data.state[A].etag === '"d2"');

  // 3 a published draft syncs back as in-sync
  publish("A"); await sync();
  check("3 a published draft syncs back as in-sync", /1 in-sync/.test(status.text) && p.data.state[A].ver === 2 && !p.data.state[A].dhash && !vault.files.has(ALC) && p.statusLink === "", status.text);

  // 4 a newer topic over a local edit: d2's text in the note, the local text beside it
  vault.files.set(A, "# A\n\nmine\n"); d2edit("A", "# A\n\nd2's newer text\n");
  let said = await sync();
  check("4 a newer topic over a local edit: d2's text in the note", vault.files.get(A) === "# A\n\nd2's newer text\n" && p.data.state[A].ver === 3, vault.files.get(A));
  check("4b the local text in .local-conflict.md", vault.files.get(ALC) === "# A\n\nmine\n");
  check("4c one notice naming the copy", said.filter(m => m === "Diesel: d2 changed proj.Topic:A; your version is in A.local-conflict.md").length === 1, said.join(" | "));
  check("4d the copy isn't synced as a topic", !drafts.has("A.local-conflict") && !Object.values(p.data.state).some(s => s.wpath.includes("local-conflict")));
  vault.files.delete(ALC);

  // 5 a newer topic over a pending draft: d2 wins, the draft stays in d2
  vault.files.set(A, "# A\n\ndrafted\n"); await sync();
  d2edit("A", "# A\n\nd2 again\n"); await sync();
  check("5 a newer topic over a pending draft: note follows d2, local beside it, draft kept in d2", vault.files.get(A) === "# A\n\nd2 again\n" && vault.files.get(ALC) === "# A\n\ndrafted\n" && drafts.get("A")?.text === "# A\n\ndrafted\n" && !p.data.state[A].dhash);
  vault.files.delete(ALC); drafts.delete("A");

  // 6 a discarded draft makes the note follow the topic
  vault.files.set(A, "# A\n\nto discard\n"); await sync(); drafts.delete("A");
  said = await sync();
  check("6 a discarded draft makes the note follow the topic", vault.files.get(A) === topics.get("A")!.text && vault.files.get(ALC) === "# A\n\nto discard\n" && !p.data.state[A].dhash, vault.files.get(A));
  check("6b said once", said.filter(m => /the draft of proj\.Topic:A was discarded in d2; your version is in A\.local-conflict\.md/.test(m)).length === 1, said.join(" | "));
  vault.files.delete(ALC);

  // 7 a draft changed in d2 (razie edited it there): the note follows the draft
  vault.files.set(A, "# A\n\nfrom here\n"); await sync();
  drafts.set("A", { text: "# A\n\nrazie fixed it in d2\n", dver: drafts.get("A")!.dver + 1 }); await sync();
  check("7 a draft changed in d2: the note follows it, still pending, no copy", vault.files.get(A) === "# A\n\nrazie fixed it in d2\n" && p.data.state[A].dhash !== undefined && !vault.files.has(ALC) && p.statusLink.endsWith("/topics/A?draft=1"), status.text);
  await sync(); check("7b then it waits as a draft", /1 draft pending/.test(status.text), status.text);
  vault.files.set(A, "# A\n\nedited here too\n"); drafts.set("A", { text: "# A\n\nand in d2\n", dver: drafts.get("A")!.dver + 1 }); await sync();
  check("7c changed in d2 and here: the note follows the draft, local beside it", vault.files.get(A) === "# A\n\nand in d2\n" && vault.files.get(ALC) === "# A\n\nedited here too\n");
  publish("A"); await sync(); vault.files.delete(ALC);

  // 8 a new note: a draft of a new topic; published, it links in sync
  const N = "Diesel/proj/Topic/New.md"; vault.files.set(N, "# New\n"); await sync();
  check("8 a new note makes a draft of a new topic", drafts.get("New")?.text === "# New\n" && !topics.has("New") && p.data.state[N]?.ver === 0 && topicWrites === 0);
  puts = draftPuts; await sync();
  check("8b still a draft: left alone, not deleted", vault.files.has(N) && draftPuts === puts);
  publish("New"); await sync();
  check("8c published: in sync", p.data.state[N]?.ver === 1 && !p.data.state[N]?.dhash);

  // 9 a note first paired with a different existing topic: d2 wins
  const B = "Diesel/proj/Topic/B.md"; topics.set("B", { text: "# B in d2\n", ver: 4 }); vault.files.set(B, "# B here\n"); await sync();
  check("9 never linked, different: d2's text in the note, local beside it", vault.files.get(B) === "# B in d2\n" && vault.files.get("Diesel/proj/Topic/B.local-conflict.md") === "# B here\n");

  // 10 Push as draft now writes over a draft in d2
  drafts.set("B", { text: "# someone's draft\n", dver: 5 }); vault.files.set(B, "# B mine now\n");
  await p.pushDraftNow(vault.getAbstractFileByPath(B) as any);
  check("10 push as draft now: over the draft's ETag", drafts.get("B")?.text === "# B mine now\n" && drafts.get("B")?.dver === 6 && topicWrites === 0);

  // 11 d1 has no drafts: an edit goes onto the topic; a clash keeps the reactor's text, no merge
  const v1 = new Vault(), q = new DieselSyncPlugin({ ...app, vault: v1 } as any, {} as any), d1 = new Map<string, { text: string; ver: number }>(); let d1writes = 0;
  (q as any).getRemote = async (w: string) => { const t = d1.get(w); return t ? { realm: "metals", category: "Topic", name: w.split(":")[1], content: t.text, ver: t.ver, tags: [] } : null; };
  (q as any).write = async (_k: string, w: string, c: string) => { d1writes++; d1.set(w, { text: c, ver: (d1.get(w)?.ver ?? 0) + 1 }); };
  (q as any).tagQuery = async () => []; (q as any).http = async () => json(404, null);
  await q.onload(); Object.assign(q.data.settings, { user: "u", password: "p", d2Projects: "", initialPullQuery: "", pullNewTopics: false, logOnErrors: false });
  const M = "Diesel/metals/Topic/M.md"; d1.set("metals.Topic:M", { text: "# M\n", ver: 1 }); v1.files.set(M, "# M\n"); await q.syncAll();
  v1.files.set(M, "# M\nedit\n"); await q.syncAll();
  check("11 d1: an edit is saved onto the topic", d1.get("metals.Topic:M")?.text === "# M\nedit\n" && d1writes === 1);
  v1.files.set(M, "# M\nlocal\n"); d1.set("metals.Topic:M", { text: "# M\nreactor\n", ver: 3 }); await q.syncAll();
  check("11b d1 clash: the reactor's text in the note, local beside it", v1.files.get(M) === "# M\nreactor\n" && v1.files.get("Diesel/metals/Topic/M.local-conflict.md") === "# M\nlocal\n" && d1writes === 1);

  check("12 no markers are ever written", markers().length === 0 && ![...v1.files.values()].some(c => /^vvvvvvv obsidian/m.test(c)), markers().join(", "));
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
