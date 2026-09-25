# Diesel Sync

Obsidian plugin for two-way sync between notes and topics on [DieselApps](https://www.dieselapps.com) reactors (e.g. `metals.dieselapps.com`). Works on desktop and mobile.

## How it works

- A note's body is the topic's content, byte for byte. The plugin adds no frontmatter; the note-to-topic link, last-synced version and content hash live in the plugin's data file.
- On sync, each side is compared against the last sync: a local-only change is pushed, a remote-only change is pulled.
- **Pull new topics** (setting, on by default): every Sync all re-runs the pull query for each realm folder and pulls matching topics that aren't in the vault yet, i.e. ones created on the reactor after the initial pull. A synced note you delete locally goes on an ignore list so it isn't pulled straight back (the topic on the reactor is never deleted); **Pull topics by tag…** fetches it again and takes it off the list.
- **Sync only local edits** (setting, off by default): avoid multi-obsidian sync issues. With Obsidian Sync on several devices, each running Diesel Sync, only notes typed in on *this* device are pushed or merged; a change that arrived from another device is left to that device (reported as "elsewhere"). Remote-only changes still pull everywhere. Edits made outside Obsidian (other editors, scripts) don't count as typed — use **Push current note** for those.
- A change on both sides is three-way merged against the last-synced text (kept in `.obsidian/plugins/diesel-sync/base/`). Non-overlapping edits merge cleanly and the result is pushed. Overlapping hunks are marked in the note, and the reactor copy is saved next to it as `<name>.diesel-conflict.md`:

  ```
  vvvvvvv obsidian
  your lines
  ^^^^^^^ vs vvvvvvv diesel v14
  reactor lines
  ^^^^^^^ end
  ```

  The markers are markdown-inert (git's `=======` / `>>>>>>>` would render as a heading and a blockquote) and configurable. A note that still has markers is never pushed; once you've edited them out, the next sync pushes the resolution, or re-merges if the topic moved again meanwhile. Without a base (e.g. a note first paired with an existing, different topic) every difference is marked. **Keep local (force push)** and **Take reactor copy (force pull)** still work as escape hatches; force push refuses while markers remain. Turn inline merging off in settings to get the old conflict-copy-only behaviour.
- Nothing is ever deleted on either side. Deleting a note only unlinks it.
- If the reactor answers a read with a topic from a different realm (realm-inheritance fallback), the plugin refuses to write it.

## Where notes live

- Generic layout: `<root>/<realm>/<Category>/<name>.md`, e.g. `Diesel/metals/Topic/Diesel2.md` ↔ `metals.Topic:Diesel2`.
- Folder mappings for existing folders, one per line: `folder | realm.Category | filename prefix | tags for new topics`, e.g.
  `RazInvest/Cards | metals.CompanyCard | Card- | card`
- Base URL pattern `https://{realm}.dieselapps.com`, with per-realm overrides.

## d2 projects (aiheroapps.com)

Since 0.4.0 the plugin also syncs d2 projects, which have their own API. List them under **d2 projects**, one per line; `d2spec` is there by default:

    d2spec
    myproject = d2t_…     # optional: an AI token made on that project's Tokens page

- Without a token, your **User** and **Password** are used (d2 accepts them like a log-in). A token is safer: it's limited to one project and a level, and you can revoke it without changing your password.
- Their notes live under the root like realms, `Diesel/d2spec/Topic/Diesel2.md`. Sync all makes the folder and pulls the project's Topics the first time (the **Initial pull query**, `topic` by default).
- d2's shared topics (Help and the AI skill, which every project shows from the base) aren't synced into a project.
- The **Base URL pattern** is for d1 reactors only; d2 projects use the **d2 URL pattern** (`https://{realm}.aiheroapps.com`). A d1 pattern pointed at aiheroapps.com is put back to dieselapps.com on load.

## Commands

Sync all (also on the ribbon), sync current note, push current note (create or link to a wpath), pull topic by wpath, pull by tag (`realm/tag1/tag2`), open current note on the reactor, and the two conflict resolvers. Optional auto-sync every N minutes.

## Install

- **BRAT (desktop and iPad):** install the BRAT community plugin, then *Add beta plugin* with this repo's URL. BRAT pulls `main.js` + `manifest.json` from the latest GitHub release.
- **Manual:** download `main.js` and `manifest.json` from the latest release into `<vault>/.obsidian/plugins/diesel-sync/`, then enable it under Community plugins.

Then set the reactor user and password in the plugin settings. They're stored in the vault's plugin data file (`.obsidian/plugins/diesel-sync/data.json`), so use a scoped reactor account.

## Development

```
npm install
npm run dev       # watch build to main.js
npm run build     # typecheck + production build
npm run test:merge  # offline merge unit tests
DIESEL_AUTH=<base64 user:pass> npm run test:live   # end-to-end against metals, scratch topics tagged claude,test, cleaned up after
```

d2: `D2_TOKEN=<token> npm run test:d2` runs the live checks against a d2 project (default the `d2pro` demo, which resets on every d2 deploy; `D2_PROJECT=` for another).


## Release

```
npm version patch   # bumps package.json, manifest.json, versions.json
git push && git push --tags
```

The tag triggers `.github/workflows/release.yml`, which builds and attaches `main.js` + `manifest.json` to a GitHub release.
