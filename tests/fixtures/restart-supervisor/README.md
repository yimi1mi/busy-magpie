# Restart supervisor fixtures

`app.cjs`, `worker.cjs`, and `store.cjs` support the automated Node integration
tests in `tests/restart-supervisor.test.cjs`. They run in isolated temporary
profiles. Their simulated quiescent process deliberately remains alive so the
tests distinguish stopping business activity from physical process exit.

The `electron-exit-*.cjs` files are manual diagnostic probes for Electron's
native exit tail. They are not part of the normal test suite and never use an
installed Busy Magpie profile. Each run writes lifecycle events under
`artifacts/restart-exit-probe/<timestamp>-<pid>`.

Run from the repository root:

```powershell
node tests/fixtures/restart-supervisor/electron-exit-probe.cjs handle
node tests/fixtures/restart-supervisor/electron-exit-probe.cjs none
node tests/fixtures/restart-supervisor/electron-exit-probe.cjs handle --node-worker
node tests/fixtures/restart-supervisor/electron-exit-probe.cjs none --no-worker --no-window --hardware
```

The last command is the control: no supervisor process, no window, default
hardware acceleration. A nonzero result means physical exit took more than
three seconds after `app.quit()`. This is a diagnostic threshold, not the
production update timeout. The harness requests cleanup after forty seconds;
such a run must not be described as an unassisted natural exit.

`--in-process-gpu` and `--disable-gpu` are diagnostic-only variations. They must
not be copied into product launch options without separate evidence. Local
controls reproduced a delayed native exit without a worker; they did not
identify a specific GPU, network, driver, or Electron subsystem as the cause.

Production updates rely on the stable shell's terminal quiescence handshake
or an actual process exit. Tests keep those observations distinct. A token,
PID, phase, or timestamp mismatch cannot authorize recovery or a new launch.
