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

const allowedStatuses = new Set(["new", "in_progress", "resolved", "closed"]);
const dashboardHost = "photo.chaihome.cc";

function isDashboardRequest(url) {
  return url.pathname === "/dashboard" || url.pathname.startsWith("/dashboard/");
}

function hasAccessIdentity(request) {
  return Boolean(
    request.headers.get("Cf-Access-Authenticated-User-Email") ||
    request.headers.get("Cf-Access-Jwt-Assertion")
  );
}

async function handleDashboardApi(request, env, url) {
  if (url.pathname === "/dashboard/api/feedback" && request.method === "GET") {
    const status = clean(url.searchParams.get("status"), 20);
    const filter = allowedStatuses.has(status) ? status : null;

    const listQuery = filter
      ? env.DB.prepare(
          `SELECT id, created_at, status, category, description, steps,
                  app_version, build_number, ios_version, device_model, source
             FROM feedback
            WHERE status = ?
            ORDER BY created_at DESC
            LIMIT 200`
        ).bind(filter)
      : env.DB.prepare(
          `SELECT id, created_at, status, category, description, steps,
                  app_version, build_number, ios_version, device_model, source
             FROM feedback
            ORDER BY created_at DESC
            LIMIT 200`
        );

    const [list, counts] = await Promise.all([
      listQuery.all(),
      env.DB.prepare(
        `SELECT status, COUNT(*) AS count
           FROM feedback
          GROUP BY status`
      ).all()
    ]);

    const summary = { new: 0, in_progress: 0, resolved: 0, closed: 0 };
    for (const row of counts.results || []) {
      if (Object.hasOwn(summary, row.status)) {
        summary[row.status] = Number(row.count) || 0;
      }
    }

    return json({
      ok: true,
      feedback: list.results || [],
      counts: summary
    });
  }

  if (url.pathname === "/dashboard/api/feedback" && request.method === "PATCH") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) {
      return json({ ok: false, error: "Invalid origin" }, 403);
    }

    const type = request.headers.get("Content-Type") || "";
    if (!type.includes("application/json")) {
      return json({ ok: false, error: "JSON required" }, 415);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "Invalid JSON" }, 400);
    }

    const id = clean(body.id, 80);
    const status = clean(body.status, 20);

    if (!id || !allowedStatuses.has(status)) {
      return json({ ok: false, error: "Invalid update" }, 400);
    }

    const result = await env.DB.prepare(
      "UPDATE feedback SET status = ? WHERE id = ?"
    ).bind(status, id).run();

    if (!result.meta?.changes) {
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
      // The dashboard is intentionally available only through the protected
      // custom hostname. workers.dev is disabled as a second layer of defense.
      if (url.hostname !== dashboardHost || !hasAccessIdentity(request)) {
        return new Response("Not found", {
          status: 404,
          headers: {
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff"
          }
        });
      }

      const apiResponse = await handleDashboardApi(request, env, url);
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

    if (url.pathname === "/api/feedback") {
      if (request.method !== "POST") {
        return json({ ok: false, error: "Method not allowed" }, 405);
      }

      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) {
        return json({ ok: false, error: "Invalid origin" }, 403);
      }

      const type = request.headers.get("Content-Type") || "";
      if (!type.includes("application/json")) {
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

      const category = clean(body.category, 40) || "other";
      const description = clean(body.description, 5000);
      const steps = clean(body.steps, 5000);
      const appVersion = clean(body.appVersion, 40);
      const buildNumber = clean(body.buildNumber, 40);
      const iosVersion = clean(body.iosVersion, 80);
      const deviceModel = clean(body.deviceModel, 120);

      if (description.length < 5) {
        return json({ ok: false, error: "Description is too short" }, 400);
      }

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
      if (!allowedCategories.has(category)) {
        return json({ ok: false, error: "Invalid category" }, 400);
      }

      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();

      try {
        await env.DB.prepare(
          `INSERT INTO feedback
           (id, created_at, status, category, description, steps, app_version, build_number, ios_version, device_model, source)
           VALUES (?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, 'web')`
        )
          .bind(
            id,
            createdAt,
            category,
            description,
            steps || null,
            appVersion || null,
            buildNumber || null,
            iosVersion || null,
            deviceModel || null
          )
          .run();
      } catch (error) {
        console.error("Feedback insert failed", error);
        return json({ ok: false, error: "Unable to save feedback" }, 500);
      }

      return json({ ok: true, id }, 201);
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ ok: false, error: "Not found" }, 404);
    }

    return env.ASSETS.fetch(request);
  }
};
