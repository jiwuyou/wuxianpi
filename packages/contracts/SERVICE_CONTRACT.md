# Service Contract

WuxianPi runs as the stable service-manager service `pi-agent`.

## Fixed service behavior

- Platform: Termux on Android ARM64.
- Provider: `termux-process`.
- Entry command: `wuxianpi-node-start`.
- Working directory: `$HOME/workspace`.
- Listen address: `127.0.0.1:8765`.
- Restart policy: `always`.
- Health check: `GET http://127.0.0.1:8765/health` every 15 seconds with a
  3-second timeout.
- Service spec:
  `$HOME/.config/openhouseai/service-manager/services.d/pi-agent.json`.

The package also installs `wuxianpi` and `wuxianpi-node`. service-manager owns
process lifecycle; Android should not launch the Node entry file directly.

## Data behavior

Installation and update scripts must create, but never replace or delete:

```text
$HOME/.pi/agent
$HOME/.pi/agent/sessions
$HOME/workspace
```

The packaging skeleton installs product files below
`$HOME/.local/share/wuxianpi`. This location is intentionally not a Host
contract and can change inside a future WuxianPi release without an APK update.

