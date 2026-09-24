(globalThis as any).window = globalThis;
export const log: string[] = [];
export class Notice { constructor(m: string) { log.push(m); console.log("  [notice]", m.replace(/\n/g," | ")); } }
export function normalizePath(p: string) { return p.replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/"); }
export async function requestUrl(o: any) {
  const headers: any = { ...(o.headers || {}) }; if (o.contentType) headers["Content-Type"] = o.contentType;
  const r = await fetch(o.url, { method: o.method || "GET", headers, body: o.body });
  const text = await r.text();
  return { status: r.status, text, get json() { return JSON.parse(text); } };
}
export class TAbstractFile { constructor(public path: string) {} get name() { return this.path.split("/").pop()!; } parent: any = null; }
export class TFolder extends TAbstractFile { children: TAbstractFile[] = []; }
export class TFile extends TAbstractFile {
  get extension() { return this.name.split(".").pop()!; }
  get basename() { return this.name.replace(/\.[^.]+$/, ""); }
}
export class Vault {
  files = new Map<string, string>(); folders = new Set<string>(); handlers: any = {};
  hidden = new Map<string, string>(); // adapter-only files (plugin dir)
  adapter = {
    exists: async (p: string) => this.hidden.has(p) || [...this.hidden.keys()].some((k) => k.startsWith(p + "/")) || p.endsWith("/base"),
    mkdir: async (_: string) => {},
    read: async (p: string) => { if (!this.hidden.has(p)) throw new Error("ENOENT " + p); return this.hidden.get(p)!; },
    write: async (p: string, c: string) => { this.hidden.set(p, c); },
    remove: async (p: string) => { this.hidden.delete(p); },
  };
  getAbstractFileByPath(p: string) {
    if (this.files.has(p)) { const f = new TFile(p); const d = p.split("/").slice(0,-1).join("/"); f.parent = d ? new TFolder(d) : new TFolder(""); return f; }
    if (this.folders.has(p)) {
      const d = new TFolder(p); const pre = p ? p + "/" : "";
      const kids = new Set<string>();
      for (const x of [...this.files.keys(), ...this.folders]) if (x.startsWith(pre) && x !== p) kids.add(pre + x.slice(pre.length).split("/")[0]);
      d.children = [...kids].map(k => this.getAbstractFileByPath(k)!).filter(Boolean);
      return d;
    }
    return null;
  }
  async read(f: TFile) { return this.files.get(f.path)!; }
  async modify(f: TFile, c: string) { this.files.set(f.path, c); }
  async create(p: string, c: string) { this.files.set(p, c); const parts = p.split("/"); for (let i = 1; i < parts.length; i++) this.folders.add(parts.slice(0, i).join("/")); return this.getAbstractFileByPath(p) as TFile; }
  async createFolder(p: string) { this.folders.add(p); }
  async trash(f: TFile) { this.files.delete(f.path); }
  async delete(f: TFile) { this.files.delete(f.path); await this.handlers.delete?.(f); }
  getMarkdownFiles() { return [...this.files.keys()].filter(p => p.endsWith(".md")).map(p => this.getAbstractFileByPath(p) as TFile); }
  on(ev: string, fn: any) { this.handlers[ev] = fn; return {}; }
}
export class Plugin {
  stored: any = null;
  constructor(public app: any, public manifest: any = {}) {}
  async loadData() { return this.stored; } async saveData(d: any) { this.stored = JSON.parse(JSON.stringify(d)); }
  addStatusBarItem() { return { setText: (_: string) => {} }; }
  addRibbonIcon() {} addCommand() {} addSettingTab() {} registerEvent() {}
  registerInterval(id: any) { return id; }
}
export class Modal { constructor(public app: any) {} }
export class PluginSettingTab { constructor(public app: any, public plugin: any) {} }
export class Setting {}
export type App = any;
