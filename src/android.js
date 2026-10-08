const reply = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
const clean = (value, max) => typeof value === "string" ? value.trim().slice(0, max) : "";
const statuses = new Set(["new", "in_progress", "resolved", "closed"]);
const categories = new Set(["crash", "performance", "photos", "videos", "ui", "suggestion", "other"]);
const idFor = number => "AND-" + String(number).padStart(3, "0");
const sameOrigin = (request, url) => !request.headers.get("Origin") || request.headers.get("Origin") === url.origin;
const jsonRequest = request => (request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json");
const date = () => new Date().toISOString();
const releaseKey = (version, build, sha) => `android/${version}/build-${build}/${sha}.apk`;
const objectSha256 = object => {
  const checksum = object?.checksums?.sha256;
  if (!checksum) return null;
  const bytes = new Uint8Array(checksum);
  return bytes.length === 32 ? Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("") : null;
};

async function bodyFrom(request) {
  if (!jsonRequest(request)) return null;
  try { return await request.json(); } catch { return null; }
}

async function digest(secret, value) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function limited(env, request, bucket, max) {
  if (!env.ANDROID_HASH_SECRET) return true;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const today = date().slice(0, 10);
  const hash = await digest(env.ANDROID_HASH_SECRET, `${bucket}:${today}:${ip}`);
  const expiry = new Date(Date.now() + 2 * 86400000).toISOString();
  const result = await env.DB.prepare(`INSERT INTO android_rate_limits (key_hash,count,expires_at) VALUES (?,1,?)
    ON CONFLICT(key_hash) DO UPDATE SET count=count+1 RETURNING count`).bind(hash, expiry).first();
  return Number(result?.count || 0) > max;
}

const publicFields = `created_at,status,category,public_title,public_note,fixed_version,fixed_build,updated_at,
  report_number,eta_seconds,eta_due_at,fix_published,unable_reason,deleted_at,deletion_reason,is_public`;

export async function handleAndroidApi(request, env, url) {
  const path = url.pathname;
  if (!path.startsWith("/api/android/")) return null;
  if (!env.DB) return reply({ ok: false, error: "Database unavailable" }, 503);

  if (path === "/api/android/release" && request.method === "GET") {
    const row = await env.DB.prepare(`SELECT version,build_number,released_at,file_size,sha256,signing_fingerprint,notes,published
      FROM android_release WHERE singleton=1 AND published=1`).first();
    const history = await env.DB.prepare(`SELECT version,build_number,released_at,notes FROM android_release_history ORDER BY released_at DESC LIMIT 20`).all();
    return reply({ ok: true, release: row || null, history: history.results || [], downloadUrl: row && env.ANDROID_APK_BUCKET ? "/api/android/download" : null });
  }
  if (path === "/api/android/download" && request.method === "GET") {
    const release = await env.DB.prepare(`SELECT version,build_number,r2_key,file_size,sha256 FROM android_release WHERE singleton=1 AND published=1`).first();
    if (!release || !env.ANDROID_APK_BUCKET) return reply({ ok: false, error: "Download unavailable" }, 404);
    if (release.r2_key !== releaseKey(release.version, release.build_number, release.sha256)) return reply({ ok: false, error: "Download integrity check failed" }, 409);
    const object = await env.ANDROID_APK_BUCKET.get(release.r2_key);
    if (!object || object.size !== Number(release.file_size) || objectSha256(object) !== release.sha256) {
      if (object?.body?.cancel) {
        try { await object.body.cancel(); } catch { /* Integrity failure still rejects the download. */ }
      }
      return reply({ ok: false, error: "Download integrity check failed" }, 409);
    }
    await env.DB.prepare(`INSERT INTO android_downloads (release_version,downloaded_at) VALUES (?,?)`).bind(release.version, date()).run();
    return new Response(object.body, { headers: { "Content-Type": "application/vnd.android.package-archive", "Content-Disposition": `attachment; filename="ChaiPhoto-Android.apk"`, "Content-Length": String(object.size), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }
  if (path === "/api/android/public-feedback" && request.method === "GET") {
    const rows = await env.DB.prepare(`SELECT ${publicFields} FROM android_feedback WHERE is_public=1 AND deleted_at IS NULL ORDER BY COALESCE(updated_at,created_at) DESC LIMIT 200`).all();
    return reply({ ok: true, feedback: (rows.results || []).map(row => ({ report_id: idFor(row.report_number), created_at: row.created_at, status: row.status, category: row.category, public_title: row.public_title, public_note: row.public_note, fixed_version: row.fixed_version, fixed_build: row.fixed_build, updated_at: row.updated_at, eta_seconds: row.eta_seconds, eta_due_at: row.eta_due_at, fix_published: row.fix_published, unable_reason: row.unable_reason })) });
  }
  if (path === "/api/android/feedback-status" && request.method === "GET") {
    const match = /^AND-(\d{1,9})$/i.exec(clean(url.searchParams.get("id"), 40));
    if (!match) return reply({ ok: false, error: "Invalid Android report ID" }, 400);
    const row = await env.DB.prepare(`SELECT ${publicFields} FROM android_feedback WHERE report_number=?`).bind(Number(match[1])).first();
    if (!row) return reply({ ok: false, error: "Not found" }, 404);
    if (row.deleted_at) return reply({ ok: true, feedback: { report_id: idFor(row.report_number), status: "deleted", deleted_at: row.deleted_at, deletion_reason: row.deletion_reason || "" } });
    return reply({ ok: true, feedback: { report_id: idFor(row.report_number), created_at: row.created_at, status: row.status, category: row.category, eta_seconds: row.eta_seconds, eta_due_at: row.eta_due_at, fixed_version: row.fixed_version, fixed_build: row.fixed_build, fix_published: row.fix_published, unable_reason: row.unable_reason, public_title: row.is_public ? row.public_title : null, public_note: row.is_public ? row.public_note : null } });
  }
  if (path === "/api/android/feedback" && request.method === "POST") {
    if (!sameOrigin(request, url)) return reply({ ok: false, error: "Invalid origin" }, 403);
    const body = await bodyFrom(request);
    if (!body) return reply({ ok: false, error: "JSON required" }, 415);
    if (clean(body.website, 200)) return reply({ ok: true });
    if (!env.ANDROID_HASH_SECRET) return reply({ ok: false, error: "Feedback temporarily unavailable" }, 503);
    if (await limited(env, request, "feedback", 12)) return reply({ ok: false, error: "Rate limit exceeded" }, 429);
    const category = clean(body.category, 40);
    const description = clean(body.description, 5000);
    if (!categories.has(category) || description.length < 5) return reply({ ok: false, error: "Invalid feedback" }, 400);
    const suggestion = category === "suggestion";
    const result = await env.DB.prepare(`INSERT INTO android_feedback
      (id,created_at,category,description,steps,app_version,build_number,android_version,device_model,diagnostics_json)
      VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING report_number`).bind(
      crypto.randomUUID(), date(), category, description, clean(body.steps, 5000) || null,
      suggestion ? null : clean(body.appVersion, 40) || null,
      suggestion ? null : clean(body.buildNumber, 40) || null,
      suggestion ? null : clean(body.androidVersion, 80) || null,
      suggestion ? null : clean(body.deviceModel, 120) || null,
      suggestion ? null : clean(body.diagnostics, 2000) || null
    ).first();
    return reply({ ok: true, id: idFor(result.report_number) }, 201);
  }
  if (path === "/api/android/open" && request.method === "POST") {
    if (!env.ANDROID_HASH_SECRET) return reply({ ok: false, error: "Install reporting unavailable" }, 503);
    if (await limited(env, request, "open", 120)) return reply({ ok: false, error: "Rate limit exceeded" }, 429);
    const body = await bodyFrom(request);
    const installId = clean(body?.installationId, 80);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(installId)) return reply({ ok: false, error: "Invalid installation ID" }, 400);
    const hash = await digest(env.ANDROID_HASH_SECRET, `install:${installId.toLowerCase()}`);
    const now = date();
    await env.DB.prepare(`INSERT INTO android_installations (install_hash,first_open_at,last_open_at) VALUES (?,?,?)
      ON CONFLICT(install_hash) DO UPDATE SET last_open_at=excluded.last_open_at`).bind(hash, now, now).run();
    return reply({ ok: true });
  }
  return reply({ ok: false, error: "Not found" }, 404);
}

export async function handleAndroidDashboardApi(request, env, url) {
  const path = url.pathname;
  if (!path.startsWith("/dashboard/api/android/")) return null;
  if (path === "/dashboard/api/android/feedback" && request.method === "GET") {
    const result = await env.DB.prepare(`SELECT *,android_version AS ios_version FROM android_feedback ORDER BY COALESCE(deleted_at,created_at) DESC LIMIT 500`).all();
    const counts = { new: 0, in_progress: 0, resolved: 0, closed: 0, deleted: 0 };
    for (const row of result.results || []) counts[row.deleted_at ? "deleted" : row.status]++;
    return reply({ ok: true, feedback: result.results || [], counts });
  }
  if (path === "/dashboard/api/android/stats" && request.method === "GET") {
    const [downloads, firstOpens, active] = await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) AS n FROM android_downloads`).first(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM android_installations`).first(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM android_installations WHERE last_open_at >= ?`).bind(new Date(Date.now() - 30 * 86400000).toISOString()).first()
    ]);
    const release = await env.DB.prepare(`SELECT * FROM android_release WHERE singleton=1`).first();
    return reply({ ok: true, downloads: Number(downloads.n), firstOpens: Number(firstOpens.n), active30Days: Number(active.n), release: release || null });
  }
  if (!sameOrigin(request, url)) return reply({ ok: false, error: "Invalid origin" }, 403);
  if (path === "/dashboard/api/android/release" && request.method === "PUT") {
    const body = await bodyFrom(request);
    if (!body) return reply({ ok: false, error: "JSON required" }, 415);
    const version = clean(body.version, 40), build = clean(body.buildNumber, 40);
    const key = clean(body.r2Key, 300), fingerprint = clean(body.signingFingerprint, 160);
    const sha = clean(body.sha256, 64).toLowerCase();
    const size = Number(body.fileSize);
    const published = body.published === true;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(version) || !/^[0-9]{1,20}$/.test(build) ||
      key !== releaseKey(version, build, sha) || !/^[a-f0-9]{64}$/.test(sha) ||
      !fingerprint || !Number.isSafeInteger(size) || size < 1) return reply({ ok: false, error: "Invalid release metadata" }, 400);
    if (published) {
      if (!env.ANDROID_APK_BUCKET) return reply({ ok: false, error: "R2 binding unavailable" }, 503);
      const object = await env.ANDROID_APK_BUCKET.head(key);
      if (!object || object.size !== size || objectSha256(object) !== sha) return reply({ ok: false, error: "R2 size or SHA-256 checksum mismatch" }, 409);
    }
    await env.DB.prepare(`INSERT INTO android_release (singleton,version,build_number,released_at,file_size,r2_key,sha256,signing_fingerprint,notes,published)
      VALUES (1,?,?,?,?,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET version=excluded.version,build_number=excluded.build_number,released_at=excluded.released_at,file_size=excluded.file_size,r2_key=excluded.r2_key,sha256=excluded.sha256,signing_fingerprint=excluded.signing_fingerprint,notes=excluded.notes,published=excluded.published`)
      .bind(version, build, date(), size, key, sha, fingerprint, clean(body.notes, 2000) || null, published ? 1 : 0).run();
    if (published) await env.DB.prepare(`INSERT INTO android_release_history (version,build_number,released_at,notes) VALUES (?,?,?,?)
      ON CONFLICT(version,build_number) DO UPDATE SET notes=excluded.notes`)
      .bind(version, build, date(), clean(body.notes, 2000) || null).run();
    return reply({ ok: true });
  }
  if (path === "/dashboard/api/android/feedback/restore" && request.method === "POST") {
    const body = await bodyFrom(request);
    if (!body) return reply({ ok: false, error: "JSON required" }, 415);
    const result = await env.DB.prepare(`UPDATE android_feedback SET deleted_at=NULL,deletion_reason=NULL WHERE id=? AND deleted_at IS NOT NULL`).bind(clean(body.id, 80)).run();
    return reply({ ok: Number(result.meta?.changes || 0) > 0 });
  }
  if (path === "/dashboard/api/android/feedback" && request.method === "DELETE") {
    const body = await bodyFrom(request);
    if (!body) return reply({ ok: false, error: "JSON required" }, 415);
    const result = await env.DB.prepare(`UPDATE android_feedback SET deleted_at=?,deletion_reason=? WHERE id=? AND deleted_at IS NULL`).bind(date(), clean(body.deletionReason, 500) || null, clean(body.id, 80)).run();
    return reply({ ok: Number(result.meta?.changes || 0) > 0 });
  }
  if (path === "/dashboard/api/android/feedback" && request.method === "PATCH") {
    const body = await bodyFrom(request);
    if (!body) return reply({ ok: false, error: "JSON required" }, 415);
    const status = clean(body.status, 20);
    const title = clean(body.publicTitle, 180);
    const eta = Number(body.etaSeconds);
    if (!statuses.has(status) || (body.isPublic && title.length < 3) || !Number.isFinite(eta) || eta < 0 || eta > 31536000) return reply({ ok: false, error: "Invalid update" }, 400);
    const now = date();
    const result = await env.DB.prepare(`UPDATE android_feedback SET status=?,is_public=?,public_title=?,public_note=?,fixed_version=?,fixed_build=?,updated_at=?,fix_published=?,unable_reason=?,eta_seconds=?,eta_due_at=?
      WHERE id=? AND deleted_at IS NULL`).bind(status, body.isPublic ? 1 : 0, title || null, clean(body.publicNote, 2000) || null,
      clean(body.fixedVersion, 80) || null, clean(body.fixedBuild, 80) || null, now, body.fixPublished ? 1 : 0,
      status === "closed" ? clean(body.unableReason, 1200) || null : null,
      status === "in_progress" && eta > 0 ? Math.floor(eta) : null,
      status === "in_progress" && eta > 0 ? new Date(Date.now() + eta * 1000).toISOString() : null,
      clean(body.id, 80)).run();
    return reply({ ok: Number(result.meta?.changes || 0) > 0 });
  }
  return reply({ ok: false, error: "Not found" }, 404);
}
