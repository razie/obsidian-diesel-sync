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
- Nothing is ever deleted on the reactor. Deleting a note only unlinks it.
- **Delete notes whose topic was deleted** (setting, on by default, 0.5.0): when a synced topic is deleted on d1 or d2, its note goes to the vault's trash (`.trash`, recoverable). A note edited since the last sync is kept and listed instead; delete it yourself, or **Force push** to recreate the topic. Sync all won't delete more than 3 notes of one realm at once when they're also over a quarter of its linked notes (a wrong URL or login answers "not found" for everything): it reports them instead.
- If the reactor answers a read with a topic from a different realm (realm-inheritance fallback), the plugin refuses to write it.

## Where notes live

- Generic layout: `<root>/<realm>/<Category>/<name>.md`, e.g. `Diesel/metals/Topic/Diesel2.md` ↔ `metals.Topic:Diesel2`.
- Folder mappings for existing folders, one per line: `folder | realm.Category | filename prefix | tags for new topics`, e.g.
  `RazInvest/Cards | metals.CompanyCard | Card- | card`
- Base URL pattern `https://{realm}.dieselapps.com`, with per-realm overrides.

## d2 projects (ai-putty.com)

Since 0.4.0 the plugin also syncs d2 projects, which have their own API. List them under **d2 projects**, one per line; `d2spec` is there by default:

    d2spec
    myproject = d2t_…     # optional: an AI token made on that project's Tokens page

- Without a token, your **User** and **Password** are used (d2 accepts them like a log-in). A token is safer: it's limited to one project and a level, and you can revoke it without changing your password.
- Their notes live under the root like realms, `Diesel/d2spec/Topic/Diesel2.md`. Sync all makes the folder and pulls the project's Topics the first time (the **Initial pull query**, `topic` by default).
- d2's shared topics (Help and the AI skill, which every project shows from the base) aren't synced into a project.
- The **Base URL pattern** is for d1 reactors only; d2 projects use the **d2 URL pattern** (`https://{realm}.ai-putty.com`). A d1 pattern pointed at a d2 domain is put back to dieselapps.com on load.
- d2 moved to ai-putty.com (0.8.0): on load, a d2 URL pattern, overrides and synced-note hosts still on aiheroapps.com, aiputty.com or aidieselapps.com are moved to ai-putty.com (the old domains only redirect).

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

## Log (0.6.0)

The plugin keeps its own rolling log (the last 800 lines, in its folder as `log.json`): every notice, every reactor call with its status and time (and, on d2, the request id that ties it to the server's own log), sync outcomes and errors. Passwords and tokens never go in it.

- **Upload log to d2** (command) sends it to the **Log project** (setting, `d2spec` by default) — into d2's detailed log, `kind=client`, tagged with the plugin version and the device.
- **Upload the log when a sync has errors** (setting, on): at most every 10 minutes, only the lines not sent yet.
- **Device name** (setting): how this device shows up; blank means iPad, phone or desktop.

## d1 sync off (0.7.0)

**Sync d1 reactors (dieselapps.com)** (setting, on): turn it off to sync only the **d2 projects**. Nothing of a d1 realm is read, written, queried or deleted — its notes just stay. A folder that moved from d1 to d2 (e.g. `metals`) keeps its old d1 notes safe: a note records the reactor it was last synced with; a link older than 0.7.0 is adopted if d2 has the topic and otherwise left alone (a d1 category d2 doesn't have, or a topic d2 doesn't have, is never deleted or recreated). The sync notice counts them as "d1 (left alone)". Test: `npm run test:d1off` (offline).

The base project `d2` lives on the bare domain: its URL is `https://ai-putty.com`, not `d2.ai-putty.com` (0.7.1), so its links open where you're logged in.

## Skipped, not errors (0.8.1)

What a sync leaves out on purpose is counted as **skipped** and said once in the log (a warning), never as an error, so it no longer uploads the log after every sync: notes in a d1-only category inside a d2 project (`CompanyCard`, `Reactor`…: d2 answers *unknown topic category*), a d2 project's view of another project's shared topic, and a `d2` folder while `d2` isn't listed under **d2 projects** — base d2 is never a d1 reactor, so `d2.dieselapps.com` is no longer asked for every note in it. A realm answering 5xx (down, or a deploy) is left alone for the rest of that sync with one error line, like a refused login. Test: `npm run test:skips` (offline).

## Pop-ups only for what's new (0.8.2)

An auto-sync no longer pops the same notice every interval. It notices only what the previous sync didn't have: a new error, conflict or leftover-marker note (keyed by note and status), a new pull, a delete or a kept note. A failure that repeats unchanged is shown once, then counted in the status bar (`… · 1 error (repeating)`) and logged as before; it notices again once that note has synced clean and the failure comes back, or once a day while it lasts. The repeats are kept in the plugin's data, so a restart doesn't re-notify. A realm that refuses the login gets one notice a day naming the fix (*make a new token at https://<realm>.ai-putty.com/ai/tokens*). A d1 realm that d2 also has as a project (d2's health names it) gets one notice a day saying to add it to **d2 projects**: nothing is moved, since the two copies may differ. A manual **Sync all** always shows its summary. `npm test` runs the offline tests (merge, deletes, d1off, skips).
