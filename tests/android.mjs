import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handleAndroidApi, handleAndroidDashboardApi } from "../src/android.js";

const sqlite = new DatabaseSync(":memory:");
const home = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const androidPage = readFileSync(new URL("../public/android/index.html", import.meta.url), "utf8");
assert.match(home, /https:\/\/apps\.apple\.com\/tw\/app\/chaiphoto\/id6817631025/);
assert.match(home, /href="\/android"/);
assert.match(androidPage, /name="viewport"/);
assert.match(androidPage, /尚未提供下載/);
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
    }
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
env.ANDROID_APK_BUCKET = {
  head: async key => key === "android/test.apk" ? { size: apk.length, checksums: { sha256: checksum } } : null,
  get: async key => key === "android/test.apk" ? { size: apk.length, body: apk } : null
};
const release = { version: "0.1", buildNumber: "1", r2Key: "android/test.apk", fileSize: apk.length, sha256, signingFingerprint: "verified manually in test", published: true };
assert.equal((await data(await call("/dashboard/api/android/release", "PUT", { ...release, sha256: "0".repeat(64) }, true))).ok, false);
assert.equal((await data(await call("/dashboard/api/android/release", "PUT", release, true))).ok, true);
assert.equal((await data(await call("/api/android/release"))).release.version, "0.1");
assert.equal((await call("/api/android/download")).status, 200);
assert.equal((await data(await call("/dashboard/api/android/stats", "GET", undefined, true))).downloads, 1);
console.log("Android migration, isolation, public fields, delete/restore, install deduplication and unavailable APK: OK");
