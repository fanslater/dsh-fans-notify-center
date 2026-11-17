**English** | [简体中文](./README.md)

# fans notify center

> Author: **fanslater** · package `dsh-fans-notify-center` · current version **0.4.5**

Turns DSH session-state changes into **persistent notification cards in the
bottom-right corner of the screen**: whenever any session in any workspace
finishes, waits for an approval or waits for an answer, a card pops up on its
own. Cards never disappear by themselves — only `✕`, **Clear all**, or actually
opening that session removes them.

## Why not system notifications

Windows Toast (which `dsh-notify-me` uses) is owned by the system and has three
limits you cannot work around:

| What you want | What Toast actually does |
| --- | --- |
| Stay on screen until I handle it | collapses into the notification centre after a few seconds |
| One card per session, stacked vertically | only one Toast per app at a time, the rest queue up |
| Only close when I click ✕ | a click on empty space, a swipe, or a timeout dismisses it |

So this plugin does not call system notifications. It draws its own borderless,
topmost, focus-free window anchored to the bottom-right corner of the screen
that hosts the DSH window.

## Three guarantees

1. **It always fires** — the event source lives in the host process
   (`turn/end`, `approval/request`, `user-questions/request`), so it does not
   depend on a page being open, the window being minimised, or system
   notification permission being muted.
2. **Only you can dismiss it** — cards have no timers. The only removal paths
   are `✕`, clear-all, clicking a card to open the session, and opening that
   session inside DSH (the browser half reports "read").
3. **N cards coexist** — one card per notification, stacked bottom-up; beyond
   the limit the header shows "N older notifications". Dismissing one removes
   one, and the window hides itself when the last card goes away.

## How to use it

- **Entry point**: `插件 → 已安装 → fans通知弹窗中心`; the toggle on the right is
  the plugin's master switch.
- **Where the configuration lives**: open the plugin page — the form sits
  **below the summary and above the component list** (the `plugins.bundle.config`
  slot, keyed by package name). It is not in the Settings menu and not in the
  "included components" row.
- **Four buttons** (styled like the other fans plugin pages):
  - **Save configuration**: writes the form to
    `%USERPROFILE%\.dsh\profiles\<profile>\notify-center.config.json` and applies
    immediately (the popup process restarts once; visible cards survive). It is
    **greyed out when nothing changed** and turns into the blue primary button
    only when the form differs from the saved configuration.
  - **Restore defaults**: resets **the form only**, without writing anything;
    you still need **Save configuration** to apply it.
  - **Test popup**: immediately pushes three sample cards (approval / question /
    completed), rendered with the current position and opacity — no need to wait
    for a real notification to preview a change.
  - **Clear test cards**: removes only those `test-*` sample cards and never
    touches real notifications.
- **Configuration is only here**: the plugin registers no DSH settings page, so
  nothing appears in the Settings menu. The file lives at
  `%USERPROFILE%\.dsh\profiles\<profile>\notify-center.config.json`.
- **Settings** (13 in total):

  | Group | Setting | Default | Description |
  | --- | --- | --- | --- |
  | Master | Enable notification popups | On | When off, no new cards are produced and visible ones are cleared |
  | Scope | Also notify for subagent sessions | Off | A subagent is a step inside a main session; off by default to avoid noise |
  | Type | Turn completed | On | The agent finished its reply for this turn |
  | Type | Awaiting approval / plan review | On | A tool call needs your approval, or a plan needs confirming |
  | Type | Awaiting answer | On | `ask_user_question` is waiting for your choice |
  | Type | Error / interrupted | On | The turn failed, was blocked, or was interrupted |
  | Position | Bottom offset | 100 | Distance from the card's bottom edge to the DSH window bottom (0–400); keep it larger than the composer so the send button stays clear |
  | Position | Right offset | 8 | Distance from the card's right edge to the DSH window right edge (0–400); 0 means flush right |
  | Appearance | Card background opacity | 100% | 20%–100%; only the background colour is made translucent, text and borders stay sharp, and the background darkens on hover |
  | Appearance | Colour scheme | Follow system | `auto` follows the **DSH page theme** live (third-party themes included, judged by the page background brightness; falls back to the Windows theme when the page never reported); `light` / `dark` pin it |
  | Appearance | Which screen | Follow DSH window | `dsh` uses the screen hosting the window; `primary` pins the primary screen |
  | Appearance | Card width | 360 | 260–620 px |
  | Appearance | Maximum visible cards | 6 | 1–20; the overflow collapses into "N older notifications" |

