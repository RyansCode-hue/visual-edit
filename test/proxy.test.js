import { test } from "node:test";
import assert from "node:assert/strict";
import { rewriteSetCookie, rewriteLocation, injectScripts, rewriteResponseHeaders } from "../src/adapters/proxy.js";

test("cookies lose Domain and Secure, and SameSite=None becomes Lax", () => {
  assert.equal(
    rewriteSetCookie("sid=abc; Path=/; Domain=.example.com; Secure; HttpOnly; SameSite=None"),
    "sid=abc; Path=/; HttpOnly; SameSite=Lax");
  assert.equal(rewriteSetCookie("a=1; Partitioned; SameSite=Strict"), "a=1; SameSite=Strict");
});

test("redirects to the site stay on the local copy; others are left alone", () => {
  assert.equal(rewriteLocation("https://uat.example.com/login?next=%2F", "https://uat.example.com"), "/login?next=%2F");
  assert.equal(rewriteLocation("/dashboard", "https://uat.example.com"), "/dashboard");
  assert.equal(rewriteLocation("https://sso.example.com/auth", "https://uat.example.com"), "https://sso.example.com/auth");
});

test("scripts go first in head and last in body", () => {
  const out = injectScripts("<html><head><title>x</title></head><body><div id=root></div></body></html>");
  assert.match(out, /<head><script src="\/@visual-edit\/data\.js"><\/script><title>/);
  assert.match(out, /<div id=root><\/div><script src="\/@visual-edit\/stamp-dom\.js"><\/script><script type="module" src="\/@visual-edit\/canvas\.js"><\/script><\/body>/);
});

test("pages without head or body still get the scripts", () => {
  const out = injectScripts("<p>hi</p>");
  assert.match(out, /^<script src="\/@visual-edit\/data\.js">/);
  assert.match(out, /canvas\.js"><\/script>$/);
});

test("framing and CSP headers are dropped; cookies and redirects rewritten", () => {
  const out = rewriteResponseHeaders({
    "content-type": "text/html",
    "content-security-policy": "default-src 'self'",
    "content-security-policy-report-only": "x",
    "x-frame-options": "DENY",
    "strict-transport-security": "max-age=1",
    "transfer-encoding": "chunked",
    "set-cookie": ["a=1; Secure; Domain=x.com"],
    location: "https://site.test/next",
  }, "https://site.test");
  assert.deepEqual(out, { "content-type": "text/html", "set-cookie": ["a=1"], location: "/next" });
});
