# Changelog

## [0.4.5] — 2026-11-16

- Fixed the Win10 deployment loop: `NotifyCenter.exe.config` declared
  `supportedRuntime` for `.NET 4.8` only, so the launcher demanded a framework
  version the plugin never actually needed. It now declares a compatible chain
  (any 4.x → 4.7.2), which Win10 1803+ ships natively.
- The code was verified to use only APIs available since 4.6.2, so no .NET
  Framework installation is required on Win10; 4.8 / 4.8.1 stay backward
  compatible.

## [0.4.4] — 2026-11-10

- Renamed the package to `dsh-fans-notify-center`; the client bundle
  registration id and the config-page key follow the new name. The host config
  file `notify-center.config.json`, the `/__dsh-notify-center` routes, the
  window mutex and the log file keep their original names, so existing
  settings and the running notification window are unaffected.
- Installed from a packed tarball (`file:`) instead of a link to the source
  directory.

Earlier releases are summarized in the version table at the end of
[README.md](./README.md).
