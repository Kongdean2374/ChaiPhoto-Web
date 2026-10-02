const json = (data, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });

const clean = (value, max) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const allowedStatuses = new Set([
  "new",
  "in_progress",
  "resolved",
  "closed"
]);

const allowedCategories = new Set([
  "crash",
  "performance",
  "photos",
  "videos",
  "icloud",
  "ui",
  "suggestion",
  "other"
]);

const diagnosticKeys = new Set([
  "photoAccess",
  "language",
  "appearance",
  "deleteDirection",
  "haptics",
  "cloudPhoto",
  "cloudVideo",
  "photoPreload",
  "videoPreload",
  "fullSpeedPreload",
  "lowPowerMode"
]);

const dashboardHost = "photo.chaihome.cc";

function isDashboardRequest(url) {
  return (
    url.pathname === "/dashboard" ||
    url.pathname.startsWith("/dashboard/")
  );
}

function hasAccessIdentity(request) {
  return Boolean(
    request.headers.get("Cf-Access-Authenticated-User-Email") ||
    request.headers.get("Cf-Access-Jwt-Assertion")
  );
}

function formatReportId(number) {
  return "BETA-" + String(number).padStart(3, "0");
}

function parseReportNumber(value) {
  const normalized = clean(value, 80)
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/^BETA[-_]?/, "");

  if (!/^\d+$/.test(normalized)) return null;

  const number = Number.parseInt(normalized, 10);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

const feedbackFieldStates = new Set([
  "provided",
  "missing",
  "not_applicable"
]);

const betaAliases = new Set(["B", "BE", "BET", "BETA"]);
const testFlightAliases = new Set([
  "T",
  "TE",
  "TES",
  "TEST",
  "TF",
  "FT",
  "TESTF",
  "TESTFLIGHT"
]);

function formatSourceReportId(sourceKey, number) {
  const prefix = sourceKey === "tf" ? "TF" : "BETA";
  return prefix + "-" + String(Number(number) || 0).padStart(3, "0");
}

function parseReportReference(value) {
  const raw = clean(value, 80).toUpperCase();
  if (!raw) return null;

  // Treat spaces, dashes, slashes, dots and underscores as optional separators.
  const normalized = raw.replace(/[\s\-_/\\.]+/g, "");
  const match = normalized.match(/^([A-Z]*)(\d+)$/);

  if (!match) return null;

  const prefix = match[1];
  const number = Number.parseInt(match[2], 10);

  if (!Number.isSafeInteger(number) || number < 1) return null;

  if (!prefix) {
    return { sourceKey: null, number };
  }

  if (betaAliases.has(prefix)) {
    return { sourceKey: "beta", number };
  }

  if (testFlightAliases.has(prefix)) {
    return { sourceKey: "tf", number };
  }

  return null;
}

async function ensureFeedbackAttachmentPublicSchema(env) {
  const info = await env.DB.prepare(
    "PRAGMA table_info(feedback_attachments)"
  ).all();

  const columns = new Set(
    (info.results || []).map(row => String(row.name || ""))
  );

  const additions = [
    ["public_storage_key", "TEXT"],
    ["public_mime_type", "TEXT"],
    ["public_byte_size", "INTEGER"],
    ["public_updated_at", "TEXT"]
  ];

  for (const [name, type] of additions) {
    if (columns.has(name)) continue;

    await env.DB.prepare(
      "ALTER TABLE feedback_attachments ADD COLUMN " + name + " " + type
    ).run();
  }
}

async function ensureFeedbackV2Schema(env) {
  await env.DB.batch([
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS feedback_v2_meta (
        feedback_id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL
          CHECK (source_key IN ('beta', 'tf')),
        source_number INTEGER NOT NULL CHECK (source_number >= 1),
        original_description TEXT,
        original_steps TEXT,
        edited_description TEXT,
        edited_steps TEXT,
        description_state TEXT NOT NULL DEFAULT 'provided'
          CHECK (description_state IN ('provided', 'missing', 'not_applicable')),
        steps_state TEXT NOT NULL DEFAULT 'missing'
          CHECK (steps_state IN ('provided', 'missing', 'not_applicable')),
        external_resource_id TEXT,
        external_event_type TEXT,
        private_metadata_json TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (source_key, source_number),
        UNIQUE (source_key, external_resource_id)
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS feedback_source_counter (
        source_key TEXT PRIMARY KEY
          CHECK (source_key IN ('beta', 'tf')),
        next_number INTEGER NOT NULL CHECK (next_number >= 1)
      )`
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO feedback_source_counter (source_key, next_number)
       VALUES ('beta', 1)`
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO feedback_source_counter (source_key, next_number)
       VALUES ('tf', 1)`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS feedback_attachments (
        id TEXT PRIMARY KEY,
        feedback_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('web', 'testflight')),
        storage_key TEXT,
        mime_type TEXT,
        original_filename TEXT,
        byte_size INTEGER,
        remote_url TEXT,
        expires_at TEXT,
        width INTEGER,
        height INTEGER,
        public_storage_key TEXT,
        public_mime_type TEXT,
        public_byte_size INTEGER,
        public_updated_at TEXT,
        is_public INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0, 1)),
        created_at TEXT NOT NULL
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS feedback_ingest_events (
        event_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        event_type TEXT,
        resource_id TEXT,
        feedback_id TEXT,
        received_at TEXT NOT NULL,
        processed_at TEXT,
        payload_json TEXT
      )`
    )
  ]);

  await ensureFeedbackAttachmentPublicSchema(env);
}

async function nextSourceNumber(env, sourceKey) {
  await ensureFeedbackV2Schema(env);

  const row = await env.DB.prepare(
    `UPDATE feedback_source_counter
     SET next_number = next_number + 1
     WHERE source_key = ?
     RETURNING next_number - 1 AS source_number`
  )
    .bind(sourceKey)
    .first();

  if (!row?.source_number) {
    throw new Error("Unable to allocate source report number");
  }

  return Number(row.source_number);
}

