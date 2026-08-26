# Windows SealSeek Adapter

Read this reference completely whenever tbcli is being installed, diagnosed, or
updated inside Windows SealSeek. This adapter changes only command discovery and
launching; after the environment check succeeds, return to the main `tbcli`
Skill flow.

## Contract

- Discover SealSeek's managed Node runtime from
  `%USERPROFILE%\.sealseek\binaries\runtime-info.json`; never hard-code a user
  name, Node version, installation directory, or npm global directory.
- Do not require a separately installed Node.js, a manually edited system PATH,
  or a relaxed PowerShell ExecutionPolicy.
- In PowerShell, prefer `tbcli.cmd` and `npm.cmd` over same-named `.ps1` shims.
- `tbcli setup sealseek` owns only `tools.exec.pathPrepend` in
  `%USERPROFILE%\.sealseek\sealseek.json`. It preserves unrelated settings and
  creates a timestamped backup before a change.
- Database configuration and pgpass files live outside npm and Skill directories
  and must survive setup and updates.

## Clean bootstrap when `tbcli` is not found

Have SealSeek run this PowerShell block. It resolves every path from SealSeek's
own runtime metadata and then hands control to the installed CLI:

```powershell
$runtimePath = Join-Path $env:USERPROFILE '.sealseek\binaries\runtime-info.json'
$runtime = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
$node = $runtime.node.executablePath
$npmCli = Join-Path $runtime.node.installPath 'node_modules\npm\bin\npm-cli.js'
$globalDir = $runtime.node.npmGlobalDir
& $node $npmCli install --global --prefix $globalDir '@petercjl/tbcli@latest'
if ($LASTEXITCODE -ne 0) { throw 'tbcli npm install failed' }
$entry = Join-Path $globalDir 'node_modules\@petercjl\tbcli\scripts\tbcli.mjs'
& $node $entry setup sealseek --json
if ($LASTEXITCODE -ne 0) { throw 'tbcli SealSeek setup failed' }
```

Require a successful JSON result with `ok: true`, a nonempty `cli.version`, and
`skill.current: true`. If `restartRequired` is true, tell the user to completely
exit and restart SealSeek. Do not keep probing the pre-restart process.

## Verification after restart

Run:

```powershell
tbcli.cmd --version
tbcli.cmd doctor --agent sealseek --json
tbcli.cmd skill status --agent sealseek
```

Require doctor `ok: true`, `checks.pathConfigured: true`,
`checks.canonicalPackage: true`, `checks.canonicalCmd: true`, and
`checks.powershellShimDisabled: true`; require Skill state `current`. If the
doctor reports a repairable environment mismatch, run
`tbcli.cmd doctor --agent sealseek --fix --json`, restart SealSeek when requested,
then repeat verification.

## Updates

When the user explicitly authorizes an update, run:

```powershell
tbcli.cmd update --agent sealseek --json
```

The updater installs into the canonical npm global directory from runtime-info,
launches the newly installed canonical entry directly, refreshes the managed
Skill, repairs the SealSeek execution path, and verifies the actual new version.
If `restartRequired` is true, restart SealSeek before business work. Never split
routine updating into unrelated npm, PATH, Skill, and PowerShell-policy edits.

## Failure terminals

- Missing or malformed runtime-info: ask the user to start SealSeek once, then
  retry. Do not guess a Node path.
- Unmanaged/foreign Skill directory: stop at the protection error and ask an
  administrator to inspect it. Do not overwrite it.
- Invalid `sealseek.json`: preserve it and stop. Do not replace the whole file.
- npm or canonical-entry verification failure: return the exact failing stage;
  do not claim installation success merely because npm printed success.
