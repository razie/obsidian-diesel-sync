import {
  App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder,
  normalizePath, requestUrl,
} from "obsidian";
import { diff3Merge, diffComm } from "node-diff3";

// ---------- types ----------

interface Mapping {
  folder: string;    // vault folder, e.g. "RazInvest/Cards"
  realm: string;     // e.g. "metals"
  category: string;  // e.g. "CompanyCard"
  prefix: string;    // filename prefix, e.g. "Card-"
  tags: string[];    // tags added when creating a topic from this folder
}

interface Settings {
  user: string;
  password: string;
  baseUrlPattern: string;   // {realm} is replaced, e.g. https://{realm}.dieselapps.com
  baseUrlOverrides: string; // lines: realm = https://host
  rootFolder: string;       // generic layout: <root>/<realm>/<Category>/<name>.md
  defaultRealm: string;
  mappings: string;         // lines: folder | realm.Category | prefix | tag1,tag2
  visibility: string;       // for newly created topics
  wvis: string;
  autoSyncMinutes: number;  // 0 = off
  initialPullQuery: string; // tag query pulled into an empty <root>/<realm> folder, e.g. topic or topic/-hq
  inlineConflicts: boolean; // merge conflicts into the note with markers (else: conflict copy only)
  markerOpen: string;       // e.g. vvvvvvv
  markerClose: string;      // e.g. ^^^^^^^
}

interface SyncState {
  wpath: string;
  ver: number;   // remote version at last sync
  hash: string;  // content hash at last sync (both sides equal then)
  at: number;
  base?: boolean; // the last-synced text is stored in the base cache (for three-way merges)
}

interface PluginData {
  settings: Settings;
  state: Record<string, SyncState>; // key: vault path
}

interface Remote {
  realm: string; category: string; name: string;
  content: string; ver: number; tags: string[];
}

type Outcome = "in-sync" | "pushed" | "created" | "pulled" | "merged" | "conflict" | "unresolved" | "skipped" | "error";

const DEFAULTS: Settings = {
  user: "",
  password: "",
  baseUrlPattern: "https://{realm}.dieselapps.com",
  baseUrlOverrides: "",
  rootFolder: "Diesel",
  defaultRealm: "metals",
  mappings: "",
  visibility: "Member",
  wvis: "Member",
  autoSyncMinutes: 0,
  initialPullQuery: "topic",
  inlineConflicts: true,
  markerOpen: "vvvvvvv",
  markerClose: "^^^^^^^",
};

const CONFLICT_SUFFIX = ".diesel-conflict.md";

// ---------- helpers ----------

