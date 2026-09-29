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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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

      // Honeypot field for simple bot filtering. Real users never fill this.
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

    return json({ ok: false, error: "Not found" }, 404);
  }
};