async function ensureFeedbackV2Rows(env) {
  await ensureFeedbackV2Schema(env);

  const maxBeta = await env.DB.prepare(
    `SELECT COALESCE(MAX(report_number), 0) AS max_number
     FROM feedback_tracking`
  ).first();

  const nextBeta = Number(maxBeta?.max_number || 0) + 1;

  await env.DB.prepare(
    `UPDATE feedback_source_counter
     SET next_number = CASE
       WHEN next_number < ? THEN ?
       ELSE next_number
     END
     WHERE source_key = 'beta'`
  )
    .bind(nextBeta, nextBeta)
    .run();

  const missing = await env.DB.prepare(
    `SELECT
       f.id,
       f.description,
       f.steps,
       f.source,
       t.report_number
     FROM feedback f
     JOIN feedback_tracking t ON t.feedback_id = f.id
     LEFT JOIN feedback_v2_meta m ON m.feedback_id = f.id
     WHERE m.feedback_id IS NULL
     ORDER BY f.created_at ASC, f.id ASC
     LIMIT 500`
  ).all();

  for (const row of missing.results || []) {
    const sourceKey = row.source === "testflight" ? "tf" : "beta";
    const sourceNumber = sourceKey === "beta"
      ? Number(row.report_number)
      : await nextSourceNumber(env, "tf");

    const originalDescription = clean(row.description, 5000);
    const originalSteps = clean(row.steps, 5000);
    const now = new Date().toISOString();

    await env.DB.prepare(
      `INSERT OR IGNORE INTO feedback_v2_meta (
        feedback_id,
        source_key,
        source_number,
        original_description,
        original_steps,
        description_state,
        steps_state,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        row.id,
        sourceKey,
        sourceNumber,
        originalDescription || null,
        originalSteps || null,
        originalDescription ? "provided" : "missing",
        originalSteps ? "provided" : "missing",
        now
      )
      .run();
  }
}

function cleanDiagnostics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const output = {};

  for (const [key, raw] of Object.entries(value)) {
    if (!diagnosticKeys.has(key)) continue;
    const safe = clean(String(raw ?? ""), 160);
    if (safe) output[key] = safe;
  }

  return Object.keys(output).length ? output : null;
}


function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

async function verifyAppleWebhookSignature(rawBody, signatureHeader, secret) {
  const expectedSecret = clean(secret, 1024);
  if (!expectedSecret || !signatureHeader) return false;

  const normalizedHeader = String(signatureHeader).trim().toLowerCase();
  const prefix = "hmacsha256=";
  if (!normalizedHeader.startsWith(prefix)) return false;

  const supplied = normalizedHeader.slice(prefix.length);
  if (!/^[0-9a-f]{64}$/.test(supplied)) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(expectedSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody)
  );

  return constantTimeEqual(
    bytesToHex(new Uint8Array(digest)),
    supplied
  );
}

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlEncodeText(value) {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function pemToBytes(value) {
  const normalized = String(value || "")
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");

  if (!normalized) throw new Error("Missing App Store Connect private key");

  const binary = atob(normalized);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function createAppStoreConnectToken(env) {
  const keyId = clean(env.APP_STORE_API_KEY_ID, 128);
  const privateKey = String(env.APP_STORE_API_PRIVATE_KEY || "");
  const issuerId = clean(env.APP_STORE_API_ISSUER_ID, 160);

  if (!keyId || !privateKey) {
    throw new Error("App Store Connect API credentials are incomplete");
  }

  const header = {
    alg: "ES256",
    kid: keyId,
    typ: "JWT"
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = issuerId
    ? {
        iss: issuerId,
        iat: now,
        exp: now + 120,
        aud: "appstoreconnect-v1"
      }
    : {
        sub: "user",
        iat: now,
        exp: now + 120,
        aud: "appstoreconnect-v1"
      };

  const signingInput =
    base64UrlEncodeText(JSON.stringify(header)) +
    "." +
    base64UrlEncodeText(JSON.stringify(payload));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToBytes(privateKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput)
  );

  return signingInput + "." + base64UrlEncodeBytes(new Uint8Array(signature));
}

async function fetchAppStoreConnectJson(env, path) {
  const token = await createAppStoreConnectToken(env);
  const response = await fetch(
    "https://api.appstoreconnect.apple.com" + path,
    {
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json"
      }
    }
  );

  const text = await response.text();
  let body = null;

  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(
      "App Store Connect API failed with HTTP " + response.status
    );
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

function includedResource(payload, type) {
  return (payload?.included || []).find(item => item?.type === type) || null;
}

function testFlightPrivateMetadata(attributes, tester) {
  return {
    testerEmail: clean(
      tester?.attributes?.email || attributes?.email,
      320
    ) || null,
    testerFirstName: clean(tester?.attributes?.firstName, 160) || null,
    testerLastName: clean(tester?.attributes?.lastName, 160) || null,
    locale: clean(attributes?.locale, 80) || null,
    timeZone: clean(attributes?.timeZone, 80) || null,
    architecture: clean(attributes?.architecture, 80) || null,
    connectionType: clean(attributes?.connectionType, 80) || null,
    batteryPercentage:
      Number.isFinite(Number(attributes?.batteryPercentage))
        ? Number(attributes.batteryPercentage)
        : null,
    deviceFamily: clean(attributes?.deviceFamily, 80) || null,
    appPlatform: clean(attributes?.appPlatform, 80) || null
  };
}

async function persistTestFlightScreenshot(env, feedbackId, screenshot, index) {
  const remoteUrl = clean(screenshot?.url, 4000);
  const expiresAt = clean(screenshot?.expirationDate, 80) || null;
  const width = Number.isFinite(Number(screenshot?.width))
    ? Number(screenshot.width)
    : null;
  const height = Number.isFinite(Number(screenshot?.height))
    ? Number(screenshot.height)
    : null;

  let storageKey = null;
  let mimeType = "image/*";
  let byteSize = null;

  if (remoteUrl && env.FEEDBACK_MEDIA?.put) {
    try {
      const response = await fetch(remoteUrl);

      if (response.ok && response.body) {
        const contentType = clean(
          response.headers.get("Content-Type"),
          160
        );
        const contentLength = Number(
          response.headers.get("Content-Length")
        );

        mimeType = contentType || mimeType;
        byteSize = Number.isFinite(contentLength) && contentLength >= 0
          ? contentLength
          : null;

        const extension =
          mimeType.includes("png") ? "png" :
          mimeType.includes("webp") ? "webp" :
          "jpg";

        storageKey =
          "testflight/" +
          feedbackId +
          "/" +
          crypto.randomUUID() +
          "." +
          extension;

        await env.FEEDBACK_MEDIA.put(
          storageKey,
          response.body,
          {
            httpMetadata: {
              contentType: mimeType
            },
            customMetadata: {
              feedbackId,
              source: "testflight"
            }
          }
        );
      }
    } catch (error) {
      console.error("Unable to persist TestFlight screenshot", error);
    }
  }

  return {
    id: crypto.randomUUID(),
    storageKey,
    mimeType,
    originalFilename: "testflight-" + String(index + 1),
    byteSize,
    remoteUrl: remoteUrl || null,
    expiresAt,
    width,
    height
  };
}

async function insertTestFlightFeedback(env, resourceType, resourceId, eventType) {
  await ensureTrackingRows(env);

  const existing = await env.DB.prepare(
    `SELECT feedback_id
     FROM feedback_v2_meta
     WHERE source_key = 'tf'
       AND external_resource_id = ?
     LIMIT 1`
  )
    .bind(resourceId)
    .first();

  if (existing?.feedback_id) {
    return { created: false, feedbackId: existing.feedback_id };
  }

  const isCrash = resourceType === "betaFeedbackCrashSubmissions";
  const path = isCrash
    ? "/v1/betaFeedbackCrashSubmissions/" + encodeURIComponent(resourceId) +
      "?include=build,tester"
    : "/v1/betaFeedbackScreenshotSubmissions/" + encodeURIComponent(resourceId) +
      "?include=build,tester";

  const payload = await fetchAppStoreConnectJson(env, path);
  const data = payload?.data;
  const attributes = data?.attributes || {};

  if (!data?.id) {
    throw new Error("App Store Connect feedback payload missing data");
  }

  const build = includedResource(payload, "builds");
  const tester = includedResource(payload, "betaTesters");
  const description = clean(attributes.comment, 5000);
  const createdAt =
    clean(attributes.createdDate, 80) || new Date().toISOString();

  let appVersion = "";
  const buildNumber = clean(build?.attributes?.version, 80);

  if (build?.id) {
    try {
      const preRelease = await fetchAppStoreConnectJson(
        env,
        "/v1/builds/" +
          encodeURIComponent(build.id) +
          "/preReleaseVersion?fields%5BpreReleaseVersions%5D=version"
      );
      appVersion = clean(
        preRelease?.data?.attributes?.version,
        40
      );
    } catch (error) {
      console.error("Unable to resolve TestFlight app version", error);
    }
  }

  const iosVersion = clean(attributes.osVersion, 80);
  const deviceModel = clean(attributes.deviceModel, 120);
  const hiddenLegacyNumber = await nextReportNumber(env);
  const sourceNumber = await nextSourceNumber(env, "tf");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const privateMetadata = testFlightPrivateMetadata(attributes, tester);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO feedback (
        id,
        created_at,
        status,
        category,
        description,
        steps,
        app_version,
        build_number,
        ios_version,
        device_model,
        source
      )
      VALUES (?, ?, 'new', ?, ?, NULL, ?, ?, ?, ?, 'testflight')`
    ).bind(
      id,
      createdAt,
      isCrash ? "crash" : "other",
      description,
      appVersion || null,
      buildNumber || null,
      iosVersion || null,
      deviceModel || null
    ),
    env.DB.prepare(
      `INSERT INTO feedback_tracking (
        feedback_id,
        report_number,
        diagnostics_json
      )
      VALUES (?, ?, ?)`
    ).bind(
      id,
      hiddenLegacyNumber,
      JSON.stringify({
        source: "testflight",
        eventType,
        resourceType
      })
    ),
    env.DB.prepare(
      `INSERT INTO feedback_v2_meta (
        feedback_id,
        source_key,
        source_number,
        original_description,
        original_steps,
        edited_description,
        edited_steps,
        description_state,
        steps_state,
        external_resource_id,
        external_event_type,
        private_metadata_json,
        updated_at
      )
      VALUES (?, 'tf', ?, ?, NULL, NULL, NULL, ?, 'missing', ?, ?, ?, ?)`
    ).bind(
      id,
      sourceNumber,
      description || null,
      description ? "provided" : "missing",
      resourceId,
      eventType,
      JSON.stringify(privateMetadata),
      now
    )
  ]);

  const screenshots = Array.isArray(attributes.screenshots)
    ? attributes.screenshots
    : [];

  for (let index = 0; index < screenshots.length; index += 1) {
    const attachment = await persistTestFlightScreenshot(
      env,
      id,
      screenshots[index] || {},
      index
    );

    await env.DB.prepare(
      `INSERT INTO feedback_attachments (
        id,
        feedback_id,
        source,
        storage_key,
        mime_type,
        original_filename,
        byte_size,
        remote_url,
        expires_at,
        width,
        height,
        is_public,
        created_at
      )
      VALUES (?, ?, 'testflight', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    )
      .bind(
        attachment.id,
        id,
        attachment.storageKey,
        attachment.mimeType,
        attachment.originalFilename,
        attachment.byteSize,
        attachment.remoteUrl,
        attachment.expiresAt,
        attachment.width,
        attachment.height,
        now
      )
      .run();
  }

  return {
    created: true,
    feedbackId: id,
    reportId: formatSourceReportId("tf", sourceNumber)
  };
}

async function processAppStoreWebhookEvent(env, eventPayload) {
  const data = eventPayload?.data || {};
  const eventId = clean(data.id, 160);
  const eventType = clean(data.type, 160);
  const instance = data?.relationships?.instance?.data || {};
  const resourceType = clean(instance.type, 160);
  const resourceId = clean(instance.id, 240);
  const receivedAt = new Date().toISOString();

  if (!eventId) {
    throw new Error("Webhook event is missing an id");
  }

  await ensureFeedbackV2Schema(env);

  const alreadySeen = await env.DB.prepare(
    `SELECT event_id, processed_at
     FROM feedback_ingest_events
     WHERE event_id = ?
     LIMIT 1`
  )
    .bind(eventId)
    .first();

  if (alreadySeen?.processed_at) {
    return { duplicate: true };
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO feedback_ingest_events (
      event_id,
      provider,
      event_type,
      resource_id,
      feedback_id,
      received_at,
      processed_at,
      payload_json
    )
    VALUES (?, 'appstore', ?, ?, NULL, ?, NULL, ?)`
  )
    .bind(
      eventId,
      eventType || null,
      resourceId || null,
      receivedAt,
      JSON.stringify(eventPayload)
    )
    .run();

  const supported =
    (
      eventType === "betaFeedbackScreenshotSubmissionCreated" &&
      resourceType === "betaFeedbackScreenshotSubmissions"
    ) ||
    (
      eventType === "betaFeedbackCrashSubmissionCreated" &&
      resourceType === "betaFeedbackCrashSubmissions"
    );

  if (!supported || !resourceId) {
    await env.DB.prepare(
      `UPDATE feedback_ingest_events
       SET processed_at = ?
       WHERE event_id = ?`
    )
      .bind(new Date().toISOString(), eventId)
      .run();

    return { ignored: true, eventType };
  }

  const ingested = await insertTestFlightFeedback(
    env,
    resourceType,
    resourceId,
    eventType
  );

  await env.DB.prepare(
    `UPDATE feedback_ingest_events
     SET feedback_id = ?, processed_at = ?
     WHERE event_id = ?`
  )
    .bind(
      ingested.feedbackId || null,
      new Date().toISOString(),
      eventId
    )
    .run();

  return ingested;
}

