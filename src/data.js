// Test-data states for the app preview. Injected as the first, blocking
// script in the app's <head> so it wraps fetch() before the app makes any
// request. Only active inside the visual-edit shell iframe, and only for
// GET /api/ calls that aren't part of signing in.
//
// The state is read from sessionStorage (shared with the shell, same origin
// and tab); the shell sets it and reloads the iframe.
(function (root) {
  "use strict";

  var LONG = "and a considerably longer value than usual, to check wrapping, truncation and layout";
  var MANY = 25;

  function looksLikeText(s) {
    return /[a-z]/.test(s) && s.length > 1 &&
      !/^(https?:|\/|data:)/.test(s) &&          // URLs and paths
      !/^[^\s@]+@[^\s@]+$/.test(s) &&            // emails
      !/^\d{4}-\d{2}-\d{2}/.test(s) &&           // ISO dates
      !/^[0-9a-f-]{16,}$/i.test(s) &&            // ids
      !/^[A-Z0-9_]+$/.test(s);                   // enum codes
  }

  function bumpId(item, k) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    var copy = {};
    for (var key in item) copy[key] = item[key];
    for (var idKey of ["id", "key", "uuid"]) {
      if (typeof copy[idKey] === "number") copy[idKey] = copy[idKey] + 1000000 * k;
      else if (typeof copy[idKey] === "string") copy[idKey] = copy[idKey] + "-copy" + k;
    }
    return copy;
  }

  /** Reshapes one JSON response for a test-data state. */
  function transform(value, mode) {
    if (Array.isArray(value)) {
      if (mode === "empty") return [];
      var items = value.map(function (v) { return transform(v, mode); });
      if (mode === "many" && items.length > 0 && typeof items[0] === "object") {
        var out = items.slice();
        for (var k = 1; out.length < MANY; k++) {
          for (var i = 0; i < items.length && out.length < MANY; i++) out.push(bumpId(items[i], k));
        }
        return out;
      }
      return items;
    }
    if (value && typeof value === "object") {
      var obj = {};
      for (var key in value) obj[key] = transform(value[key], mode);
      return obj;
    }
    if (mode === "long" && typeof value === "string" && looksLikeText(value)) {
      return value + " " + LONG;
    }
    return value;
  }

  root.__veTransform = transform;

  var inShell = false;
  try { inShell = root.parent && root.parent !== root && !!root.parent.__veShell; } catch (e) { inShell = false; }
  if (!inShell) return;

  var state = "live";
  try { state = root.sessionStorage.getItem("ve-data-state") || "live"; } catch (e) {
    console.warn("[visual-edit] couldn't read the test-data state; showing live data", e);
  }
  if (state === "live") return;

  // Signing in and the signed-in user's own profile/roles stay real, or the
  // app's access checks fail before the page under test renders.
  var SESSION = /\/api\/(refresh|me|auth|logoff|changeSecurityContext|changeOwnPassword|mfa\w*)(?=$|[/?])/i;
  var OWN_DATA = /\/api\/my[A-Z]/;
  var realFetch = root.fetch.bind(root);
  root.fetch = function (input, init) {
    init = init || {};
    var url = typeof input === "string" ? input : (input && input.url) || String(input);
    var method = String(init.method || (input && input.method) || "GET").toUpperCase();
    if (url.indexOf("/api/") === -1 || SESSION.test(url) || OWN_DATA.test(url) || method !== "GET") {
      return realFetch(input, init);
    }
    if (state === "loading") return new Promise(function () {});
    if (state === "error") {
      return Promise.resolve(new Response(
        JSON.stringify({ error: "Simulated server error (visual editor test data)" }),
        { status: 500, headers: { "Content-Type": "application/json" } }));
    }
    return realFetch(input, init).then(function (res) {
      var type = res.headers.get("content-type") || "";
      if (!res.ok || type.indexOf("json") === -1) return res;
      return res.json().then(function (data) {
        var headers = new Headers(res.headers);
        headers.delete("content-length");
        return new Response(JSON.stringify(transform(data, state)), {
          status: res.status, statusText: res.statusText, headers: headers,
        });
      });
    });
  };
  console.info("[visual-edit] test data: " + state);
})(typeof window !== "undefined" ? window : globalThis);
