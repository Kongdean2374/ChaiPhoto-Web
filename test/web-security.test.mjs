import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
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

function fakeEnvironment(item, observedSql = []) {
  return {
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

test("iOS and Android report submissions retain their existing source mapping", async () => {
  for (const [platform, expectedSource] of [["ios", "web"], ["android", "android"]]) {
    const inserted = [];
    const env = {
      DB: {
        async batch(statements) {
          if (statements.some(statement => statement.sql.includes("INSERT INTO feedback\n"))) {
            inserted.push(...statements);
          }
        },
        prepare(sql) {
          return {
            sql,
            bind(...values) { this.values = values; return this; },
            async all() { return { results: [] }; },
            async first() { return { report_number: 1 }; }
          };
        }
      }
    };
    const response = await worker.fetch(new Request("https://photo.chaihome.cc/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://photo.chaihome.cc" },
      body: JSON.stringify({ platform, category: "other", description: "Generated test report only" })
    }), env);
    assert.equal(response.status, 201);
    assert.equal((await response.json()).id, "BETA-001");
    assert.equal(inserted[0].values.at(-1), expectedSource);
  }
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
      } finally {
        env.close();
      }
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});