async function ensureAppReleaseSchema(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS app_release_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      latest_version TEXT NOT NULL,
      latest_build INTEGER NOT NULL CHECK (latest_build >= 1),
      updated_at TEXT NOT NULL
    )`
  ).run();

  await env.DB.prepare(
    `INSERT OR IGNORE INTO app_release_state
     (singleton, latest_version, latest_build, updated_at)
     VALUES (1, ?, ?, ?)`
  )
    .bind("1.2.5", 45, new Date().toISOString())
    .run();
}

async function ensureTrackingSchema(env) {
  await env.DB.batch([
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS feedback_tracking (
        feedback_id TEXT PRIMARY KEY,
        report_number INTEGER NOT NULL UNIQUE,
        eta_seconds INTEGER,
        eta_due_at TEXT,
        fix_published INTEGER NOT NULL DEFAULT 0,
        unable_reason TEXT,
        diagnostics_json TEXT,
        deleted_at TEXT,
        deletion_reason TEXT
      )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS feedback_counter (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        next_number INTEGER NOT NULL CHECK (next_number >= 1)
      )`
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO feedback_counter (singleton, next_number)
       VALUES (1, 1)`
    )
  ]);
}

async function nextReportNumber(env) {
  const row = await env.DB.prepare(
    `UPDATE feedback_counter
     SET next_number = next_number + 1
     WHERE singleton = 1
     RETURNING next_number - 1 AS report_number`
  ).first();

  if (!row?.report_number) {
    throw new Error("Unable to allocate report number");
  }

  return Number(row.report_number);
}

async function ensureTrackingRows(env) {
  await ensureTrackingSchema(env);

  const missing = await env.DB.prepare(
    `SELECT f.id
     FROM feedback f
     LEFT JOIN feedback_tracking t ON t.feedback_id = f.id
     WHERE t.feedback_id IS NULL
     ORDER BY f.created_at ASC, f.id ASC
     LIMIT 500`
  ).all();

  for (const row of missing.results || []) {
    const number = await nextReportNumber(env);

    await env.DB.prepare(
      `INSERT OR IGNORE INTO feedback_tracking
       (feedback_id, report_number)
       VALUES (?, ?)`
    )
      .bind(row.id, number)
      .run();
  }

  await ensureFeedbackV2Rows(env);
}

function etaFromBody(body) {
  if (!Object.hasOwn(body, "etaSeconds")) return undefined;

  const parsed = Number(body.etaSeconds);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return Math.min(Math.floor(parsed), 60 * 60 * 24 * 365);
}

async function loadPublicAttachmentRefs(env, feedbackIds) {
  const ids = Array.from(new Set(
    (feedbackIds || []).filter(Boolean).map(String)
  ));

  const output = new Map();
  if (!ids.length) return output;

  const placeholders = ids.map(() => "?").join(",");
  const result = await env.DB.prepare(
    `SELECT id, feedback_id
     FROM feedback_attachments
     WHERE feedback_id IN (${placeholders})
       AND is_public = 1
       AND public_storage_key IS NOT NULL
     ORDER BY created_at ASC, id ASC`
  )
    .bind(...ids)
    .all();

  for (const row of result.results || []) {
    const list = output.get(row.feedback_id) || [];
    list.push({
      id: row.id,
      url:
        "/api/public-feedback/attachment?id=" +
        encodeURIComponent(row.id)
    });
    output.set(row.feedback_id, list);
  }

  return output;
}

async function handleDashboardApi(request, env, url) {
  await ensureTrackingRows(env);

  if (
    url.pathname === "/dashboard/api/feedback" &&
    request.method === "GET"
  ) {
    const list = await env.DB.prepare(
      `SELECT
         f.id,
         f.created_at,
         f.status,
         f.category,
         f.description,
         f.steps,
         f.app_version,
         f.build_number,
         f.ios_version,
         f.device_model,
         f.source,
         f.is_public,
         f.public_title,
         f.public_note,
         f.fixed_version,
         f.fixed_build,
         f.updated_at,
         t.report_number,
         t.eta_seconds,
         t.eta_due_at,
         t.fix_published,
         t.unable_reason,
         t.diagnostics_json,
         t.deleted_at,
         t.deletion_reason,
         m.source_key,
         m.source_number,
         m.original_description,
         m.original_steps,
         m.edited_description,
         m.edited_steps,
         m.description_state,
         m.steps_state,
         m.external_resource_id,
         m.external_event_type,
         m.private_metadata_json,
         (
           SELECT COUNT(*)
           FROM feedback_attachments a
           WHERE a.feedback_id = f.id
         ) AS attachment_count
       FROM feedback f
       JOIN feedback_tracking t ON t.feedback_id = f.id
       LEFT JOIN feedback_v2_meta m ON m.feedback_id = f.id
       ORDER BY COALESCE(t.deleted_at, f.created_at) DESC
       LIMIT 500`
    ).all();

    const counts = {
      new: 0,
      in_progress: 0,
      resolved: 0,
      closed: 0,
      deleted: 0
    };

    for (const item of list.results || []) {
      if (item.deleted_at) {
        counts.deleted += 1;
      } else if (Object.hasOwn(counts, item.status)) {
        counts[item.status] += 1;
      }
    }

    return json({
      ok: true,
      feedback: list.results || [],
      counts
    });
  }

  if (
    url.pathname === "/dashboard/api/feedback" &&
    request.method === "PATCH"
  ) {
    const origin = request.headers.get("Origin");

    if (origin && origin !== url.origin) {
      return json({ ok: false, error: "Invalid origin" }, 403);
    }

    if (!(request.headers.get("Content-Type") || "").includes("application/json")) {
      return json({ ok: false, error: "JSON required" }, 415);
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "Invalid JSON" }, 400);
    }

    const id = clean(body.id, 80);

    if (!id) {
      return json({ ok: false, error: "Missing feedback id" }, 400);
    }

    const status = Object.hasOwn(body, "status")
      ? clean(body.status, 20)
      : null;

    if (status && !allowedStatuses.has(status)) {
      return json({ ok: false, error: "Invalid status" }, 400);
    }

    const isPublic =
      body.isPublic === true ||
      body.isPublic === 1 ||
      body.isPublic === "1";

    const publicTitle = clean(body.publicTitle, 180);
    const publicNote = clean(body.publicNote, 2000);
    const fixedVersion = clean(body.fixedVersion, 80);
    const fixedBuild = clean(body.fixedBuild, 80);
    const unableReason = clean(body.unableReason, 1200);
    const etaSeconds = etaFromBody(body);
    const fixPublished =
      body.fixPublished === true ||
      body.fixPublished === 1 ||
      body.fixPublished === "1";

    if (isPublic && publicTitle.length < 3) {
      return json(
        { ok: false, error: "Public title is required" },
        400
      );
    }

    if (etaSeconds === null) {
      return json({ ok: false, error: "Invalid ETA" }, 400);
    }

    const now = new Date();
    const dueAt =
      status === "in_progress" &&
      typeof etaSeconds === "number" &&
      etaSeconds > 0
        ? new Date(now.getTime() + etaSeconds * 1000).toISOString()
        : null;

    const feedbackUpdates = [
      "is_public = ?",
      "public_title = ?",
      "public_note = ?",
      "fixed_version = ?",
      "fixed_build = ?",
      "updated_at = ?"
    ];

    const feedbackValues = [
      isPublic ? 1 : 0,
      publicTitle || null,
      publicNote || null,
      fixedVersion || null,
      fixedBuild || null,
      now.toISOString()
    ];

    if (status) {
      feedbackUpdates.unshift("status = ?");
      feedbackValues.unshift(status);
    }

    feedbackValues.push(id);

    const trackingUpdates = [
      "fix_published = ?",
      "unable_reason = ?"
    ];

    const trackingValues = [
      fixPublished ? 1 : 0,
      status === "closed" ? (unableReason || null) : null
    ];

    if (status === "in_progress") {
      trackingUpdates.push("eta_seconds = ?", "eta_due_at = ?");
      trackingValues.push(
        typeof etaSeconds === "number" && etaSeconds > 0
          ? etaSeconds
          : null,
        dueAt
      );
    } else if (status) {
      trackingUpdates.push("eta_seconds = NULL", "eta_due_at = NULL");
    }

    trackingValues.push(id);

    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE feedback
         SET ${feedbackUpdates.join(", ")}
         WHERE id = ?
           AND EXISTS (
             SELECT 1
             FROM feedback_tracking t
             WHERE t.feedback_id = feedback.id
               AND t.deleted_at IS NULL
           )`
      ).bind(...feedbackValues),
      env.DB.prepare(
        `UPDATE feedback_tracking
         SET ${trackingUpdates.join(", ")}
         WHERE feedback_id = ?
           AND deleted_at IS NULL`
      ).bind(...trackingValues)
    ]);

    const changed =
      results.some(result => Number(result.meta?.changes || 0) > 0);

    if (!changed) {
      return json({ ok: false, error: "Feedback not found" }, 404);
    }

    return json({ ok: true });
  }

  if (
    url.pathname === "/dashboard/api/feedback/attachments" &&
    request.method === "GET"
  ) {
    const feedbackId = clean(url.searchParams.get("feedbackId"), 80);

    if (!feedbackId) {
      return json({ ok: false, error: "Missing feedback id" }, 400);
    }

    const result = await env.DB.prepare(
      `SELECT
         id,
         source,
         mime_type,
         original_filename,
         byte_size,
         expires_at,
         width,
         height,
         public_storage_key,
         public_mime_type,
         public_byte_size,
         public_updated_at,
         is_public,
         created_at,
         storage_key,
         remote_url
       FROM feedback_attachments
       WHERE feedback_id = ?
       ORDER BY created_at ASC, id ASC`
    )
      .bind(feedbackId)
      .all();

    return json({
      ok: true,
      attachments: (result.results || []).map(item => ({
        id: item.id,
        source: item.source,
        mime_type: item.mime_type,
        original_filename: item.original_filename,
        byte_size: item.byte_size,
        expires_at: item.expires_at,
        width: item.width,
        height: item.height,
        is_public: item.is_public,
        public_ready: Boolean(item.public_storage_key),
        public_mime_type: item.public_mime_type,
        public_byte_size: item.public_byte_size,
        public_updated_at: item.public_updated_at,
        created_at: item.created_at,
        available:
          Boolean(item.storage_key) ||
          Boolean(item.remote_url),
        url:
          "/dashboard/api/feedback/attachment?id=" +
          encodeURIComponent(item.id)
      }))
    });
  }

  if (
    url.pathname === "/dashboard/api/feedback/attachment" &&
    request.method === "GET"
  ) {
    const attachmentId = clean(url.searchParams.get("id"), 100);

    if (!attachmentId) {
      return new Response("Missing attachment id", { status: 400 });
    }

    const variant = clean(url.searchParams.get("variant"), 20);

    const item = await env.DB.prepare(
      `SELECT
         storage_key,
         remote_url,
         expires_at,
         mime_type,
         public_storage_key,
         public_mime_type
       FROM feedback_attachments
       WHERE id = ?
       LIMIT 1`
    )
      .bind(attachmentId)
      .first();

    if (!item) {
      return new Response("Not found", { status: 404 });
    }

    if (variant === "public") {
      if (!item.public_storage_key || !env.FEEDBACK_MEDIA?.get) {
        return new Response("Public derivative unavailable", { status: 404 });
      }

      const publicObject = await env.FEEDBACK_MEDIA.get(item.public_storage_key);

      if (!publicObject) {
        return new Response("Public derivative unavailable", { status: 404 });
      }

      const headers = new Headers();
      publicObject.writeHttpMetadata(headers);
      headers.set(
        "Content-Type",
        headers.get("Content-Type") ||
          item.public_mime_type ||
          "image/png"
      );
      headers.set("Cache-Control", "private, no-store");
      headers.set("X-Content-Type-Options", "nosniff");

      return new Response(publicObject.body, {
        status: 200,
        headers
      });
    }

    if (item.storage_key && env.FEEDBACK_MEDIA?.get) {
      const object = await env.FEEDBACK_MEDIA.get(item.storage_key);

      if (object) {
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set(
          "Content-Type",
          headers.get("Content-Type") ||
            item.mime_type ||
            "application/octet-stream"
        );
        headers.set("Cache-Control", "private, no-store");
        headers.set("X-Content-Type-Options", "nosniff");

        return new Response(object.body, {
          status: 200,
          headers
        });
      }
    }

    const expiresAt = item.expires_at
      ? new Date(item.expires_at).getTime()
      : null;

    if (
      item.remote_url &&
      (!Number.isFinite(expiresAt) || expiresAt > Date.now())
    ) {
      try {
        const response = await fetch(item.remote_url);

        if (response.ok) {
          const headers = new Headers();
          headers.set(
            "Content-Type",
            response.headers.get("Content-Type") ||
              item.mime_type ||
              "application/octet-stream"
          );
          headers.set("Cache-Control", "private, no-store");
          headers.set("X-Content-Type-Options", "nosniff");

          return new Response(response.body, {
            status: 200,
            headers
          });
        }
      } catch (error) {
        console.error("Attachment proxy failed", error);
      }
    }

    return new Response("Attachment unavailable", { status: 410 });
  }

  if (
    url.pathname === "/dashboard/api/feedback/attachment/public"
  ) {
    const origin = request.headers.get("Origin");

    if (origin && origin !== url.origin) {
      return json({ ok: false, error: "Invalid origin" }, 403);
    }

    const attachmentId = clean(url.searchParams.get("id"), 100);

    if (!attachmentId) {
      return json({ ok: false, error: "Missing attachment id" }, 400);
    }

    await ensureFeedbackV2Schema(env);

    const item = await env.DB.prepare(
      `SELECT
         a.id,
         a.feedback_id,
         a.public_storage_key,
         t.deleted_at
       FROM feedback_attachments a
       JOIN feedback_tracking t ON t.feedback_id = a.feedback_id
       WHERE a.id = ?
       LIMIT 1`
    )
      .bind(attachmentId)
      .first();

    if (!item) {
      return json({ ok: false, error: "Attachment not found" }, 404);
    }

    if (item.deleted_at) {
      return json({ ok: false, error: "Feedback is deleted" }, 409);
    }

    if (request.method === "PUT") {
      if (!env.FEEDBACK_MEDIA?.put) {
        return json({ ok: false, error: "Media storage unavailable" }, 503);
      }

      const contentType = clean(
        request.headers.get("Content-Type"),
        160
      ).toLowerCase();

      const allowedImageTypes = new Set([
        "image/png",
        "image/jpeg",
        "image/webp"
      ]);

      if (!allowedImageTypes.has(contentType)) {
        return json({ ok: false, error: "Unsupported image type" }, 415);
      }

      const body = await request.arrayBuffer();

      if (!body.byteLength) {
        return json({ ok: false, error: "Empty image" }, 400);
      }

      if (body.byteLength > 15 * 1024 * 1024) {
        return json({ ok: false, error: "Image too large" }, 413);
      }

      const extension =
        contentType === "image/png"
          ? "png"
          : (contentType === "image/webp" ? "webp" : "jpg");

      const storageKey =
        "public/" +
        item.feedback_id +
        "/" +
        attachmentId +
        "-" +
        crypto.randomUUID() +
        "." +
        extension;

      await env.FEEDBACK_MEDIA.put(
        storageKey,
        body,
        {
          httpMetadata: {
            contentType
          },
          customMetadata: {
            feedbackId: item.feedback_id,
            attachmentId,
            variant: "public-flat"
          }
        }
      );

      const oldKey = clean(item.public_storage_key, 1000);
      const now = new Date().toISOString();

      await env.DB.prepare(
        `UPDATE feedback_attachments
         SET public_storage_key = ?,
             public_mime_type = ?,
             public_byte_size = ?,
             public_updated_at = ?,
             is_public = 1
         WHERE id = ?`
      )
        .bind(
          storageKey,
          contentType,
          body.byteLength,
          now,
          attachmentId
        )
        .run();

      if (oldKey && oldKey !== storageKey && env.FEEDBACK_MEDIA?.delete) {
        try {
          await env.FEEDBACK_MEDIA.delete(oldKey);
        } catch (error) {
          console.error("Unable to remove old public derivative", error);
        }
      }

      return json({
        ok: true,
        isPublic: true,
        publicReady: true,
        updatedAt: now
      });
    }

    if (request.method === "DELETE") {
      await env.DB.prepare(
        `UPDATE feedback_attachments
         SET is_public = 0
         WHERE id = ?`
      )
        .bind(attachmentId)
        .run();

      return json({
        ok: true,
        isPublic: false,
        publicReady: Boolean(item.public_storage_key)
      });
    }

    if (request.method === "PATCH") {
      if (!item.public_storage_key) {
        return json(
          { ok: false, error: "Public derivative required" },
          409
        );
      }

      await env.DB.prepare(
        `UPDATE feedback_attachments
         SET is_public = 1
         WHERE id = ?`
      )
        .bind(attachmentId)
        .run();

      return json({
        ok: true,
        isPublic: true,
        publicReady: true
      });
    }

    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  if (
    url.pathname === "/dashboard/api/feedback/content" &&
    request.method === "PATCH"
  ) {
    const origin = request.headers.get("Origin");

    if (origin && origin !== url.origin) {
      return json({ ok: false, error: "Invalid origin" }, 403);
    }

    if (!(request.headers.get("Content-Type") || "").includes("application/json")) {
      return json({ ok: false, error: "JSON required" }, 415);
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "Invalid JSON" }, 400);
    }

    const id = clean(body.id, 80);
    const description = clean(body.description, 5000);
    const steps = clean(body.steps, 5000);
    const descriptionState = clean(body.descriptionState, 30) ||
      (description ? "provided" : "missing");
    const stepsState = clean(body.stepsState, 30) ||
      (steps ? "provided" : "missing");

    if (!id) {
      return json({ ok: false, error: "Missing feedback id" }, 400);
    }

    if (
      !feedbackFieldStates.has(descriptionState) ||
      !feedbackFieldStates.has(stepsState)
    ) {
      return json({ ok: false, error: "Invalid field state" }, 400);
    }

    if (descriptionState === "provided" && !description) {
      return json({ ok: false, error: "Description marked provided but empty" }, 400);
    }

    if (stepsState === "provided" && !steps) {
      return json({ ok: false, error: "Steps marked provided but empty" }, 400);
    }

    const now = new Date().toISOString();

    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE feedback
         SET description = ?, steps = ?, updated_at = ?
         WHERE id = ?
           AND EXISTS (
             SELECT 1
             FROM feedback_tracking t
             WHERE t.feedback_id = feedback.id
               AND t.deleted_at IS NULL
           )`
      ).bind(
        descriptionState === "provided" ? description : "",
        stepsState === "provided" ? steps : null,
        now,
        id
      ),
      env.DB.prepare(
        `UPDATE feedback_v2_meta
         SET edited_description = ?,
             edited_steps = ?,
             description_state = ?,
             steps_state = ?,
             updated_at = ?
         WHERE feedback_id = ?`
      ).bind(
        descriptionState === "provided" ? description : null,
        stepsState === "provided" ? steps : null,
        descriptionState,
        stepsState,
        now,
        id
      )
    ]);

    const changed = results.some(
      result => Number(result.meta?.changes || 0) > 0
    );

    if (!changed) {
      return json({ ok: false, error: "Feedback not found" }, 404);
    }

    return json({ ok: true });
  }

  if (
    url.pathname === "/dashboard/api/feedback" &&
    request.method === "DELETE"
  ) {
    const origin = request.headers.get("Origin");

    if (origin && origin !== url.origin) {
      return json({ ok: false, error: "Invalid origin" }, 403);
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "Invalid JSON" }, 400);
    }

    const id = clean(body.id, 80);
    const reason = clean(body.deletionReason, 500);

    if (!id) {
      return json({ ok: false, error: "Missing feedback id" }, 400);
    }

    const existing = await env.DB.prepare(
      `SELECT
         f.id,
         f.description,
         f.source,
         t.deleted_at
       FROM feedback f
       JOIN feedback_tracking t ON t.feedback_id = f.id
       WHERE f.id = ?
       LIMIT 1`
    ).bind(id).first();

    if (!existing) {
      return json({ ok: false, error: "Feedback not found" }, 404);
    }

    if (existing.deleted_at) {
      return json({ ok: true });
    }

    const now = new Date().toISOString();

    const result = await env.DB.prepare(
      `UPDATE feedback_tracking
       SET deleted_at = ?, deletion_reason = ?
       WHERE feedback_id = ?`
    )
      .bind(now, reason || null, id)
      .run();

    if (Number(result.meta?.changes || 0) < 1) {
      return json({ ok: false, error: "Feedback not found" }, 404);
    }

    return json({ ok: true });
  }

  if (
    url.pathname === "/dashboard/api/feedback/restore" &&
    request.method === "POST"
  ) {
    const origin = request.headers.get("Origin");

    if (origin && origin !== url.origin) {
      return json({ ok: false, error: "Invalid origin" }, 403);
    }

    if (!(request.headers.get("Content-Type") || "").includes("application/json")) {
      return json({ ok: false, error: "JSON required" }, 415);
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "Invalid JSON" }, 400);
    }

    const id = clean(body.id, 80);

    if (!id) {
      return json({ ok: false, error: "Missing feedback id" }, 400);
    }

    const existing = await env.DB.prepare(
      `SELECT
         f.description,
         f.source,
         t.deleted_at
       FROM feedback f
       JOIN feedback_tracking t ON t.feedback_id = f.id
       WHERE f.id = ?
       LIMIT 1`
    ).bind(id).first();

    if (!existing) {
      return json({ ok: false, error: "Feedback not found" }, 404);
    }

    if (!existing.deleted_at) {
      return json({ ok: true });
    }

    // Older versions physically scrubbed the feedback row when deleting it.
    // Those tombstones remain visible, but their original content cannot be
    // reconstructed safely.
    const legacyScrubbed =
      !clean(existing.description, 5000) ||
      clean(existing.source, 40) === "deleted";

    if (legacyScrubbed) {
      return json(
        {
          ok: false,
          error: "legacy_deleted_content_unavailable"
        },
        409
      );
    }

    const result = await env.DB.prepare(
      `UPDATE feedback_tracking
       SET deleted_at = NULL, deletion_reason = NULL
       WHERE feedback_id = ?`
    )
      .bind(id)
      .run();

    if (Number(result.meta?.changes || 0) < 1) {
      return json({ ok: false, error: "Feedback not found" }, 404);
    }

    return json({ ok: true });
  }

  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (isDashboardRequest(url)) {
      if (
        url.hostname !== dashboardHost ||
        !hasAccessIdentity(request)
      ) {
        return new Response("Not found", {
          status: 404,
          headers: {
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff"
          }
        });
      }

      const apiResponse = await handleDashboardApi(
        request,
        env,
        url
      );

      if (apiResponse) return apiResponse;

      const assetResponse = await env.ASSETS.fetch(request);
      const headers = new Headers(assetResponse.headers);

      headers.set("Cache-Control", "no-store");
      headers.set("X-Frame-Options", "DENY");
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Referrer-Policy", "no-referrer");

      return new Response(assetResponse.body, {
        status: assetResponse.status,
        statusText: assetResponse.statusText,
        headers
      });
    }

    if (
      url.pathname === "/api/webhooks/appstore" &&
      request.method === "POST"
    ) {
      const rawBody = await request.text();
      const signature = request.headers.get("x-apple-signature");
      const valid = await verifyAppleWebhookSignature(
        rawBody,
        signature,
        env.APP_STORE_WEBHOOK_SECRET
      );

      if (!valid) {
        return json({ ok: false, error: "Invalid signature" }, 401);
      }

      let body;

      try {
        body = JSON.parse(rawBody);
      } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400);
      }

      // Apple webhook pings and future event types should still receive a 2xx
      // after signature verification. Supported TestFlight feedback events are
      // processed asynchronously so Apple doesn't need to wait on ASC API I/O.
      const work = processAppStoreWebhookEvent(env, body)
        .catch(error => {
          console.error("App Store webhook processing failed", error);
        });

      if (ctx?.waitUntil) {
        ctx.waitUntil(work);
      } else {
        await work;
      }

      return json({ ok: true }, 202);
    }

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        service: "ChaiPhoto Web",
        database: Boolean(env.DB),
        timestamp: new Date().toISOString()
      });
    }

    if (
      url.pathname === "/api/app-version" &&
      request.method === "GET"
    ) {
      await ensureAppReleaseSchema(env);

      const release = await env.DB.prepare(
        `SELECT latest_version, latest_build, updated_at
         FROM app_release_state
         WHERE singleton = 1
         LIMIT 1`
      ).first();

      return json({
        ok: true,
        latestVersion: clean(release?.latest_version, 40),
        latestBuild: Number(release?.latest_build || 0),
        updatedAt: release?.updated_at || null
      });
    }

    if (
      url.pathname === "/api/internal/update-version" &&
      request.method === "POST"
    ) {
      const expectedToken = clean(env.UPDATE_VERSION_TOKEN, 512);

      if (!expectedToken) {
        return json({ ok: false, error: "Version updater unavailable" }, 503);
      }

      const authorization = request.headers.get("Authorization") || "";

      if (authorization !== `Bearer ${expectedToken}`) {
        return json({ ok: false, error: "Unauthorized" }, 401);
      }

      if (!(request.headers.get("Content-Type") || "").includes("application/json")) {
        return json({ ok: false, error: "JSON required" }, 415);
      }

      let body;

      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400);
      }

      const latestVersion = clean(body.latestVersion, 40);
      const latestBuild = Number(body.latestBuild);

      if (
        !latestVersion ||
        !Number.isSafeInteger(latestBuild) ||
        latestBuild < 1
      ) {
        return json({ ok: false, error: "Invalid release version" }, 400);
      }

      await ensureAppReleaseSchema(env);

      const current = await env.DB.prepare(
        `SELECT latest_build
         FROM app_release_state
         WHERE singleton = 1
         LIMIT 1`
      ).first();

      const currentBuild = Number(current?.latest_build || 0);

      if (latestBuild < currentBuild) {
        return json({
          ok: true,
          ignored: true,
          reason: "older_build",
          latestBuild: currentBuild
        });
      }

      const updatedAt = new Date().toISOString();

      await env.DB.prepare(
        `UPDATE app_release_state
         SET latest_version = ?, latest_build = ?, updated_at = ?
         WHERE singleton = 1`
      )
        .bind(latestVersion, latestBuild, updatedAt)
        .run();

      return json({
        ok: true,
        latestVersion,
        latestBuild,
        updatedAt
      });
    }

    if (
      url.pathname === "/api/internal/feedback-digest" &&
      request.method === "GET"
    ) {
      const expectedToken = clean(env.FEEDBACK_DIGEST_TOKEN, 512);

      if (!expectedToken) {
        return json({ ok: false, error: "Feedback digest unavailable" }, 503);
      }

      const authorization = request.headers.get("Authorization") || "";

      if (authorization !== `Bearer ${expectedToken}`) {
        return json({ ok: false, error: "Unauthorized" }, 401);
      }

      await ensureTrackingRows(env);

      const list = await env.DB.prepare(
        `SELECT
           f.id AS feedback_id,
           f.created_at,
           f.status,
           f.category,
           f.description,
           f.steps,
           f.app_version,
           f.build_number,
           f.ios_version,
           f.device_model,
           f.source,
           f.updated_at,
           t.report_number
         FROM feedback f
         JOIN feedback_tracking t ON t.feedback_id = f.id
         WHERE t.deleted_at IS NULL
         ORDER BY f.created_at DESC
         LIMIT 500`
      ).all();

      const counts = {
        new: 0,
        in_progress: 0,
        resolved: 0,
        closed: 0
      };

      for (const item of list.results || []) {
        if (Object.hasOwn(counts, item.status)) {
          counts[item.status] += 1;
        }
      }

      return json({
        ok: true,
        generatedAt: new Date().toISOString(),
        counts,
        feedback: list.results || []
      });
    }

    if (
      url.pathname === "/api/feedback-lookup-v2" &&
      request.method === "GET"
    ) {
      await ensureTrackingRows(env);

      const parsed = parseReportReference(
        url.searchParams.get("id")
      );

      if (!parsed) {
        return json({ ok: false, error: "Invalid report id" }, 400);
      }

      const baseSql =
        `SELECT
           f.id AS feedback_id,
           f.created_at,
           f.status,
           f.category,
           f.is_public,
           f.public_title,
           f.public_note,
           f.fixed_version,
           f.fixed_build,
           f.app_version,
           f.build_number,
           f.ios_version,
           f.device_model,
           f.updated_at,
           t.eta_seconds,
           t.eta_due_at,
           t.fix_published,
           t.unable_reason,
           t.deleted_at,
           m.source_key,
           m.source_number,
           m.description_state,
           m.steps_state
         FROM feedback f
         JOIN feedback_tracking t ON t.feedback_id = f.id
         JOIN feedback_v2_meta m ON m.feedback_id = f.id`;

      const result = parsed.sourceKey
        ? await env.DB.prepare(
            baseSql +
            " WHERE m.source_key = ? AND m.source_number = ? LIMIT 2"
          )
            .bind(parsed.sourceKey, parsed.number)
            .all()
        : await env.DB.prepare(
            baseSql +
            " WHERE m.source_number = ? ORDER BY m.source_key ASC LIMIT 4"
          )
            .bind(parsed.number)
            .all();

      const rows = result.results || [];
      const attachmentMap = await loadPublicAttachmentRefs(
        env,
        rows
          .filter(item => Number(item.is_public) === 1)
          .map(item => item.feedback_id)
      );

      const matches = rows.map(item => ({
        report_id: formatSourceReportId(item.source_key, item.source_number),
        source: item.source_key,
        created_at: item.created_at,
        status: item.deleted_at ? "deleted" : item.status,
        eta_seconds: item.eta_seconds,
        eta_due_at: item.eta_due_at,
        fixed_version: item.fixed_version,
        fixed_build: item.fixed_build,
        fix_published: item.fix_published,
        unable_reason: item.unable_reason,
        app_version: Number(item.is_public) === 1 ? item.app_version : null,
        build_number: Number(item.is_public) === 1 ? item.build_number : null,
        ios_version: Number(item.is_public) === 1 ? item.ios_version : null,
        device_model: Number(item.is_public) === 1 ? item.device_model : null,
        public_title: Number(item.is_public) === 1
          ? item.public_title
          : null,
        public_note: Number(item.is_public) === 1
          ? item.public_note
          : null,
        attachments: Number(item.is_public) === 1
          ? (attachmentMap.get(item.feedback_id) || [])
          : [],
        description_state: item.description_state,
        steps_state: item.steps_state
      }));

      return json({
        ok: true,
        ambiguous: !parsed.sourceKey && matches.length > 1,
        matches
      });
    }

    if (
      url.pathname === "/api/public-feedback/attachment" &&
      request.method === "GET"
    ) {
      const attachmentId = clean(url.searchParams.get("id"), 100);

      if (!attachmentId) {
        return new Response("Missing attachment id", { status: 400 });
      }

      await ensureTrackingRows(env);

      const item = await env.DB.prepare(
        `SELECT
           a.public_storage_key,
           a.public_mime_type
         FROM feedback_attachments a
         JOIN feedback f ON f.id = a.feedback_id
         JOIN feedback_tracking t ON t.feedback_id = f.id
         WHERE a.id = ?
           AND a.is_public = 1
           AND a.public_storage_key IS NOT NULL
           AND f.is_public = 1
           AND t.deleted_at IS NULL
         LIMIT 1`
      )
        .bind(attachmentId)
        .first();

      if (!item?.public_storage_key || !env.FEEDBACK_MEDIA?.get) {
        return new Response("Not found", { status: 404 });
      }

      const object = await env.FEEDBACK_MEDIA.get(item.public_storage_key);

      if (!object) {
        return new Response("Not found", { status: 404 });
      }

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set(
        "Content-Type",
        headers.get("Content-Type") ||
          item.public_mime_type ||
          "image/png"
      );
      headers.set("Cache-Control", "public, max-age=3600");
      headers.set("X-Content-Type-Options", "nosniff");

      return new Response(object.body, {
        status: 200,
        headers
      });
    }

    if (
      url.pathname === "/api/public-feedback" &&
      request.method === "GET"
    ) {
      await ensureTrackingRows(env);

      const requestedStatus = clean(
        url.searchParams.get("status"),
        20
      );

      const filter = allowedStatuses.has(requestedStatus)
        ? requestedStatus
        : null;

      const sql =
        `SELECT
           f.id AS feedback_id,
           f.created_at,
           f.status,
           f.category,
           f.public_title,
           f.public_note,
           f.fixed_version,
           f.fixed_build,
           f.app_version,
           f.build_number,
           f.ios_version,
           f.device_model,
           f.updated_at,
           t.eta_seconds,
           t.eta_due_at,
           t.fix_published,
           t.unable_reason,
           m.source_key,
           m.source_number
         FROM feedback f
         JOIN feedback_tracking t ON t.feedback_id = f.id
         JOIN feedback_v2_meta m ON m.feedback_id = f.id
         WHERE f.is_public = 1
           AND t.deleted_at IS NULL` +
        (filter ? " AND f.status = ?" : "") +
        " ORDER BY COALESCE(f.updated_at, f.created_at) DESC LIMIT 200";

      const statement = env.DB.prepare(sql);
      const result = filter
        ? await statement.bind(filter).all()
        : await statement.all();

      const rows = result.results || [];
      const attachmentMap = await loadPublicAttachmentRefs(
        env,
        rows.map(item => item.feedback_id)
      );

      return json({
        ok: true,
        feedback: rows.map(item => {
          const feedbackId = item.feedback_id;
          const copy = {
            ...item,
            report_id: formatSourceReportId(item.source_key, item.source_number),
            source: item.source_key,
            attachments: attachmentMap.get(feedbackId) || []
          };
          delete copy.feedback_id;
          return copy;
        })
      });
    }

    if (
      url.pathname === "/api/feedback-status" &&
      request.method === "GET"
    ) {
      await ensureTrackingRows(env);

      const reportNumber = parseReportNumber(
        url.searchParams.get("id")
      );

      if (!reportNumber) {
        return json({ ok: false, error: "Invalid report id" }, 400);
      }

      const item = await env.DB.prepare(
        `SELECT
           f.created_at,
           f.status,
           f.category,
           f.is_public,
           f.public_title,
           f.public_note,
           f.fixed_version,
           f.fixed_build,
           f.updated_at,
           t.report_number,
           t.eta_seconds,
           t.eta_due_at,
           t.fix_published,
           t.unable_reason,
           t.deleted_at,
           t.deletion_reason
         FROM feedback f
         JOIN feedback_tracking t ON t.feedback_id = f.id
         WHERE t.report_number = ?
         LIMIT 1`
      )
        .bind(reportNumber)
        .first();

      if (!item) {
        return json({ ok: false, error: "Not found" }, 404);
      }

      if (item.deleted_at) {
        return json({
          ok: true,
          feedback: {
            report_id: formatReportId(reportNumber),
            status: "deleted",
            deleted_at: item.deleted_at,
            deletion_reason: item.deletion_reason || ""
          }
        });
      }

      const attachmentMap =
        Number(item.is_public) === 1
          ? await loadPublicAttachmentRefs(env, [item.feedback_id])
          : new Map();

      return json({
        ok: true,
        feedback: {
          report_id: formatReportId(reportNumber),
          created_at: item.created_at,
          status: item.status,
          eta_seconds: item.eta_seconds,
          eta_due_at: item.eta_due_at,
          fixed_version: item.fixed_version,
          fixed_build: item.fixed_build,
          fix_published: item.fix_published,
          unable_reason: item.unable_reason,
          public_title: Number(item.is_public) === 1
            ? item.public_title
            : null,
          public_note: Number(item.is_public) === 1
            ? item.public_note
            : null,
          attachments: Number(item.is_public) === 1
            ? (attachmentMap.get(item.feedback_id) || [])
            : []
        }
      });
    }

    if (url.pathname === "/api/feedback") {
      if (request.method !== "POST") {
        return json(
          { ok: false, error: "Method not allowed" },
          405
        );
      }

      const origin = request.headers.get("Origin");

      if (origin && origin !== url.origin) {
        return json({ ok: false, error: "Invalid origin" }, 403);
      }

      if (!(request.headers.get("Content-Type") || "").includes("application/json")) {
        return json({ ok: false, error: "JSON required" }, 415);
      }

      let body;

      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400);
      }

      if (clean(body.website, 200)) {
        return json({ ok: true });
      }

      const category =
        clean(body.category, 40) || "other";
      const description =
        clean(body.description, 5000);
      const steps =
        clean(body.steps, 5000);
      const appVersion =
        clean(body.appVersion, 40);
      const buildNumber =
        clean(body.buildNumber, 40);
      const iosVersion =
        clean(body.iosVersion, 80);
      const deviceModel =
        clean(body.deviceModel, 120);
      const diagnostics =
        cleanDiagnostics(body.diagnostics);

      if (description.length < 5) {
        return json(
          { ok: false, error: "Description is too short" },
          400
        );
      }

      if (!allowedCategories.has(category)) {
        return json(
          { ok: false, error: "Invalid category" },
          400
        );
      }

      await ensureTrackingRows(env);

      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const reportNumber = await nextReportNumber(env);

      try {
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO feedback
             (
               id,
               created_at,
               status,
               category,
               description,
               steps,
               app_version,
               build_number,
               ios_version,
               device_model,
               source
             )
             VALUES (?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, 'web')`
          ).bind(
            id,
            createdAt,
            category,
            description,
            steps || null,
            appVersion || null,
            buildNumber || null,
            iosVersion || null,
            deviceModel || null
          ),
          env.DB.prepare(
            `INSERT INTO feedback_tracking
             (
               feedback_id,
               report_number,
               diagnostics_json
             )
             VALUES (?, ?, ?)`
          ).bind(
            id,
            reportNumber,
            diagnostics ? JSON.stringify(diagnostics) : null
          )
        ]);
      } catch (error) {
        console.error("Feedback insert failed", error);
        return json(
          { ok: false, error: "Unable to save feedback" },
          500
        );
      }

      return json(
        {
          ok: true,
          id: formatReportId(reportNumber)
        },
        201
      );
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ ok: false, error: "Not found" }, 404);
    }

    return env.ASSETS.fetch(request);
  }
};
