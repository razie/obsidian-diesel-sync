# Diesel Sync

Obsidian plugin for two-way sync between notes and topics on [DieselApps](https://www.dieselapps.com) reactors (e.g. `metals.dieselapps.com`). Works on desktop and mobile.

## How it works

- A note's body is the topic's content, byte for byte. The plugin adds no frontmatter; the note-to-topic link, last-synced version and content hash live in the plugin's data file.
- On sync, each side is compared against the last sync: a local-only change is pushed, a remote-only change is pulled, and a change on both sides saves the reactor copy next to the note as `<name>.diesel-conflict.md`. Resolve with **Keep local (force push)** or **Take reactor copy (force pull)**.
- Nothing is ever deleted on either side. Deleting a note only unlinks it.
- If the reactor answers a read with a topic from a different realm (realm-inheritance fallback), the plugin refuses to write it.

## Where notes live

- Generic layout: `<root>/<realm>/<Category>/<name>.md`, e.g. `Diesel/metals/Topic/Diesel2.md` ↔ `metals.Topic:Diesel2`.
- Folder mappings for existing folders, one per line: `folder | realm.Category | filename prefix | tags for new topics`, e.g.
  `RazInvest/Cards | metals.CompanyCard | Card- | card`
- Base URL pattern `https://{realm}.dieselapps.com`, with per-realm overrides.

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
DIESEL_AUTH=<base64 user:pass> npm run test:live   # end-to-end against metals, scratch topics tagged claude,test, cleaned up after
```

## Release

```
npm version patch   # bumps package.json, manifest.json, versions.json
git push && git push --tags
```

The tag triggers `.github/workflows/release.yml`, which builds and attaches `main.js` + `manifest.json` to a GitHub release.
