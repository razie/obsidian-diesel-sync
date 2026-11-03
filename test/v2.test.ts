import DieselSyncPlugin, { stopWhy } from "../src/main";
import { Vault, log as notices } from "obsidian";
import { createServer } from "node:http";
// offline (0.10.0): the plugin calls only d2's /api/v2 routes, and a realm answering "this will never work" (a route
// gone, 410, a refused token) is stopped: one notice, and the timer never calls it again until a sync by hand or new
// settings. A realm answering 5xx backs off. A fake d2 on 127.0.0.1 answers today's routes. npm run test:v2
const vault = new Vault();
const app = { vault, workspace: { on: () => ({}), getActiveFile: () => null, getLeaf: () => ({ openFile: async () => {} }) } };
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} ${n} ${x}`); };

// ---- the fake d2 ----
type Mode = "ok" | "routeGone" | "gone" | "auth" | "private" | "down";
let mode: Mode = "ok", rev = 1;
const topics = new Map<string, string>(), drafts = new Map<string, { text: string; dver: number }>();
for (let i = 0; i < 230; i++) topics.set(`T${String(i).padStart(3, "0")}`, `# T${i}\n`);
const calls: string[] = [];
const server = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const u = new URL(req.url!, "http://x"), path = decodeURIComponent(u.pathname), m = req.method!;
    calls.push(`${m} ${path}${u.search}`);
    const send = (s: number, j: unknown, h: Record<string, string> = {}) => { res.writeHead(s, { "Content-Type": "application/json", ...h }); res.end(JSON.stringify(j)); };
    if (mode === "routeGone") return send(404, { ok: false, error: { code: "E_NOT_FOUND", message: `no route ${m} ${path}` } });
    if (mode === "gone") return send(410, { ok: false, error: { code: "E_MOVED", message: "moved" } });
    if (mode === "auth") return send(401, { ok: false, error: { code: "E_AUTH", message: "this token isn't one d2 issued: send the whole value, or mint a new one" } });
    if (mode === "private") return send(401, { ok: false, error: { code: "E_PRIVATE", message: "proj is for its members" } });
    if (mode === "down") { res.writeHead(502); return res.end("bad gateway"); }
    if (path.startsWith("/api/v1/")) return send(404, { ok: false, error: { code: "E_NOT_FOUND", message: "all routes are under /api/v2" } });
    if (path === "/api/v2/revs") return send(200, { ok: true, topics: { Topic: rev } });
    if (path === "/api/v2/d2/Topic" && m === "GET") {
      const limit = Number(u.searchParams.get("limit")) || 100, after = u.searchParams.get("after") ?? "";
      const names = [...topics.keys()].sort().filter((n) => n > after).slice(0, limit);
      return send(200, { ok: true, entity: "Topic", data: names.map((name) => ({ name, category: "Topic", tags: [] })), limit, next: names[names.length - 1], count: names.length });
    }
    let k: RegExpExecArray | null;
    if ((k = /^\/api\/v2\/topics\/(.+)$/.exec(path)) && m === "GET") {
      const t = topics.get(k[1]); return t !== undefined ? send(200, { name: k[1], text: t, ver: 1 }) : send(404, { ok: false, error: { code: "E_NOT_FOUND", message: `no topic '${k[1]}'` } });
    }
    if ((k = /^\/api\/v2\/drafts\/(.+)$/.exec(path))) {
      const d = drafts.get(k[1]), etag = d ? `"d${d.dver}"` : `"none"`;
      if (m === "GET") return d ? send(200, { text: d.text, dver: d.dver }, { etag }) : send(404, { ok: false, error: { code: "E_NOT_FOUND", message: `no draft of '${k[1]}'` } });
      if (m === "PUT") {
        if (req.headers["if-match"] !== etag) return send(409, { ok: false, error: { code: "E_DRAFT_CHANGED", message: `the draft is at ${etag}` } });
        const n = { text: body, dver: (d?.dver ?? 0) + 1 }; drafts.set(k[1], n);
        return send(200, { ok: true, draft: true, dver: n.dver }, { etag: `"d${n.dver}"` });
      }
    }
    return send(404, { ok: false, error: { code: "E_NOT_FOUND", message: `no route ${m} ${path}` } });
  });
});

