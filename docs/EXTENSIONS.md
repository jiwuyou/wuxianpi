# WuxianPi Extensions

## Pi extensions first

Pi extensions remain the primary way to add Agent tools, commands, Skills, and
lifecycle behavior. WuxianPi maps Pi's abstract UI requests to Web controls.
Serializable UI operations are supported; native terminal component factories
cannot be converted into browser DOM and receive an explicit unsupported result.

## Optional HTML WebUI

An extension may add rich visual contributions using static HTML, JavaScript,
and CSS.

```text
extension-id/
├── wuxianpi-extension.json
└── ui/
    ├── index.html
    ├── app.js
    └── style.css
```

The manifest must be named `wuxianpi-extension.json` and live at the extension
root. Installation rejects archives that use another manifest filename.

Supported contribution types include full pages, settings panels, assistant
editor tabs, chat actions, and tool-result renderers.

## Isolation

Rich UI runs in an iframe with `sandbox="allow-scripts"` and without
`allow-same-origin`. Assets are served only from the installed extension root
with a restrictive content security policy.

The bridge validates the iframe source window, extension ID, random nonce, and
request ID. Extensions never receive Pi session objects, cookies, filesystem
paths, or secret values.

Available bridge permissions are deliberately granular:

- `assistant.read`
- `storage.read`
- `storage.write`
- `tts.speak`
- `tools.call`
- `ui.notify`
- `ui.resize`
- `ui.close`

Tool calls still pass through the normal capability and permission broker.

## Failure behavior

An invalid manifest, missing asset, denied permission, crashed iframe, or failed
renderer must not break chat. WuxianPi falls back to its generic text/JSON tool
result renderer and reports a capability diagnostic.
