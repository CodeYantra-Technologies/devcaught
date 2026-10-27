import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import * as session from "../../lib/auth/browser-session.ts";
import * as access from "../../lib/inbox/browser-access.ts";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { QueryClient, QueryClientProvider } = require("@tanstack/react-query");

function loadComponent(filename) {
  const source = readFileSync(new URL(filename, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const unexpectedRequest = () => { throw new Error("SSR must not initiate authentication or inbox requests"); };
  const dependencies = {
    react: React,
    "react/jsx-runtime": require("react/jsx-runtime"),
    "@tanstack/react-query": require("@tanstack/react-query"),
    "../../lib/auth/browser-session.ts": session,
    "../../lib/auth/client": { signOut: unexpectedRequest },
    "../../lib/api": { fetchStatus: unexpectedRequest },
    "../../lib/inbox/browser-access.ts": access,
  };
  const module = { exports: {} };
  const resolve = name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected SSR dependency: ${name}`);
    return dependencies[name];
  };
  new Function("require", "module", "exports", compiled.outputText)(resolve, module, module.exports);
  return module.exports;
}

const { VerifiedSessionBoundary } = loadComponent("./VerifiedSessionBoundary.tsx");
const { AuthPage } = loadComponent("./AuthPage.tsx");

test("server-rendered protected content stays hidden pending fresh session verification", () => {
  const client = new QueryClient();
  try {
    const html = renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(VerifiedSessionBoundary, null,
        React.createElement("p", null, "fixture-private-message-must-stay-hidden"))));
    assert.doesNotMatch(html, /fixture-private-message-must-stay-hidden/);
    assert.match(html, /Checking your session/);
  } finally {
    client.clear();
  }
});

test("registration retains invitation fields while login offers only credentials", () => {
  assert.match(renderToStaticMarkup(React.createElement(AuthPage, { registration: true })), /name="invitationToken"/);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(AuthPage)), /name="invitationToken"/);
});
