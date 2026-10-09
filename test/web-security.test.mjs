import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import test from "node:test";
import worker from "../src/index.js";
import { verifyAccessRequest } from "../src/access-auth.js";

const teamDomain = "example.cloudflareaccess.com";
const audience = "dashboard-audience";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const sign = (claims, header = { alg: "RS256", kid: "test-key" }) => {
  const data = `${encode(header)}.${encode(claims)}`;
  return `${data}.${createSign("RSA-SHA256").update(data).sign(privateKey).toString("base64url")}`;
};
const claims = () => ({
  iss: `https://${teamDomain}`, aud: [audience],
  exp: Math.floor(Date.now() / 1000) + 600
});
const request = token => new Request("https://photo.chaihome.cc/dashboard/api/feedback", {
  headers: token ? { "Cf-Access-Jwt-Assertion": token } : {}
});
const certs = async () => Response.json({ keys: [jwk] });

test("both report pages retain parseable inline scripts", () => {
  for (const page of ["../public/report/index.html", "../public/android/report/index.html"]) {
    const html = readFileSync(new URL(page, import.meta.url), "utf8");
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length > 0);
    for (const script of scripts) new Script(script[1], { filename: page });
  }
});

test("Access rejects missing, forged, expired and wrong-audience assertions", async () => {
  const env = { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: audience };
  assert.equal(await verifyAccessRequest(request(), env, certs), false);
  assert.equal(await verifyAccessRequest(request(sign({ ...claims(), exp: 1 })), env, certs), false);
  assert.equal(await verifyAccessRequest(request(sign({ ...claims(), aud: ["other"] })), env, certs), false);
  assert.equal(await verifyAccessRequest(request(sign({ ...claims(), iss: "https://other.cloudflareaccess.com" })), env, certs), false);
  const valid = sign(claims());
  const parts = valid.split(".");
  parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
  assert.equal(await verifyAccessRequest(request(parts.join(".")), env, certs), false);
  assert.equal(await verifyAccessRequest(request(sign(claims())), {}, certs), false);
  assert.equal(await verifyAccessRequest(request(sign(claims())), env, certs), true);
});

test("dashboard ignores a spoofed identity header before touching D1", async () => {
  let databaseCalls = 0;
  const response = await worker.fetch(new Request("https://photo.chaihome.cc/dashboard/api/feedback", {
    headers: { "Cf-Access-Authenticated-User-Email": "fake@example.test" }
  }), { DB: { prepare() { databaseCalls++; throw new Error("D1 must not be used"); } } });
  assert.equal(response.status, 404);
  assert.equal(databaseCalls, 0);
});

test("all dashboard route variants reject spoofed headers before assets or D1", async () => {
  for (const path of ["/dashboard", "/dashboard/", "/dashboard/api/not-real"]) {
    let accessed = false;
    const response = await worker.fetch(new Request(`https://photo.chaihome.cc${path}`, {
      headers: { "Cf-Access-Authenticated-User-Email": "fake@example.test" }
    }), {
      DB: { prepare() { accessed = true; throw new Error("D1 should not be reached"); } },
      ASSETS: { fetch() { accessed = true; throw new Error("Assets should not be reached"); } }
    });
    assert.equal(response.status, 404);
    assert.equal(accessed, false);
  }
});

function fakeEnvironment(item, observedSql = []) {
  return {
    FEEDBACK_LOOKUP_LIMITER: { async limit() { return { success: true }; } },
    DB: {
      async batch() {},
      prepare(sql) {
        observedSql.push(sql);
        return {
          bind() { return this; },
          async all() {
            return sql.includes("LEFT JOIN") ? { results: [] } : {
              results: [Object.fromEntries(Object.entries(item).filter(([key]) => !["unable_reason", "deletion_reason"].includes(key)))]
            };
          },
          async first() { return item; }
        };
      }
    }
  };
}

