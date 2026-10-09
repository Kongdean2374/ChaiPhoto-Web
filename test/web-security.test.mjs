import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";
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