// cyrb53: small, fast, sync string hash (no Node crypto -> works on mobile)
function hash(s: string): string {
  const t = s.replace(/\s+$/, ""); // ignore trailing whitespace (server may trim EOL)
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < t.length; i++) {
    const ch = t.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

function parseWpath(wpath: string): { realm: string; category: string; name: string } | null {
  const m = wpath.trim().match(/^([^.:\s]+)\.([^.:\s]+):(.+)$/);
  return m ? { realm: m[1], category: m[2], name: m[3] } : null;
}

// split into lines, ignoring trailing newlines (the reactor may trim EOL)
function lines(s: string): string[] {
  const t = s.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  return t === "" ? [] : t.split("\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, "_");
}

// ---------- plugin ----------

export default class DieselSyncPlugin extends Plugin {
  data!: PluginData;
  statusEl!: HTMLElement;
  timer: number | null = null;
  busy = false;

  async onload() {
    const raw = (await this.loadData()) as Partial<PluginData> | null;
    this.data = {
      settings: Object.assign({}, DEFAULTS, raw?.settings ?? {}),
      state: raw?.state ?? {},
    };

    this.statusEl = this.addStatusBarItem();
    this.setStatus("idle");

    this.addRibbonIcon("refresh-cw", "Diesel: sync all", () => this.syncAll());

    this.addCommand({ id: "sync-all", name: "Sync all mapped notes", callback: () => this.syncAll() });
    this.addCommand({
      id: "sync-current", name: "Sync current note",
      checkCallback: (check) => this.withActive(check, (f) => this.syncOneReport(f)),
    });
    this.addCommand({
      id: "push-current", name: "Push current note (create or link to a topic)",
      checkCallback: (check) => this.withActive(check, (f) => this.pushCurrent(f)),
    });
    this.addCommand({ id: "pull-topic", name: "Pull topic by wpath…", callback: () => this.pullTopicPrompt() });
    this.addCommand({ id: "pull-tag", name: "Pull topics by tag…", callback: () => this.pullTagPrompt() });
    this.addCommand({
      id: "force-push", name: "Resolve conflict: keep local (force push)",
      checkCallback: (check) => this.withActive(check, (f) => this.forcePush(f)),
    });
    this.addCommand({
      id: "force-pull", name: "Resolve conflict: take reactor copy (force pull)",
      checkCallback: (check) => this.withActive(check, (f) => this.forcePull(f)),
    });
    this.addCommand({
      id: "open-on-reactor", name: "Open current note on the reactor",
      checkCallback: (check) => this.withActive(check, (f) => {
        const w = this.wpathFor(f);
        if (!w) { new Notice("Diesel: this note isn't linked to a topic"); return; }
        const p = parseWpath(w)!;
        window.open(`${this.baseUrl(p.realm)}/wiki/${w}`);
      }),
    });

    this.addSettingTab(new DieselSettingTab(this.app, this));

    // keep sync state attached to files when they move; forget it when they're deleted (no remote delete)
    this.registerEvent(this.app.vault.on("rename", async (f, oldPath) => {
      const st = this.data.state[oldPath];
      if (st) { delete this.data.state[oldPath]; this.data.state[f.path] = st; await this.save(); }
    }));
    this.registerEvent(this.app.vault.on("delete", async (f) => {
      if (this.data.state[f.path]) { delete this.data.state[f.path]; await this.save(); }
    }));

    this.resetTimer();
  }

  onunload() { if (this.timer) window.clearInterval(this.timer); }

  async save() { await this.saveData(this.data); }

  get s() { return this.data.settings; }

  resetTimer() {
    if (this.timer) { window.clearInterval(this.timer); this.timer = null; }
    const m = Number(this.s.autoSyncMinutes) || 0;
    if (m > 0) this.timer = this.registerInterval(window.setInterval(() => this.syncAll(true), m * 60_000));
  }

  setStatus(t: string) { this.statusEl.setText(`Diesel: ${t}`); }

  withActive(check: boolean, fn: (f: TFile) => void): boolean {
    const f = this.app.workspace.getActiveFile();
    if (!f || f.extension !== "md") return false;
    if (!check) fn(f);
    return true;
  }

  // ---------- config ----------

  baseUrl(realm: string): string {
    for (const line of this.s.baseUrlOverrides.split("\n")) {
      const m = line.match(/^\s*([^=\s]+)\s*=\s*(\S+)\s*$/);
      if (m && m[1] === realm) return m[2].replace(/\/+$/, "");
    }
    return this.s.baseUrlPattern.replace("{realm}", realm).replace(/\/+$/, "");
  }

  mappings(): Mapping[] {
    const out: Mapping[] = [];
    for (const line of this.s.mappings.split("\n")) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const [folder, rc, prefix = "", tags = ""] = line.split("|").map((x) => x.trim());
      const m = rc?.match(/^([^.\s]+)\.([^.\s]+)$/);
      if (!folder || !m) continue;
      out.push({
        folder: normalizePath(folder), realm: m[1], category: m[2], prefix,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      });
    }
    return out;
  }

  // file -> wpath (state first, then mappings, then generic root layout)
  wpathFor(f: TFile): string | null {
    const st = this.data.state[f.path];
    if (st) return st.wpath;
    if (f.name.endsWith(CONFLICT_SUFFIX)) return null;
    const dir = f.parent?.path ?? "";
    for (const m of this.mappings()) {
      if (dir === m.folder && f.basename.startsWith(m.prefix)) {
        return `${m.realm}.${m.category}:${f.basename.slice(m.prefix.length)}`;
      }
    }
    const root = normalizePath(this.s.rootFolder);
    const parts = f.path.split("/");
    const rootParts = root.split("/");
    if (parts.length === rootParts.length + 3 && parts.slice(0, rootParts.length).join("/") === root) {
      const [realm, category] = parts.slice(rootParts.length, rootParts.length + 2);
      return `${realm}.${category}:${f.basename}`;
    }
    return null;
  }

  // wpath -> vault path
  pathFor(wpath: string): string {
    for (const [path, st] of Object.entries(this.data.state)) if (st.wpath === wpath) return path;
    const p = parseWpath(wpath)!;
    for (const m of this.mappings()) {
      if (m.realm === p.realm && m.category === p.category) {
        return normalizePath(`${m.folder}/${m.prefix}${safeFileName(p.name)}.md`);
      }
    }
    return normalizePath(`${this.s.rootFolder}/${p.realm}/${p.category}/${safeFileName(p.name)}.md`);
  }

  tagsFor(wpath: string): string[] {
    const p = parseWpath(wpath)!;
    const m = this.mappings().find((x) => x.realm === p.realm && x.category === p.category);
    return m?.tags ?? [];
  }

  // ---------- HTTP ----------

  auth(): Record<string, string> {
    if (!this.s.user) throw new Error("set your reactor user + password in the plugin settings");
    return { Authorization: "Basic " + btoa(`${this.s.user}:${this.s.password}`) };
  }

  async getRemote(wpath: string): Promise<Remote | null> {
    const p = parseWpath(wpath)!;
    const r = await requestUrl({
      url: `${this.baseUrl(p.realm)}/api/v1/wiki/json/${wpath}`,
      headers: this.auth(), throw: false,
    });
    if (r.status === 404) return null;
    if (r.status !== 200) throw new Error(`read ${wpath}: HTTP ${r.status} (401 can also mean "no such topic")`);
    const d = r.json;
    // guard against realm fallback: the reactor may answer with an inherited topic from another realm
    if (d.realm !== p.realm || d.category !== p.category || d.name !== p.name) {
      throw new Error(`${wpath} resolved to ${d.realm}.${d.category}:${d.name} (realm fallback) — not syncing it`);
    }
    return { realm: d.realm, category: d.category, name: d.name, content: d.content ?? "", ver: Number(d.ver) || 0, tags: d.tags ?? [] };
  }

  async write(kind: "create" | "update", wpath: string, content: string): Promise<void> {
    const p = parseWpath(wpath)!;
    const we: Record<string, unknown> = { category: p.category, name: p.name, realm: p.realm, content };
    if (kind === "create") {
      Object.assign(we, {
        markup: "md", label: p.name, tags: this.tagsFor(wpath),
        props: { visibility: this.s.visibility, wvis: this.s.wvis },
      });
    }
    const r = await requestUrl({
      url: `${this.baseUrl(p.realm)}/api/v1/wiki/${kind}/${wpath}`,
      method: "POST",
      headers: this.auth(),
      contentType: "application/x-www-form-urlencoded",
      body: "we=" + encodeURIComponent(JSON.stringify(we)),
      throw: false,
    });
    if (r.status === 200) return;
    if (r.status === 404 && /no change/i.test(r.text)) return; // identical write = success
    throw new Error(`${kind} ${wpath}: HTTP ${r.status} ${r.text.slice(0, 160)}`);
  }

  // writes land in the reactor's caches asynchronously: poll until the version moves
  async confirm(wpath: string, prevVer: number, expectHash: string): Promise<Remote> {
    let last: Remote | null = null;
    for (let i = 0; i < 8; i++) {
      last = await this.getRemote(wpath);
      if (last && (last.ver !== prevVer || hash(last.content) === expectHash)) return last;
      await sleep(500 + i * 250);
    }
    if (last) return last;
    throw new Error(`${wpath}: write returned ok but the topic can't be read back`);
  }

  // ---------- vault ----------

  async ensureFolder(path: string) {
    const dir = path.split("/").slice(0, -1).join("/");
    if (!dir) return;
    let cur = "";
    for (const part of dir.split("/")) {
      cur = cur ? `${cur}/${part}` : part;
      const af = this.app.vault.getAbstractFileByPath(cur);
      if (!af) await this.app.vault.createFolder(cur);
      else if (!(af instanceof TFolder)) throw new Error(`${cur} exists and is not a folder`);
    }
  }

  async writeLocal(path: string, content: string): Promise<TFile> {
    const af = this.app.vault.getAbstractFileByPath(path);
    if (af instanceof TFile) { await this.app.vault.modify(af, content); return af; }
    await this.ensureFolder(path);
    return await this.app.vault.create(path, content);
  }

  async record(path: string, wpath: string, ver: number, content: string) {
    const h = hash(content);
    const prev = this.data.state[path];
    let base = !!(prev && prev.wpath === wpath && prev.hash === h && prev.base);
    if (!base) { try { await this.writeBase(wpath, content); base = true; } catch { base = false; } }
    this.data.state[path] = { wpath, ver, hash: h, at: Date.now(), base };
    await this.save();
  }

  // ---------- base cache: last-synced text per topic, for three-way merges ----------

  baseDir(): string { return normalizePath(`${this.manifest?.dir ?? ".obsidian/plugins/diesel-sync"}/base`); }
  basePath(wpath: string): string { return `${this.baseDir()}/${hash(wpath)}.md`; }

  async writeBase(wpath: string, content: string) {
    const a = this.app.vault.adapter;
    const dir = this.baseDir();
    if (!(await a.exists(dir))) await a.mkdir(dir);
    await a.write(this.basePath(wpath), content);
  }

  async readBase(wpath: string, expectHash: string): Promise<string | null> {
    try {
      const a = this.app.vault.adapter, p = this.basePath(wpath);
      if (!(await a.exists(p))) return null;
      const b = await a.read(p);
      return hash(b) === expectHash ? b : null; // stale base -> treat as missing
    } catch { return null; }
  }

  // ---------- merge ----------

  midMarker(ver: number) { return `${this.s.markerClose} vs ${this.s.markerOpen} diesel v${ver}`; }

  // 1-based line of the first leftover marker, or 0
  markerLine(text: string): number {
    const o = `${this.s.markerOpen} obsidian`, m = `${this.s.markerClose} vs ${this.s.markerOpen} diesel`, e = `${this.s.markerClose} end`;
    return lines(text).findIndex((l) => l.trimEnd() === o || l.startsWith(m) || l.trimEnd() === e) + 1;
  }

  hasMarkers(text: string): boolean { return this.markerLine(text) > 0; }

  unresolvedNotes: string[] = [];

  hunk(out: string[], a: string[], b: string[], ver: number) {
    out.push(`${this.s.markerOpen} obsidian`, ...a, this.midMarker(ver), ...b, `${this.s.markerClose} end`);
  }

  // three-way with the last-synced base: non-overlapping edits merge cleanly, overlaps get markers
  merge3(local: string, base: string, remote: string, ver: number): { text: string; conflicts: number } {
    const out: string[] = []; let conflicts = 0;
    for (const blk of diff3Merge(lines(local), lines(base), lines(remote), { excludeFalseConflicts: true })) {
      if (blk.ok) out.push(...blk.ok);
      else if (blk.conflict) { conflicts++; this.hunk(out, blk.conflict.a, blk.conflict.b, ver); }
    }
    return { text: out.join("\n") + "\n", conflicts };
  }

  // no base: every difference is a hunk (can't tell an add on one side from a delete on the other)
  merge2(local: string, remote: string, ver: number): { text: string; conflicts: number } {
    const out: string[] = []; let conflicts = 0;
    for (const blk of diffComm(lines(local), lines(remote))) {
      if (blk.common) out.push(...blk.common);
      else if (blk.buffer1.length || blk.buffer2.length) { conflicts++; this.hunk(out, blk.buffer1, blk.buffer2, ver); }
    }
    return { text: out.join("\n") + "\n", conflicts };
  }

  // ---------- sync core ----------

  async syncPair(path: string, wpath: string): Promise<Outcome> {
    const af = this.app.vault.getAbstractFileByPath(path);
    const file = af instanceof TFile ? af : null;
    const local = file ? await this.app.vault.read(file) : null;
    const remote = await this.getRemote(wpath);
    const st = this.data.state[path];

    if (local === null && remote === null) return "skipped";

    if (remote === null) {
      if (st) { new Notice(`Diesel: ${wpath} is gone from the reactor — local note kept, nothing deleted`); return "skipped"; }
      await this.write("create", wpath, local!);
      const r = await this.confirm(wpath, 0, hash(local!));
      await this.record(path, wpath, r.ver, local!);
      return "created";
    }

    if (local === null) {
      const f = await this.writeLocal(path, remote.content);
      await this.record(f.path, wpath, remote.ver, remote.content);
      return "pulled";
    }

    const lh = hash(local), rh = hash(remote.content);
    if (lh === rh) {
      await this.record(path, wpath, remote.ver, local);
      await this.dropConflictCopy(path);
      return "in-sync";
    }

    // a note still carrying conflict markers is never pushed
    if (this.hasMarkers(local)) {
      this.unresolvedNotes.push(`${path} (line ${this.markerLine(local)})`);
      return await this.unresolved(path, wpath, remote);
    }

    if (!st) return await this.conflict(path, wpath, local, remote, null);

    const localChanged = lh !== st.hash;
    const remoteChanged = remote.ver !== st.ver && rh !== st.hash;

    if (localChanged && !remoteChanged) {
      await this.write("update", wpath, local);
      const r = await this.confirm(wpath, remote.ver, lh);
      await this.record(path, wpath, r.ver, local);
      await this.dropConflictCopy(path);
      return "pushed";
    }
    if (remoteChanged && !localChanged) {
      await this.writeLocal(path, remote.content);
      await this.record(path, wpath, remote.ver, remote.content);
      return "pulled";
    }
    return await this.conflict(path, wpath, local, remote, st);
  }

  async conflict(path: string, wpath: string, local: string, remote: Remote, st: SyncState | null): Promise<Outcome> {
    const cpath = path.replace(/\.md$/, CONFLICT_SUFFIX);
    const cname = cpath.split("/").pop();

    if (!this.s.inlineConflicts) {
      await this.writeLocal(cpath, remote.content);
      new Notice(`Diesel: conflict on ${wpath} — reactor copy saved as ${cname}. ` +
        `Merge into your note, then run "keep local (force push)".`, 12000);
      return "conflict";
    }

    const base = st ? await this.readBase(wpath, st.hash) : null;
    const m = base !== null ? this.merge3(local, base, remote.content, remote.ver) : this.merge2(local, remote.content, remote.ver);

    if (m.conflicts === 0) {
      // clean three-way merge: both sides' edits combined
      await this.writeLocal(path, m.text);
      if (hash(m.text) === hash(remote.content)) {
        await this.record(path, wpath, remote.ver, remote.content);
        return "pulled";
      }
      await this.write("update", wpath, m.text);
      const r = await this.confirm(wpath, remote.ver, hash(m.text));
      await this.record(path, wpath, r.ver, m.text);
      await this.dropConflictCopy(path);
      return "merged";
    }

    // overlapping edits: markers in the note, reactor copy alongside. The reactor version becomes the
    // base, so once the markers are gone the next sync pushes the resolution (or re-merges if it moved).
    await this.writeLocal(cpath, remote.content);
    await this.writeLocal(path, m.text);
    await this.record(path, wpath, remote.ver, remote.content);
    new Notice(`Diesel: conflict on ${wpath} — ${m.conflicts} hunk(s) marked in the note` +
      (base === null ? " (no merge base: every difference is marked)" : "") +
      `; reactor copy saved as ${cname}. Resolve the ${this.s.markerOpen} … ${this.s.markerClose} blocks, then sync.`, 12000);
    return "conflict";
  }

  async unresolved(path: string, wpath: string, remote: Remote): Promise<Outcome> {
    const st = this.data.state[path];
    if (st && remote.ver !== st.ver && hash(remote.content) !== st.hash) {
      await this.writeLocal(path.replace(/\.md$/, CONFLICT_SUFFIX), remote.content);
      new Notice(`Diesel: ${wpath} changed again on the reactor (v${remote.ver}) while the note has unresolved ` +
        `conflict markers — conflict copy refreshed; resolve the markers, then sync to re-merge.`, 12000);
    }
    return "unresolved";
  }

  // ---------- commands ----------

  async run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    if (this.busy) { new Notice("Diesel: a sync is already running"); return; }
    this.busy = true; this.setStatus(label);
    try { return await fn(); }
    catch (e) { new Notice(`Diesel: ${(e as Error).message}`, 10000); this.setStatus("error"); }
    finally { this.busy = false; }
  }

  summarize(results: Record<string, number>, errors: string[]) {
    const parts = Object.entries(results).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`);
    const msg = parts.length ? parts.join(", ") : "nothing to sync";
    this.setStatus(`${msg} · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
    return msg + (errors.length ? `\n${errors.length} error(s):\n${errors.slice(0, 5).join("\n")}` : "");
  }

  async syncAll(quiet = false) {
    await this.run("syncing…", async () => {
      this.unresolvedNotes = [];
      const results: Record<string, number> = {};
      const errors: string[] = [];
      const initial: string[] = [];
      const done = new Set<string>();
      const q = this.s.initialPullQuery.split("/").map((x) => x.trim()).filter(Boolean);
      if (q.length) {
        for (const realm of this.emptyRealmFolders()) {
          try {
            const wpaths = await this.tagQuery(realm, q);
            initial.push(`${realm}: ${wpaths.length}`);
            this.setStatus(`initial pull ${realm} (${wpaths.length})…`);
            await this.syncList(wpaths, results, errors);
            wpaths.forEach((w) => done.add(w));
          } catch (e) { results.error = (results.error ?? 0) + 1; errors.push(`${realm}: ${(e as Error).message}`); }
        }
      }
      const pairs: [string, string][] = [];
      const seen = new Set<string>(done);
      for (const f of this.app.vault.getMarkdownFiles()) {
        const w = this.wpathFor(f);
        if (w && !seen.has(w)) { pairs.push([f.path, w]); seen.add(w); }
      }
      for (const [path, w] of pairs) {
        try { const o = await this.syncPair(path, w); results[o] = (results[o] ?? 0) + 1; }
        catch (e) { results.error = (results.error ?? 0) + 1; errors.push(`${w}: ${(e as Error).message}`); }
      }
      let msg = this.summarize(results, errors);
      if (initial.length) msg = `initial pull (${initial.join(", ")}) — ${msg}`;
      if (this.unresolvedNotes.length) msg += `\nleftover conflict markers in:\n${this.unresolvedNotes.slice(0, 5).join("\n")}`;
      if (!pairs.length && !initial.length && !done.size) {
        msg += `. Nothing is linked yet: create a realm folder like ${this.s.rootFolder}/metals and sync again ` +
          `(pulls "${this.s.initialPullQuery}"), use "Pull topics by tag…", or add a folder mapping.`;
      }
      if (!quiet || errors.length || results.conflict || results.unresolved) new Notice(`Diesel: ${msg}`, errors.length || !pairs.length ? 12000 : 5000);
    });
  }

  async syncOneReport(f: TFile) {
    await this.run("syncing…", async () => {
      const w = this.wpathFor(f);
      if (!w) { new Notice('Diesel: not linked to a topic — use "Push current note"'); this.setStatus("idle"); return; }
      this.unresolvedNotes = [];
      const o = await this.syncPair(f.path, w);
      new Notice(`Diesel: ${w} — ${o}` + (o === "unresolved" ? ` — leftover marker at line ${this.markerLine(await this.app.vault.read(f))}` : ""));
      this.setStatus(`${o} · ${w}`);
    });
  }

  async pushCurrent(f: TFile) {
    const guess = this.wpathFor(f) ?? `${this.s.defaultRealm}.Topic:${f.basename}`;
    new PromptModal(this.app, "Push to topic (realm.Category:name)", guess, async (w) => {
      if (!parseWpath(w)) { new Notice("Diesel: expected realm.Category:name"); return; }
      const cur = this.data.state[f.path];
      if (cur && cur.wpath !== w) delete this.data.state[f.path];
      await this.run("pushing…", async () => {
        const o = await this.syncPair(f.path, w);
        new Notice(`Diesel: ${w} — ${o}`);
        this.setStatus(`${o} · ${w}`);
      });
    }).open();
  }

  pullTopicPrompt() {
    new PromptModal(this.app, "Pull topic (realm.Category:name)", `${this.s.defaultRealm}.Topic:`, async (w) => {
      if (!parseWpath(w)) { new Notice("Diesel: expected realm.Category:name"); return; }
      await this.run("pulling…", async () => {
        const path = this.pathFor(w);
        const o = await this.syncPair(path, w);
        new Notice(`Diesel: ${w} — ${o}`);
        this.setStatus(`${o} · ${w}`);
        const af = this.app.vault.getAbstractFileByPath(path);
        if (af instanceof TFile) await this.app.workspace.getLeaf().openFile(af);
      });
    }).open();
  }

  pullTagPrompt() {
    new PromptModal(this.app, "Pull by tag: realm/tag1/tag2 (AND; -tag excludes)", `${this.s.defaultRealm}/`, async (q) => {
      const [realm, ...tags] = q.split("/").map((x) => x.trim()).filter(Boolean);
      if (!realm || !tags.length) { new Notice("Diesel: expected realm/tag"); return; }
      await this.run("pulling…", async () => {
        const wpaths = await this.tagQuery(realm, tags);
        if (!wpaths.length) { new Notice("Diesel: no topics match that tag query"); this.setStatus("idle"); return; }
        const results: Record<string, number> = {};
        const errors: string[] = [];
        await this.syncList(wpaths, results, errors);
        new Notice(`Diesel: ${wpaths.length} topic(s) — ${this.summarize(results, errors)}`, 8000);
      });
    }).open();
  }

  // tags AND together; a leading "-" excludes (e.g. ["topic", "-hq"]); a category name works as a tag
  async tagQuery(realm: string, tags: string[]): Promise<string[]> {
    const r = await requestUrl({
      url: `${this.baseUrl(realm)}/api/v1/wiki/tag/${tags.map(encodeURIComponent).join("/")}`,
      headers: this.auth(), throw: false,
    });
    if (r.status === 404) return [];
    if (r.status !== 200) throw new Error(`tag query ${realm}/${tags.join("/")}: HTTP ${r.status}`);
    return (r.json?.data ?? []).map((x: { wpath: string }) => x.wpath)
      .filter((w: string) => { const p = parseWpath(w); return p && p.realm === realm; });
  }

  async syncList(wpaths: string[], results: Record<string, number>, errors: string[]) {
    for (const w of wpaths) {
      try { const o = await this.syncPair(this.pathFor(w), w); results[o] = (results[o] ?? 0) + 1; }
      catch (e) { results.error = (results.error ?? 0) + 1; errors.push(`${w}: ${(e as Error).message}`); }
    }
  }

  // realm folders under the root that hold no notes yet -> candidates for the initial pull
  emptyRealmFolders(): string[] {
    const root = this.app.vault.getAbstractFileByPath(normalizePath(this.s.rootFolder));
    if (!(root instanceof TFolder)) return [];
    const hasNote = (f: TFolder): boolean =>
      f.children.some((c) => (c instanceof TFile && c.extension === "md") || (c instanceof TFolder && hasNote(c)));
    return root.children.filter((c): c is TFolder => c instanceof TFolder && !hasNote(c)).map((c) => c.name);
  }

  async forcePush(f: TFile) {
    await this.run("pushing…", async () => {
      const w = this.wpathFor(f);
      if (!w) throw new Error("not linked to a topic");
      const local = await this.app.vault.read(f);
      if (this.hasMarkers(local)) throw new Error("the note still has conflict markers — resolve them first (or force pull to discard local)");
      const remote = await this.getRemote(w);
      await this.write(remote ? "update" : "create", w, local);
      const r = await this.confirm(w, remote?.ver ?? 0, hash(local));
      await this.record(f.path, w, r.ver, local);
      await this.dropConflictCopy(f.path);
      new Notice(`Diesel: ${w} — local copy pushed`);
      this.setStatus(`pushed · ${w}`);
    });
  }

  async forcePull(f: TFile) {
    await this.run("pulling…", async () => {
      const w = this.wpathFor(f);
      if (!w) throw new Error("not linked to a topic");
      const remote = await this.getRemote(w);
      if (!remote) throw new Error(`${w} doesn't exist on the reactor`);
      await this.app.vault.modify(f, remote.content);
      await this.record(f.path, w, remote.ver, remote.content);
      await this.dropConflictCopy(f.path);
      new Notice(`Diesel: ${w} — reactor copy taken`);
      this.setStatus(`pulled · ${w}`);
    });
  }

  async dropConflictCopy(path: string) {
    const c = this.app.vault.getAbstractFileByPath(path.replace(/\.md$/, CONFLICT_SUFFIX));
    if (c instanceof TFile) await this.app.vault.trash(c, true);
  }
}

