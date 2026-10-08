import { fileURLToPath } from "node:url";

/** Dev-only fixture APIs. Builders are loaded through Vite's server-side TS loader. */
export function fixtureApiMiddleware() {
  return {
    name: "spider-dashboard-fixtures", apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = req.url?.split("?")[0];
        if (!path?.startsWith("/api/")) return next();
        const routes = { "/api/status": "statusFixture", "/api/overview": "overviewFixture", "/api/sessions": "sessionsFixture", "/api/calibration": "calibrationFixture" };
        try {
          const fixtures = await server.ssrLoadModule(fileURLToPath(new URL("../packages/host/src/usage/__tests__/fixtures/redesign-contract.ts", import.meta.url)));
          let body;
          if (path === "/api/fixture-states") body = fixtures.fixtureStateCases();
          else if (routes[path]) body = fixtures.envelope(fixtures[routes[path]]());
          else if (path.startsWith("/api/session/")) body = fixtures.envelope(fixtures.sessionFixture());
          else { res.statusCode = 404; res.end(); return; }
          res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify(body));
        } catch { res.statusCode = 500; res.end(JSON.stringify({ error: { code: "fixture-unavailable", message: "Fixture unavailable" } })); }
      });
    },
  };
}