(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port, D2 = `http://127.0.0.1:${port}`;
  let now = 1_000_000_000_000;
  const p = new DieselSyncPlugin(app as any, {} as any); p.now = () => now;
  (p as any).autoUpload = async () => {};
  await p.onload();
  Object.assign(p.data.settings, { user: "", password: "", d1Sync: true, d2Projects: "proj = d2t_good", baseUrlOverrides: `proj = ${D2}`,
    initialPullQuery: "topic", pullNewTopics: true, logOnErrors: false, autoSyncMinutes: 0 });
  const said = (from: number, re: RegExp) => notices.slice(from).filter((m) => re.test(m)).length;
  const quiet = async (k: number, step = 60_000) => { for (let i = 0; i < k; i++) { await p.syncAll(true); now += step; } };

  // ---- the moved calls ----
  await p.syncAll();
  const lists = calls.filter((c) => c.startsWith("GET /api/v2/d2/Topic"));
  check("V2-1 the topic list is GET /api/v2/d2/Topic with fields, every page (230 topics: 3 pages)", lists.length === 3
    && lists.every((c) => /fields=name,category,tags&limit=100/.test(c)) && /after=T099/.test(lists[1]) && /after=T199/.test(lists[2]), lists.join(" "));
  check("V2-2 every topic is pulled (not just the first page)", [...vault.files.keys()].filter((f) => f.startsWith("Diesel/proj/Topic/")).length === 230);
  check("V2-3 no deprecated GET /api/v2/topics list, no /api/v1", !calls.some((c) => /^GET \/api\/v2\/topics(\?|$)/.test(c) || c.includes("/api/v1/")), calls.filter((c) => c.includes("v1") || /topics(\?|$)/.test(c)).join(" "));
  check("V2-4 a topic is read at GET /api/v2/topics/<t>?format=json", calls.includes("GET /api/v2/topics/T000?format=json"));
  vault.files.set("Diesel/proj/Topic/T000.md", "# T0\n\nedited in obsidian\n"); calls.length = 0;
  await p.syncAll();
  check("V2-5 a local edit goes to PUT /api/v2/drafts/<t> (If-Match)", calls.includes("PUT /api/v2/drafts/T000") && drafts.get("T000")?.text === "# T0\n\nedited in obsidian\n", calls.filter((c) => c.includes("drafts")).join(" "));
  // revs: the timer re-lists only when the topic counters moved
  calls.length = 0; await quiet(1);
  const listed1 = calls.filter((c) => c.startsWith("GET /api/v2/d2/Topic")).length;
  calls.length = 0; await quiet(1);
  check("V2-6 a quiet sync with the topic counters unchanged doesn't re-list", calls.includes("GET /api/v2/revs") && !calls.some((c) => c.startsWith("GET /api/v2/d2/Topic")), `first quiet listed ${listed1}; then ${calls.filter((c) => c.includes("d2/Topic")).length}`);
  topics.set("T999", "# new\n"); rev++; calls.length = 0; await quiet(1);
  check("V2-7 counters moved: it lists and pulls the new topic", calls.some((c) => c.startsWith("GET /api/v2/d2/Topic")) && vault.files.get("Diesel/proj/Topic/T999.md") === "# new\n");
  check("V2-8 nothing stopped while d2 answers", Object.keys(p.data.stopped).length === 0, JSON.stringify(p.data.stopped));
  // a missing topic (404 "no topic …") is an answer, not a stop: a new note becomes a draft of a new topic
  vault.files.set("Diesel/proj/Topic/Brand-new.md", "# brand new\n"); await p.syncAll();
  check("V2-9 404 no topic: not a stop, the new note goes as a draft", drafts.has("Brand-new") && !p.isStopped("proj"));

  // ---- stops ----
  check("STOP-1 stopWhy: route gone, v1, 410, E_AUTH stop; no topic, E_PRIVATE, d1's text 404 don't",
    !!stopWhy({ status: 404, json: { error: { code: "E_NOT_FOUND", message: "no route GET /api/v2/x" } } })
    && !!stopWhy({ status: 404, json: { error: { code: "E_NOT_FOUND", message: "all routes are under /api/v2" } } })
    && !!stopWhy({ status: 410, json: null }) && !!stopWhy({ status: 401, json: { error: { code: "E_AUTH", message: "x" } } })
    && !stopWhy({ status: 404, json: { error: { code: "E_NOT_FOUND", message: "no topic 'X'" } } })
    && !stopWhy({ status: 401, json: { error: { code: "E_PRIVATE", message: "x" } } })
    && !stopWhy({ status: 404, get json() { throw new Error("not JSON"); } }) && !stopWhy({ status: 500, json: null }));

  // a d1 realm whose URL is a d2 host: no v1 call goes out
  const sentV1: string[] = []; const http0 = p.http.bind(p);
  (p as any).http = async (o: { url: string }) => { if (o.url.includes("/api/v1/")) sentV1.push(o.url); return http0(o as any); };
  p.data.settings.baseUrlOverrides = `proj = ${D2}\nmetals = https://metals.aiputty.com`; p.data.settings.user = "u"; p.data.settings.password = "pw";
  vault.files.set("Diesel/metals/Topic/M.md", "# m\n"); p.data.state["Diesel/metals/Topic/M.md"] = { wpath: "metals.Topic:M", ver: 1, hash: "x", at: 0 } as any;
  let at = notices.length; await p.syncAll();
  check("STOP-2 v1 never sent to a d2 host: metals stopped, one notice naming the fix", sentV1.length === 0 && p.isStopped("metals")
    && said(at, /stopped syncing metals: metals\.aiputty\.com is d2, which has no \/api\/v1: list metals under d2 projects/) === 1 && said(at, /also one of your d2 projects/) === 0, `${sentV1.join(" ")} | ${notices.slice(at).join(" | ")}`);
  at = notices.length; await quiet(3);
  check("STOP-3 the timer leaves a stopped realm alone, and says nothing more", sentV1.length === 0 && said(at, /metals/) === 0, notices.slice(at).join(" | "));
  vault.files.delete("Diesel/metals/Topic/M.md"); delete p.data.state["Diesel/metals/Topic/M.md"]; p.data.settings.baseUrlOverrides = `proj = ${D2}`;
  p.data.stopped = {}; (p as any).http = http0;

  // a route gone on d2: the realm stops, once
  mode = "routeGone"; calls.length = 0; at = notices.length; await quiet(1);
  check("STOP-4 404 no route: proj stops, one notice", p.isStopped("proj") && said(at, /stopped syncing proj: .*that route is gone/) === 1 && calls.length <= 2, `${calls.length} calls | ${notices.slice(at).join(" | ")}`);
  calls.length = 0; at = notices.length; await quiet(3, 600_000);
  check("STOP-5 no timer retry: 3 more quiet syncs call nothing, say nothing", calls.length === 0 && notices.length === at, `${calls.join(" ")} | ${notices.slice(at).join(" | ")}`);
  // a restart: the stop is kept in the plugin's data
  const q = new DieselSyncPlugin(app as any, {} as any); (q as any).stored = (p as any).stored; q.now = () => now; (q as any).autoUpload = async () => {};
  await q.onload(); calls.length = 0; await q.syncAll(true);
  check("STOP-6 after a restart the timer still leaves it alone", calls.length === 0 && q.isStopped("proj"), calls.join(" "));
  // a sync by hand calls it again (and, still gone, stops it again with one notice)
  calls.length = 0; at = notices.length; await p.syncAll();
  check("STOP-7 a sync by hand retries: called again, stopped again, said once", calls.length >= 1 && p.isStopped("proj") && said(at, /stopped syncing proj/) === 1, `${calls.length} | ${notices.slice(at).join(" | ")}`);
  // d2 is back, and the settings change: the timer calls it again
  mode = "ok"; p.data.settings.d2Projects = "proj = d2t_new"; calls.length = 0; await quiet(1);
  check("STOP-8 changed settings: the stop no longer holds, the timer calls it", calls.length > 0 && !p.isStopped("proj"));
  p.data.stopped = {};
  // 410 and E_AUTH stop too; E_AUTH names where to make a new token
  mode = "gone"; at = notices.length; await quiet(1);
  check("STOP-9 410: stopped", p.isStopped("proj") && said(at, /stopped syncing proj: .*HTTP 410/) === 1, notices.slice(at).join(" | "));
  p.data.stopped = {}; mode = "auth"; at = notices.length; await quiet(1);
  check("STOP-10 401 E_AUTH: stopped, the notice says where to make a new token", p.isStopped("proj")
    && said(at, new RegExp(`E_AUTH.*Make a new token at ${D2.replace(/[.]/g, "\\.")}/ai/tokens`)) === 1, notices.slice(at).join(" | "));
  calls.length = 0; await quiet(2);
  check("STOP-11 and the timer doesn't call it again", calls.length === 0);
  p.data.stopped = {}; mode = "private"; await quiet(1);
  check("STOP-12 401 E_PRIVATE (no login): not a stop (the daily login notice, as before)", !p.isStopped("proj"));
  mode = "ok"; await p.syncAll();

  // ---- 5xx backs off ----
  mode = "down"; calls.length = 0; await p.syncAll(true);   // n=1: 2 intervals (1 minute each, auto-sync off)
  check("BACKOFF-1 a 502: one call, then the realm is left for the rest of the sync", calls.length <= 2 && !p.isStopped("proj"), calls.join(" "));
  now += 60_000; calls.length = 0; await p.syncAll(true);
  const skipped = calls.length === 0;
  now += 60_000; calls.length = 0; await p.syncAll(true);   // 2 intervals on: tried again, still down: 4 intervals
  const retried = calls.length > 0;
  now += 3 * 60_000; calls.length = 0; await p.syncAll(true);
  check("BACKOFF-2 the timer backs off 2, then 4 intervals", skipped && retried && calls.length === 0, `skipped=${skipped} retried=${retried} then=${calls.length}`);
  mode = "ok"; calls.length = 0; await p.syncAll();
  now += 60_000; const c0 = calls.length; await p.syncAll(true);
  check("BACKOFF-3 back up (a sync by hand reached it): the backoff is over", c0 > 0 && calls.length > c0 && p.backoff.size === 0, `${c0} ${calls.length} ${p.backoff.size}`);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