// ---------- UI ----------

class PromptModal extends Modal {
  constructor(app: App, private title: string, private initial: string, private onOk: (v: string) => void) { super(app); }
  onOpen() {
    this.titleEl.setText(this.title);
    let value = this.initial;
    const input = this.contentEl.createEl("input", { type: "text", value });
    input.style.width = "100%";
    input.addEventListener("input", () => (value = input.value));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { this.close(); this.onOk(value.trim()); } });
    new Setting(this.contentEl).addButton((b) => b.setButtonText("OK").setCta().onClick(() => { this.close(); this.onOk(value.trim()); }));
    window.setTimeout(() => { input.focus(); input.setSelectionRange(value.length, value.length); }, 50);
  }
  onClose() { this.contentEl.empty(); }
}

class DieselSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: DieselSyncPlugin) { super(app, plugin); }

  display() {
    const { containerEl } = this;
    const s = this.plugin.data.settings;
    const save = async () => { await this.plugin.save(); };
    containerEl.empty();

    containerEl.createEl("h3", { text: "Reactor account" });
    new Setting(containerEl).setName("User (email)")
      .addText((t) => t.setValue(s.user).onChange(async (v) => { s.user = v.trim(); await save(); }));
    new Setting(containerEl).setName("Password")
      .setDesc("Stored in this vault's plugin data (.obsidian/plugins/diesel-sync/data.json). A scoped account is safer than your main one.")
      .addText((t) => { t.inputEl.type = "password"; t.setValue(s.password).onChange(async (v) => { s.password = v; await save(); }); });

    containerEl.createEl("h3", { text: "Reactors" });
    new Setting(containerEl).setName("Base URL pattern").setDesc("{realm} is replaced by the topic's realm.")
      .addText((t) => t.setValue(s.baseUrlPattern).onChange(async (v) => { s.baseUrlPattern = v.trim(); await save(); }));
    new Setting(containerEl).setName("Base URL overrides").setDesc("One per line: realm = https://host")
      .addTextArea((t) => t.setValue(s.baseUrlOverrides).onChange(async (v) => { s.baseUrlOverrides = v; await save(); }));
    new Setting(containerEl).setName("Default realm")
      .addText((t) => t.setValue(s.defaultRealm).onChange(async (v) => { s.defaultRealm = v.trim(); await save(); }));

    containerEl.createEl("h3", { text: "Where notes live" });
    new Setting(containerEl).setName("Root folder").setDesc("Generic layout: <root>/<realm>/<Category>/<name>.md")
      .addText((t) => t.setValue(s.rootFolder).onChange(async (v) => { s.rootFolder = v.trim(); await save(); }));
    new Setting(containerEl).setName("Folder mappings")
      .setDesc("One per line: folder | realm.Category | filename prefix | tags for new topics. " +
        "Example: RazInvest/Cards | metals.CompanyCard | Card- | card")
      .addTextArea((t) => { t.inputEl.rows = 4; t.setValue(s.mappings).onChange(async (v) => { s.mappings = v; await save(); }); });

    new Setting(containerEl).setName("Initial pull query")
      .setDesc("When Sync all finds an empty realm folder under the root (e.g. Diesel/metals), it pulls this tag query. " +
        "Tags AND together, a leading - excludes, and a category name works as a tag: topic, topic/-hq, story. Empty = off.")
      .addText((t) => t.setValue(s.initialPullQuery).onChange(async (v) => { s.initialPullQuery = v.trim(); await save(); }));

    containerEl.createEl("h3", { text: "Conflicts" });
    new Setting(containerEl).setName("Merge conflicts into the note")
      .setDesc("On: edits on both sides are three-way merged; overlapping hunks are marked in the note and the reactor copy is saved as " +
        "<name>.diesel-conflict.md. A note with markers is never pushed. Off: conflict copy only.")
      .addToggle((t) => t.setValue(s.inlineConflicts).onChange(async (v) => { s.inlineConflicts = v; await save(); }));
    new Setting(containerEl).setName("Conflict markers").setDesc("Open / close markers (markdown-inert; avoid ===, >>> and ---).")
      .addText((t) => t.setPlaceholder("vvvvvvv").setValue(s.markerOpen).onChange(async (v) => { s.markerOpen = v.trim() || DEFAULTS.markerOpen; await save(); }))
      .addText((t) => t.setPlaceholder("^^^^^^^").setValue(s.markerClose).onChange(async (v) => { s.markerClose = v.trim() || DEFAULTS.markerClose; await save(); }));

    containerEl.createEl("h3", { text: "New topics and auto-sync" });
    new Setting(containerEl).setName("Visibility for new topics")
      .addText((t) => t.setValue(s.visibility).onChange(async (v) => { s.visibility = v.trim(); await save(); }));
    new Setting(containerEl).setName("Write visibility (wvis) for new topics")
      .addText((t) => t.setValue(s.wvis).onChange(async (v) => { s.wvis = v.trim(); await save(); }));
    new Setting(containerEl).setName("Auto-sync every N minutes").setDesc("0 = off")
      .addText((t) => t.setValue(String(s.autoSyncMinutes)).onChange(async (v) => {
        s.autoSyncMinutes = Math.max(0, Number(v) || 0); await save(); this.plugin.resetTimer();
      }));

    new Setting(containerEl).setName("Forget sync state")
      .setDesc("Unlinks every note from its topic (files and topics are untouched). The next sync re-pairs by content; any difference becomes a conflict.")
      .addButton((b) => b.setButtonText("Forget").setWarning().onClick(async () => {
        this.plugin.data.state = {}; await save(); new Notice("Diesel: sync state cleared");
      }));
  }
}
