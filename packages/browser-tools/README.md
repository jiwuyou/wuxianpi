# WuxianPi Browser Tools

This optional Package contributes a Pi extension with two tools:

- `browser_operation`: invokes transport-neutral Browser Host methods.
- `app_action`: invokes `app.invoke` for an app action in the active or selected tab.

Installing the Package does not enable either tool globally. Bind the
`io.wuxianpi.browser-tools/extension.browser-tools` contribution to an
assistant that should control the shared browser.

The extension calls:

```text
POST /api/web/v1/browser/invoke
```

The Runtime origin defaults to `http://127.0.0.1:20765`. Override it with
`WUXIANPI_BROWSER_RUNTIME_URL` or `WUXIANPI_RUNTIME_URL` when the Runtime uses a
different endpoint.
