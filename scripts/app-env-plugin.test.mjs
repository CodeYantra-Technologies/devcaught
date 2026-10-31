import assert from "node:assert/strict";
import { test } from "node:test";
import { appEnvPlugin, APP_ENV_ROUTE } from "./app-env-plugin.mjs";

test("dev app-env endpoint exposes only the auth flag", () => {
  let middleware;
  const plugin = appEnvPlugin();

  plugin.configureServer({
    config: {
      env: {
        VITE_AUTH_ENABLED: "false",
        VITE_PUBLIC_EXAMPLE: "public-value",
        INTERNAL_TEST_SECRET: "must-not-leak",
      },
    },
    middlewares: {
      use(fn) {
        middleware = fn;
      },
    },
  });

  const headers = {};
  let responseBody = "";

  const response = {
    statusCode: 200,
    setHeader(name, value) {
      headers[name] = value;
    },
    end(body) {
      responseBody = body.toString("utf8");
    },
  };

  middleware(
    { url: APP_ENV_ROUTE, method: "GET" },
    response,
    () => assert.fail("endpoint unexpectedly passed to next middleware"),
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(responseBody), {
    VITE_AUTH_ENABLED: "false",
  });
  assert.equal(headers["cache-control"], "no-cache");
});