test("public lookup never returns internal reasons, including deleted and private reports", async () => {
  const item = {
    report_number: 1, status: "closed", category: "other", is_public: 0,
    unable_reason: "PRIVATE_UNABLE", deletion_reason: "PRIVATE_DELETION",
    created_at: "2026-10-09T00:00:00Z", deleted_at: null
  };
  const url = "https://photo.chaihome.cc/api/feedback-status?id=BETA-001";
  const active = await worker.fetch(new Request(url), fakeEnvironment(item));
  assert.equal(active.status, 200);
  assert.equal(JSON.stringify(await active.json()).includes("PRIVATE_"), false);

  const deleted = await worker.fetch(new Request(url), fakeEnvironment({ ...item, deleted_at: "2026-10-09T01:00:00Z" }));
  assert.equal(deleted.status, 200);
  assert.equal(JSON.stringify(await deleted.json()).includes("PRIVATE_"), false);

  const queries = [];
  const list = await worker.fetch(new Request("https://photo.chaihome.cc/api/public-feedback"), fakeEnvironment(item, queries));
  assert.equal(list.status, 200);
  assert.equal(JSON.stringify(await list.json()).includes("PRIVATE_"), false);
  assert.equal(queries.find(sql => sql.includes("WHERE f.is_public = 1")).includes("t.unable_reason"), false);
});

function reportFixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/0001_create_feedback.sql", import.meta.url), "utf8"));
  db.exec(`ALTER TABLE feedback ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE feedback ADD COLUMN public_title TEXT;
    ALTER TABLE feedback ADD COLUMN public_note TEXT;
    ALTER TABLE feedback ADD COLUMN fixed_version TEXT;
    ALTER TABLE feedback ADD COLUMN fixed_build TEXT;
    ALTER TABLE feedback ADD COLUMN updated_at TEXT;
    CREATE TABLE feedback_tracking (
      feedback_id TEXT PRIMARY KEY, report_number INTEGER NOT NULL UNIQUE,
      eta_seconds INTEGER, eta_due_at TEXT, fix_published INTEGER NOT NULL DEFAULT 0,
      unable_reason TEXT, diagnostics_json TEXT, deleted_at TEXT, deletion_reason TEXT
    );
    CREATE TABLE feedback_counter (singleton INTEGER PRIMARY KEY, next_number INTEGER NOT NULL);
    INSERT INTO feedback_counter VALUES (1, 1);`);
  db.exec(readFileSync(new URL("../migrations/0002_feedback_lookup_tokens.sql", import.meta.url), "utf8"));
  const DB = {
    prepare(sql) {
      return {
        sql, values: [],
        bind(...values) { this.values = values; return this; },
        async all() { return { results: db.prepare(sql).all(...this.values) }; },
        async first() { return db.prepare(sql).get(...this.values) || null; },
        async run() { return { meta: db.prepare(sql).run(...this.values) }; }
      };
    },
    async batch(statements) {
      db.exec("BEGIN");
      try {
        for (const statement of statements) db.prepare(statement.sql).run(...statement.values);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }
  };
  const rateLimit = { async limit() { return { success: true }; } };
  return { db, DB, FEEDBACK_SUBMIT_LIMITER: rateLimit,
    FEEDBACK_LOOKUP_LIMITER: rateLimit, close: () => db.close() };
}

const postReport = (env, platform, token, description = "Generated test report only") =>
  worker.fetch(new Request("https://photo.chaihome.cc/api/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://photo.chaihome.cc",
      "CF-Connecting-IP": "192.0.2.1" },
    body: JSON.stringify({ platform, category: "other", description, lookupToken: token })
  }), env);

test("isolated token migration, iOS/Android writes and duplicate retries stay atomic", async () => {
  const env = reportFixture();
  try {
    for (const [platform, expectedSource] of [["ios", "web"], ["android", "android"]]) {
      const token = `CPR-${Buffer.alloc(32, platform === "ios" ? 1 : 2).toString("base64url")}`;
      const first = await postReport(env, platform, token);
      assert.equal(first.status, 201);
      const result = await first.json();
      assert.equal(result.lookupToken, token);
      const repeated = await postReport(env, platform, token);
      assert.equal(repeated.status, 200);
      assert.equal((await repeated.json()).id, result.id);
      const conflict = await postReport(env, platform, token, "Different generated payload");
      assert.equal(conflict.status, 409);
      assert.equal(env.db.prepare("SELECT source FROM feedback WHERE id = (SELECT feedback_id FROM feedback_tracking WHERE report_number = ?)")
        .get(Number(result.id.slice(5))).source, expectedSource);
    }
    assert.equal(env.db.prepare("SELECT count(*) AS count FROM feedback").get().count, 2);
    assert.equal(env.db.prepare("SELECT next_number FROM feedback_counter").get().next_number, 3);
    assert.equal(env.db.prepare("SELECT count(*) AS count FROM feedback_lookup_tokens").get().count, 2);
  } finally { env.close(); }
});