- **Position and avoidance**: the popup is pinned to the **bottom-right corner
  of the DSH window** (not the screen; it follows the window's screen), offset
  from the window bottom by *bottom offset* and from the right edge by *right
  offset*, so it floats just above the composer. Stack height is protected by
  **dynamic collapsing**: the visible cards are squeezed into the space between
  the composer top and the title bar, and whatever does not fit collapses into
  "N older notifications" — no configuration can cover the composer buttons or
  the title bar. The legacy `anchor / topOffset / topShift` keys are deprecated;
  leftovers in the file are ignored.
- **Popup header**: top-left "N pending" in translucent bold; top-right
  **Clear all** as a primary-coloured text button (blue semi-bold, no border or
  fill, underline on hover, hit area about 60×24). The header itself has no
  background so it stays light.
- **Hidden switch**: the configuration file also has `test` (default `true`),
  which keeps the self-check-only `/test` route (inject sample cards into the
  window). It is not exposed in the form and normally does not need changing.

## Structure

```
dsh-fans-notify-center
├── lib/index.js        host half: event listeners + card state + routes + window spawn + config I/O
├── lib/client.js       browser half: click card → switch session, read receipts, plugin page form
├── win/NotifyCenter.cs topmost window (WPF, C# 5)
├── win/build.ps1       builds with the bundled csc, no SDK required
└── win/NotifyCenter.exe  build output
```

Data flow:

```
host events ──► card state ──GET /__dsh-notify-center/state──► NotifyCenter.exe (polls every 700ms)
                                                                │
  browser half ◄──GET /__dsh-notify-center/actions──── host ◄──POST /action {open|dismiss|clear}──┘
      └── uiWorkspace.openSession(sessionId)
```

The window process is spawned by the host and ends together with plugin
uninstall or host exit; if it dies unexpectedly, a watchdog (15s) relaunches it
whenever cards exist.

## Verification and troubleshooting

The listening port differs between DSH desktop launches; the examples below use
`11997`. Read the current value from `origin` in `/status`, or just use the port
in your address bar.

```powershell
# Host self-check: cards, window process, config, whether the browser half polls
Invoke-WebRequest http://127.0.0.1:11997/__dsh-notify-center/status -UseBasicParsing | Select-Object -Expand Content

# Read/write config (same API the plugin page form uses)
Invoke-WebRequest http://127.0.0.1:11997/__dsh-notify-center/config -UseBasicParsing

# Push 3 sample cards (style only, no real sessions)
Invoke-WebRequest http://127.0.0.1:11997/__dsh-notify-center/test -Method POST -Body '{"count":3}' -ContentType 'application/json'

# Window process log (rewritten on each launch, truncated beyond 512KB)
Get-Content "$env:TEMP\dsh-notify-center-window.log" -Tail 30
```

Useful `/status` fields: `window` (window process), `items` (current cards),
`queue` (open commands waiting for the page), `config`, `configFile`,
`stats.clientPolls` (whether the browser half is alive).

## Rebuilding the window

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File win\build.ps1
```

It uses `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe` (shipped with
.NET Framework 4.8), so the code must stay **C# 5**: no `$"..."`, `?.`, or
expression-bodied `=>` members.

## Changelog

| Version | Content |
| --- | --- |
| 0.1.0 | First usable version: host events create cards + dedicated topmost window + click a card to open the session |
| 0.2.0 | Installed as a tgz; added the plugin name "fans会话状态变更通知弹窗", author fanslater, icon and bilingual locale |
| 0.2.2 | Configuration moved from the "included components" row into the plugin detail page (`plugins.bundle.config`, keyed by package name) |
| 0.2.3 | The configuration page button became "Save configuration" and "Restore defaults" was added (form only, no write) |
| 0.2.4 | Completed the documentation: full settings table, save/restore semantics, the hidden `test` switch, changelog; the port note now follows the real DSH listener |
| 0.3.0 | Configurable anchor: switch between `bottom` (above the composer, keeps the send button clear) and `top` (below the title bar) with independent offsets; dynamic collapsing means no configuration can cover the composer or the title bar |
| 0.3.1 | Added "Test popup" and "Clear test cards": after changing anchor/offset, preview three sample cards instantly without waiting for real notifications; clearing removes only the samples |
| 0.3.2 | Fixed slow hot-reinstalls: the popup exits immediately when its token is rejected (403) by a new host generation; the host retries a fast-exiting window every 2.5s, cutting recovery from about a minute to seconds |
| 0.3.3 | Fixed "anchor does not switch after saving": the window polls a config fingerprint and exits itself on change, letting the host relaunch it with the new parameters (no unreliable kill race); `/config` partial patches now deep-merge instead of resetting sibling fields; the form status line has its own row |
| 0.3.4 | Fixed a host window-handle race: a late exit event from the old window no longer clears the new window handle, `/status` reports `window` accurately again and the watchdog stops relaunching needlessly |
| 0.3.5 | `top` anchor became "top of page, horizontally centred then shifted right" with a configurable horizontal offset (default 120) instead of hugging the right edge; default bottom offset 100 (the least-covering value measured); configuration buttons aligned with the other fans pages (outlined buttons + blue primary) |
| 0.4.0 | Converged to a fixed bottom-right anchor based on feedback: added "right offset" and "card opacity" (restored on hover), deprecated the top anchor and its keys; "N pending" is bolder and larger, "Clear all" became a real button with outline and hover feedback, "Save configuration" greys out when unchanged |
| 0.4.1 | Opacity moved to the right layer: only the card background gets alpha (text, borders and the colour bar stay opaque) so translucency is visible on light pages; removed the grey header band and made "Clear all" a fully rounded outlined pill that darkens on hover |
| 0.4.2 | "Clear all" switched to option 5, a primary-coloured text button: no border or fill, blue semi-bold, underline on hover, hit area ≥60×24; the five candidates were compared with offscreen rendering by the user |
| 0.4.3 | With "follow system", the colour scheme now follows the **DSH page theme** live instead of the OS (the browser half judges by page background brightness and reports it, so any third-party theme works); switching DSH to dark updates the popup within two seconds; falls back to the Windows theme until the page reports |
| 0.4.4 | Package renamed to `dsh-fans-notify-center`, client registration id and config page key follow it (host config file, routes, window mutex and log file keep their names, so existing settings and the running window are unaffected); installed from a packed tarball |
| 0.4.5 | Fixed the Win10 deployment loop: `NotifyCenter.exe.config` declared `supportedRuntime` for `.NET 4.8` only; it now declares a compatible chain (any 4.x → 4.7.2), so Win10 1803+ runs it with the built-in framework. The code was verified to use only APIs available since 4.6.2, so no .NET Framework installation is required on Win10 |

## Known limitations

- **Windows only**: the window is WPF.
- **.NET Framework requirement**: the target runtime is **4.7.2** (shipped with
  Win10 1803+ / Win11, zero install); 4.8 / 4.8.1 stay backward compatible. The
  code uses no API newer than 4.7.2, so no machine needs a manual .NET Framework
  install.
- **No notifications after DSH exits**: the event source lives in the host
  process; no process, no events.
- **Plugin reload / host restart clears the cards**: card state is in memory, so
  a waiting approval has to fire again to reappear (the approval itself is
  unaffected).
- **Clicking a card brings the DSH window to the foreground**: that is required
  by "click to open the session"; use `✕` if you do not want the focus stolen.
- **Relationship with `dsh-notify-me`**: this plugin replaces it and it is
  already uninstalled from the desktop profile; this plugin's events, window and
  configuration are fully self-contained and do not use any of its code.
