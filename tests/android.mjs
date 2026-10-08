import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";
import worker from "../src/index.js";
import { handleAndroidApi, handleAndroidDashboardApi } from "../src/android.js";

const sqlite = new DatabaseSync(":memory:");
const home = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const androidPage = readFileSync(new URL("../public/android/index.html", import.meta.url), "utf8");
assert.match(home, /https:\/\/apps\.apple\.com\/tw\/app\/chaiphoto\/id6817631025/);
assert.match(home, /href="\/android"/);
assert.match(androidPage, /name="viewport"/);
assert.match(androidPage, /尚未提供下載/);
const reportHtml = readFileSync(new URL("../public/android/report/index.html", import.meta.url), "utf8");
const reportScript = reportHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";
const statusCode = reportScript.slice(reportScript.indexOf("const statusLabels="), reportScript.indexOf('document.getElementById("android-form")'));
const documentStub = { createElement: () => ({ children: [], append(child) { this.children.push(child); } }) };
for (const [status, expected] of Object.entries({ new: "待評估", in_progress: "評估／開發中", resolved: "已加入", closed: "暫不採用" })) {
  const title = vm.runInNewContext(`${statusCode}\ncard({ report_id:"AND-001", category:"suggestion", status:${JSON.stringify(status)} }).children[0].textContent`, { document: documentStub });
  assert.equal(title, `AND-001 · ${expected}`);
}
assert.equal(vm.runInNewContext(`${statusCode}\ncard({ report_id:"AND-002", category:"crash", status:"new" }).children[0].textContent`, { document: documentStub }), "AND-002 · 待處理");
sqlite.exec(readFileSync(new URL("../migrations/0001_create_feedback.sql", import.meta.url), "utf8"));
sqlite.exec(readFileSync(new URL("../migrations/0002_android_test.sql", import.meta.url), "utf8"));
const env = {
  DB: {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        first() { return sqlite.prepare(sql).get(...values) || null; },
        all() { return { results: sqlite.prepare(sql).all(...values) }; },
        run() { const result = sqlite.prepare(sql).run(...values); return { meta: { changes: result.changes } }; }
      };
    },
    batch(statements) { return Promise.all(statements.map(statement => statement.run())); }
  },
  ANDROID_HASH_SECRET: "test-only-random-secret"
};
const base = "https://photo.chaihome.cc";
const call = async (path, method = "GET", data, admin = false) => {
  const url = new URL(path, base);
  const request = new Request(url, { method, headers: data ? { "Content-Type": "application/json", Origin: base } : {}, body: data ? JSON.stringify(data) : undefined });
  return (admin ? handleAndroidDashboardApi : handleAndroidApi)(request, env, url);
};
const data = response => response.json();

const submitted = await data(await call("/api/android/feedback", "POST", { category: "suggestion", description: "希望加入相簿篩選", steps: "整理旅行相片", appVersion: "private-ignore" }));
assert.equal(submitted.id, "AND-001");
assert.equal(sqlite.prepare("SELECT app_version FROM android_feedback WHERE report_number=1").get().app_version, null);
assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM feedback").get().n, 0);
assert.equal((await data(await call("/api/android/feedback-status?id=BETA-001"))).ok, false);
const own = await data(await call("/api/android/feedback-status?id=AND-001"));
assert.equal(own.feedback.report_id, "AND-001");
assert.equal(Object.hasOwn(own.feedback, "description"), false);
assert.equal((await data(await call("/api/android/public-feedback"))).feedback.length, 0);

const id = sqlite.prepare("SELECT id FROM android_feedback WHERE report_number=1").get().id;
const updated = await data(await call("/dashboard/api/android/feedback", "PATCH", { id, status: "in_progress", etaSeconds: 60, isPublic: true, publicTitle: "相簿篩選", publicNote: "規劃中", fixPublished: false }, true));
assert.equal(updated.ok, true);
const publicRows = (await data(await call("/api/android/public-feedback"))).feedback;
assert.equal(publicRows.length, 1);
assert.equal(Object.hasOwn(publicRows[0], "description"), false);
assert.equal(Object.hasOwn(publicRows[0], "diagnostics_json"), false);
assert.equal((await data(await call("/dashboard/api/android/feedback", "DELETE", { id }, true))).ok, true);
assert.equal((await data(await call("/api/android/public-feedback"))).feedback.length, 0);
assert.equal((await data(await call("/dashboard/api/android/feedback/restore", "POST", { id }, true))).ok, true);

