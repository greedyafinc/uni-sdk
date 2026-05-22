# demo-app

Bare-bones harness for exercising `@unifiedai/sdk` during development.
Not published. Not a reference app — extend freely while iterating on the SDK.

## Run

```sh
bun install
bun run --cwd examples/demo-app start
```

## Layout

```
run-app.ts        # launcher: sets API/web URL env then imports app
app.ts            # bootstrap SDK, start Bun.serve, open browser
sdk.ts            # SDK singleton + intercepting fetch for the refresh test
routes.ts         # JSON handlers: /me, /list-models, /test-refresh, /signout
public/
  index.html      # UI shell
  styles.css      # styling
  app.js          # frontend — fetches /me, wires buttons to JSON routes
constants.ts      # APP_ID
```

Add a new SDK method to the UI by:

1. Adding a handler to `routes.ts` and wiring it in `app.ts`.
2. Adding a `<button data-action="...">` to `public/index.html` and a matching entry in the `handlers` map in `public/app.js`.