test("new tokens use POST lookup; legacy BETA gets only status; new BETA cannot be enumerated", async () => {
  const env = reportFixture();
  try {
    env.db.prepare(`INSERT INTO feedback (id, created_at, status, category, description)
      VALUES ('legacy', '2026-10-01', 'closed', 'other', 'private generated text')`).run();
    env.db.prepare("INSERT INTO feedback_tracking (feedback_id, report_number, unable_reason) VALUES ('legacy', 1, 'private generated reason')").run();
    env.db.prepare("UPDATE feedback_counter SET next_number = 2").run();
    const token = `CPR-${Buffer.alloc(32, 3).toString("base64url")}`;
    const created = await postReport(env, "android", token);
    assert.equal(created.status, 201);
    const legacy = await worker.fetch(new Request("https://photo.chaihome.cc/api/feedback-status?id=BETA-001"), env);
    assert.equal(legacy.status, 200);
    assert.deepEqual(Object.keys((await legacy.json()).feedback).sort(), ["report_id", "status"]);
    const enumerable = await worker.fetch(new Request("https://photo.chaihome.cc/api/feedback-status?id=BETA-002"), env);
    assert.equal(enumerable.status, 404);
    const lookup = await worker.fetch(new Request("https://photo.chaihome.cc/api/feedback-status", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    }), env);
    assert.equal(lookup.status, 200);
    assert.equal((await lookup.json()).feedback.report_id, "BETA-002");
    const stored = env.db.prepare("SELECT token_hash FROM feedback_lookup_tokens").get().token_hash;
    assert.match(stored, /^[0-9a-f]{64}$/);
    assert.notEqual(stored, token);
  } finally { env.close(); }
});

test("submission and lookup throttles fail closed and reject over-limit requests", async () => {
  const env = reportFixture();
  try {
    env.FEEDBACK_SUBMIT_LIMITER = { async limit() { return { success: false }; } };
    const token = `CPR-${Buffer.alloc(32, 4).toString("base64url")}`;
    assert.equal((await postReport(env, "ios", token)).status, 429);
    assert.equal(env.db.prepare("SELECT count(*) AS count FROM feedback").get().count, 0);
    env.FEEDBACK_LOOKUP_LIMITER = { async limit() { return { success: false }; } };
    const lookup = await worker.fetch(new Request("https://photo.chaihome.cc/api/feedback-status?id=BETA-001"), env);
    assert.equal(lookup.status, 429);
    delete env.FEEDBACK_LOOKUP_LIMITER;
    assert.equal((await worker.fetch(new Request("https://photo.chaihome.cc/api/feedback-status?id=BETA-001"), env)).status, 503);
  } finally { env.close(); }
});

test("closed and deleted legacy reports disclose no private reason or content", async () => {
  const env = reportFixture();
  try {
    env.db.prepare(`INSERT INTO feedback
      (id, created_at, status, category, description, is_public, public_note)
      VALUES ('closed', '2026-10-01', 'closed', 'other', 'private generated description', 0, 'private generated note')`).run();
    env.db.prepare(`INSERT INTO feedback_tracking
      (feedback_id, report_number, unable_reason) VALUES ('closed', 1, 'private generated reason')`).run();
    const url = "https://photo.chaihome.cc/api/feedback-status?id=BETA-001";
    const closed = await worker.fetch(new Request(url), env);
    assert.equal(closed.status, 200);
    assert.deepEqual((await closed.json()).feedback, { report_id: "BETA-001", status: "closed" });
    env.db.prepare(`UPDATE feedback_tracking SET deleted_at = '2026-10-09', deletion_reason = 'private deleted reason'
      WHERE feedback_id = 'closed'`).run();
    const deleted = await worker.fetch(new Request(url), env);
    assert.deepEqual((await deleted.json()).feedback, { report_id: "BETA-001", status: "deleted" });
  } finally { env.close(); }
});

test("token lookup shows approved public closure note but never internal reason", async () => {
  const env = reportFixture();
  try {
    const token = `CPR-${Buffer.alloc(32, 5).toString("base64url")}`;
    const created = await postReport(env, "ios", token);
    assert.equal(created.status, 201);
    env.db.prepare(`UPDATE feedback SET status = 'closed', is_public = 1,
      public_note = 'Approved public closure note'`).run();
    env.db.prepare(`UPDATE feedback_tracking SET unable_reason = 'Internal private closure reason'`).run();
    const response = await worker.fetch(new Request("https://photo.chaihome.cc/api/feedback-status", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    }), env);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.feedback.status, "closed");
    assert.equal(result.feedback.public_note, "Approved public closure note");
    assert.equal(JSON.stringify(result).includes("Internal private"), false);
  } finally { env.close(); }
});

