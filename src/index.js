import { verifyAccessRequest } from "./access-auth.js";

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

async function readFeedbackJson(request) {
  const maxBytes = 16 * 1024;
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (declaredLength > maxBytes) return { error: "too_large" };
  if (!request.body) return { error: "invalid" };

  const reader = request.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return { error: "too_large" };
      }
      chunks.push(value);
    }
    const buffer = new Uint8Array(bytes);
    let position = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, position);
      position += chunk.byteLength;
    }
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)) };
  } catch {
    return { error: "invalid" };
  }
}

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
}

function etaFromBody(body) {
  if (!Object.hasOwn(body, "etaSeconds")) return undefined;

  const parsed = Number(body.etaSeconds);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return Math.min(Math.floor(parsed), 60 * 60 * 24 * 365);
}

async function handleDashboardApi(request, env, url) {
  await ensureTrackingRows(env);

  if (
    url.pathname === "/dashboard/api/feedback" &&
    request.method === "GET"
  ) {
    const offsetValue = Number(url.searchParams.get("offset") || 0);
    if (!Number.isSafeInteger(offsetValue) || offsetValue < 0) {
      return json({ ok: false, error: "Invalid offset" }, 400);
    }
    const pageSize = 500;
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
         t.deletion_reason
       FROM feedback f
       JOIN feedback_tracking t ON t.feedback_id = f.id
       ORDER BY CASE
         WHEN t.deleted_at IS NOT NULL THEN 3
         WHEN f.status = 'new' THEN 0
         WHEN f.status = 'in_progress' THEN 1
         ELSE 2
       END,
       f.created_at DESC,
       t.report_number DESC
       LIMIT ? OFFSET ?`
    ).bind(pageSize, offsetValue).all();

    const totals = await env.DB.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN t.deleted_at IS NULL AND f.status = 'new' THEN 1 ELSE 0 END) AS new_count,
         SUM(CASE WHEN t.deleted_at IS NULL AND f.status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress_count,
         SUM(CASE WHEN t.deleted_at IS NULL AND f.status = 'resolved' THEN 1 ELSE 0 END) AS resolved_count,
         SUM(CASE WHEN t.deleted_at IS NULL AND f.status = 'closed' THEN 1 ELSE 0 END) AS closed_count,
         SUM(CASE WHEN t.deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted_count,
         SUM(CASE WHEN t.deleted_at IS NULL AND f.category = 'suggestion' THEN 1 ELSE 0 END) AS suggestion_count
       FROM feedback f
       JOIN feedback_tracking t ON t.feedback_id = f.id`
    ).first();

    const counts = {
      new: Number(totals?.new_count || 0),
      in_progress: Number(totals?.in_progress_count || 0),
      resolved: Number(totals?.resolved_count || 0),
      closed: Number(totals?.closed_count || 0),
      deleted: Number(totals?.deleted_count || 0),
      suggestion: Number(totals?.suggestion_count || 0)
    };

    return json({
      ok: true,
      feedback: list.results || [],
      counts,
      total: Number(totals?.total || 0)
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
  async fetch(request, env) {
    const url = new URL(request.url);

    if (isDashboardRequest(url)) {
      if (
        url.hostname !== dashboardHost ||
        !(await verifyAccessRequest(request, env))
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
           f.created_at,
           f.status,
           f.category,
           f.public_title,
           f.public_note,
           f.fixed_version,
           f.fixed_build,
           f.updated_at,
           t.report_number,
           t.eta_seconds,
           t.eta_due_at,
           t.fix_published
         FROM feedback f
         JOIN feedback_tracking t ON t.feedback_id = f.id
         WHERE f.is_public = 1
           AND t.deleted_at IS NULL` +
        (filter ? " AND f.status = ?" : "") +
        " ORDER BY COALESCE(f.updated_at, f.created_at) DESC LIMIT 200";

      const statement = env.DB.prepare(sql);
      const result = filter
        ? await statement.bind(filter).all()
        : await statement.all();

      return json({
        ok: true,
        feedback: (result.results || []).map(item => ({
          ...item,
          report_id: formatReportId(item.report_number)
        }))
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
           t.deleted_at
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
            category: item.category,
            deleted_at: item.deleted_at
          }
        });
      }

      return json({
        ok: true,
        feedback: {
          report_id: formatReportId(reportNumber),
          created_at: item.created_at,
          status: item.status,
          category: item.category,
          eta_seconds: item.eta_seconds,
          eta_due_at: item.eta_due_at,
          fixed_version: item.fixed_version,
          fixed_build: item.fixed_build,
          fix_published: item.fix_published,
          public_title: Number(item.is_public) === 1
            ? item.public_title
            : null,
          public_note: Number(item.is_public) === 1
            ? item.public_note
            : null
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

      const parsed = await readFeedbackJson(request);
      if (parsed.error === "too_large") {
        return json({ ok: false, error: "Report is too large" }, 413);
      }
      if (parsed.error) {
        return json({ ok: false, error: "Invalid JSON" }, 400);
      }
      const body = parsed.value;

      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json({ ok: false, error: "Invalid JSON" }, 400);
      }

      if (clean(body.website, 200)) {
        return json({ ok: true });
      }

      const platform = clean(body.platform, 20);

      if (platform && platform !== "ios" && platform !== "android") {
        return json({ ok: false, error: "Invalid platform" }, 400);
      }

      const isAndroid = platform === "android";

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
        isAndroid ? "" : clean(body.iosVersion, 80);
      const deviceModel =
        clean(body.deviceModel, 120);
      const androidDetails = {
        deviceBrand: clean(body.deviceBrand, 80),
        androidVersion: clean(body.androidVersion, 80)
      };
      const diagnostics = isAndroid
        ? (Object.values(androidDetails).some(Boolean) ? androidDetails : null)
        : cleanDiagnostics(body.diagnostics);

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
             VALUES (?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            id,
            createdAt,
            category,
            description,
            steps || null,
            appVersion || null,
            buildNumber || null,
            iosVersion || null,
            deviceModel || null,
            isAndroid ? "android" : "web"
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
