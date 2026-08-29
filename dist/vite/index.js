// src/vite/index.ts
var HOST_API_SPECIFIER = "@unified/host-api";
var HOST_API_EXTERNAL = "/host-api.js";
function unifiedApp(opts) {
  const devHostApi = opts.devHostApi ?? "@unifiedai/sdk/app/dev-host-api";
  return {
    name: "unified-app",
    config(_config, { command }) {
      if (command === "build") {
        return {
          build: {
            rollupOptions: {
              external: [HOST_API_SPECIFIER],
              output: {
                paths: { [HOST_API_SPECIFIER]: HOST_API_EXTERNAL }
              }
            }
          }
        };
      }
      return {
        resolve: {
          alias: { [HOST_API_SPECIFIER]: devHostApi }
        },
        optimizeDeps: {
          exclude: [HOST_API_SPECIFIER, devHostApi]
        },
        define: {
          "import.meta.env.VITE_UNIFIED_APP_ID": JSON.stringify(opts.appId)
        }
      };
    }
  };
}
export {
  unifiedApp
};

//# debugId=8D6A7666A0556BEA64756E2164756E21
//# sourceMappingURL=index.js.map