const installationId = "16bff4da-9a82-4e63-9859-80e46ab243b2";
await call("/api/android/open", "POST", { installationId });
await call("/api/android/open", "POST", { installationId });
const stats = await data(await call("/dashboard/api/android/stats", "GET", undefined, true));
assert.equal(stats.firstOpens, 1);
assert.equal(stats.active30Days, 1);
assert.equal(stats.downloads, 0);
assert.equal((await call("/api/android/download")).status, 404);
const apk = new TextEncoder().encode("test apk bytes");
const checksum = await crypto.subtle.digest("SHA-256", apk);
const sha256 = Array.from(new Uint8Array(checksum), byte => byte.toString(16).padStart(2, "0")).join("");
const r2Key = `android/0.1/build-1/${sha256}.apk`;
let currentObject = { size: apk.length, checksums: { sha256: checksum }, body: apk };
env.ANDROID_APK_BUCKET = {
  head: async key => key === r2Key ? currentObject : null,
  get: async key => key === r2Key ? currentObject : null
};
const release = { version: "0.1", buildNumber: "1", r2Key, fileSize: apk.length, sha256, signingFingerprint: "verified manually in test", published: true };
assert.equal((await data(await call("/dashboard/api/android/release", "PUT", { ...release, sha256: "0".repeat(64) }, true))).ok, false);
assert.equal((await data(await call("/dashboard/api/android/release", "PUT", release, true))).ok, true);
assert.equal((await data(await call("/api/android/release"))).release.version, "0.1");
assert.equal((await call("/api/android/download")).status, 200);
assert.equal((await data(await call("/dashboard/api/android/stats", "GET", undefined, true))).downloads, 1);
const replaced = new Uint8Array(apk);
replaced[0] ^= 1;
const replacedSha = await crypto.subtle.digest("SHA-256", replaced);
currentObject = { size: apk.length, checksums: { sha256: replacedSha }, body: replaced };
assert.equal((await call("/api/android/download")).status, 409);
assert.equal((await data(await call("/dashboard/api/android/stats", "GET", undefined, true))).downloads, 1);
currentObject = { size: apk.length, checksums: {}, body: apk };
assert.equal((await call("/api/android/download")).status, 409);
assert.equal((await call("/dashboard/api/android/release", "PUT", release, true)).status, 409);

// Existing iOS API remains separate and continues to allocate BETA IDs.
for (const column of ["is_public INTEGER DEFAULT 0", "public_title TEXT", "public_note TEXT", "fixed_version TEXT", "fixed_build TEXT", "updated_at TEXT"]) sqlite.exec(`ALTER TABLE feedback ADD COLUMN ${column}`);
const iosRequest = new Request(`${base}/api/feedback`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ category: "other", description: "iOS 回報仍可送出" }) });
const iosSubmission = await data(await worker.fetch(iosRequest, env));
assert.equal(iosSubmission.id, "BETA-001");
const iosStatus = await data(await worker.fetch(new Request(`${base}/api/feedback-status?id=BETA-001`), env));
assert.equal(iosStatus.feedback.report_id, "BETA-001");
assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM android_feedback").get().n, 1);
assert.equal((await data(await worker.fetch(new Request(`${base}/api/public-feedback`), env))).feedback.length, 0);

// The Worker gate applies to every /dashboard API, including Android management.
env.ASSETS = { fetch: async () => new Response("dashboard") };
const forgedHeaders = { "Cf-Access-Authenticated-User-Email": "admin@example.com" };
assert.equal((await worker.fetch(new Request(`${base}/dashboard/api/android/stats`, { headers: forgedHeaders }), env)).status, 404);
assert.equal((await worker.fetch(new Request(`${base}/dashboard/api/feedback`, { headers: forgedHeaders }), env)).status, 404);
assert.equal((await worker.fetch(new Request(`${base}/dashboard/api/android/feedback`, { method: "PATCH", headers: { ...forgedHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ id, status: "closed", etaSeconds: 0 }) }), env)).status, 404);
assert.equal(sqlite.prepare("SELECT status FROM android_feedback WHERE id=?").get(id).status, "in_progress");

// Test a real RSA signature against a mocked Cloudflare Access cert endpoint.
env.CF_ACCESS_TEAM_DOMAIN = "https://example.cloudflareaccess.com";
env.CF_ACCESS_AUD = "test-dashboard-audience";
const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "test-key", alg: "RS256", use: "sig" };
const originalFetch = globalThis.fetch;
globalThis.fetch = async url => {
  assert.equal(url, "https://example.cloudflareaccess.com/cdn-cgi/access/certs");
  return Response.json({ keys: [jwk] });
};
const b64 = value => Buffer.from(JSON.stringify(value)).toString("base64url");
async function token(claims) {
  const signed = `${b64({ alg: "RS256", kid: "test-key" })}.${b64(claims)}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(signed));
  return `${signed}.${Buffer.from(signature).toString("base64url")}`;
}
const claims = { iss: env.CF_ACCESS_TEAM_DOMAIN, aud: [env.CF_ACCESS_AUD], exp: Math.floor(Date.now() / 1000) + 300 };
const validJwt = await token(claims);
const dashboardRequest = (path, jwt) => new Request(`${base}${path}`, { headers: { "Cf-Access-Jwt-Assertion": jwt } });
assert.equal((await worker.fetch(new Request(`${base}/dashboard/api/android/stats`, { headers: forgedHeaders }), env)).status, 404);
assert.equal((await worker.fetch(dashboardRequest("/dashboard/api/android/stats", validJwt), env)).status, 200);
assert.equal((await worker.fetch(dashboardRequest("/dashboard/api/feedback", validJwt), env)).status, 200);
assert.equal((await worker.fetch(dashboardRequest("/dashboard/api/android/stats", await token({ ...claims, aud: ["wrong-audience"] })), env)).status, 404);
assert.equal((await worker.fetch(dashboardRequest("/dashboard/api/android/stats", await token({ ...claims, exp: 1 })), env)).status, 404);
const jwtParts = validJwt.split(".");
jwtParts[2] = (jwtParts[2][0] === "A" ? "B" : "A") + jwtParts[2].slice(1);
assert.equal((await worker.fetch(dashboardRequest("/dashboard/api/android/stats", jwtParts.join(".")), env)).status, 404);
globalThis.fetch = originalFetch;
console.log("Android/iOS API isolation, APK integrity, Access JWT authorization, and Dashboard compatibility: OK");