test("oversized feedback is rejected before D1 is accessed", async () => {
  let databaseCalls = 0;
  const response = await worker.fetch(new Request("https://photo.chaihome.cc/api/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description: "X".repeat(17 * 1024) })
  }), { DB: { prepare() { databaseCalls++; throw new Error("D1 must not be used"); } } });
  assert.equal(response.status, 413);
  assert.equal(databaseCalls, 0);
});

function dashboardFixture(state) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE feedback (
    id TEXT PRIMARY KEY, created_at TEXT, status TEXT, category TEXT,
    description TEXT, steps TEXT, app_version TEXT, build_number TEXT,
    ios_version TEXT, device_model TEXT, source TEXT, is_public INTEGER,
    public_title TEXT, public_note TEXT, fixed_version TEXT,
    fixed_build TEXT, updated_at TEXT);
    CREATE TABLE feedback_tracking (
      feedback_id TEXT PRIMARY KEY, report_number INTEGER UNIQUE,
      eta_seconds INTEGER, eta_due_at TEXT, fix_published INTEGER,
      unable_reason TEXT, diagnostics_json TEXT, deleted_at TEXT,
      deletion_reason TEXT);`);
  const insertFeedback = db.prepare("INSERT INTO feedback (id, created_at, status, category, description) VALUES (?, ?, ?, 'other', 'generated')");
  const insertTracking = db.prepare("INSERT INTO feedback_tracking (feedback_id, report_number, deleted_at) VALUES (?, ?, ?)");
  for (let number = 1; number <= 505; number++) {
    const status = state === "mixed" ? ["new", "in_progress", "resolved", "closed"][number % 4] : state;
    const deleted = state === "deleted" || (state === "mixed" && number % 7 === 0);
    // Same timestamps exercise the stable report-number tie breaker.
    const createdAt = `2026-10-${String(1 + (number % 9)).padStart(2, "0")}T00:00:00Z`;
    insertFeedback.run(String(number), createdAt, status === "deleted" ? "new" : status);
    insertTracking.run(String(number), number, deleted ? "2026-10-09T00:00:00Z" : null);
  }
  const binding = {
    prepare(sql) {
      return {
        bind(...args) { this.args = args; return this; },
        async all() { return { results: db.prepare(sql).all(...(this.args || [])) }; },
        async first() { return db.prepare(sql).get(...(this.args || [])) || null; },
        async run() { return { meta: db.prepare(sql).run(...(this.args || [])) }; }
      };
    },
    async batch(statements) { for (const statement of statements) await statement.run(); }
  };
  return { DB: binding, ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: audience, close: () => db.close() };
}

test("dashboard paging covers all reports and orders mixed, deleted and new groups", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = certs;
  try {
    for (const state of ["mixed", "deleted", "new"]) {
      const env = dashboardFixture(state);
      try {
        const token = sign(claims());
        const all = [];
        let counts;
        for (const offset of [0, 500]) {
          const response = await worker.fetch(new Request(`https://photo.chaihome.cc/dashboard/api/feedback?offset=${offset}`, {
            headers: { "Cf-Access-Jwt-Assertion": token }
          }), env);
          assert.equal(response.status, 200);
          const result = await response.json();
          assert.equal(result.total, 505);
          counts = result.counts;
          all.push(...result.feedback);
        }
        assert.equal(all.length, 505);
        assert.equal(new Set(all.map(item => item.id)).size, 505);
        assert.equal(Object.values(counts).slice(0, 5).reduce((sum, value) => sum + value, 0), 505);
        const rank = item => item.deleted_at ? 3 : item.status === "new" ? 0 : item.status === "in_progress" ? 1 : 2;
        const expected = [...all].sort((a, b) => rank(a) - rank(b) ||
          b.created_at.localeCompare(a.created_at) || b.report_number - a.report_number);
        assert.deepEqual(all.map(item => item.id), expected.map(item => item.id));
        for (const status of ["new", "in_progress", "resolved", "closed", "deleted"]) {
          const filtered = all.filter(item => item.deleted_at ? status === "deleted" : item.status === status);
          const timeOrdered = [...filtered].sort((a, b) =>
            b.created_at.localeCompare(a.created_at) || b.report_number - a.report_number);
          assert.deepEqual(filtered.map(item => item.id), timeOrdered.map(item => item.id));
        }
      } finally {
        env.close();
      }
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});
