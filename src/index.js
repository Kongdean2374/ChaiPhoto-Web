// Deployment trigger: refresh

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

async function handleDashboardApi(request, env, url) {
  /*
   * =========================================================
   * 私人管理後台：取得回報
   * GET /dashboard/api/feedback
   * =========================================================
   */
  if (
    url.pathname === "/dashboard/api/feedback" &&
    request.method === "GET"
  ) {
    const status = clean(url.searchParams.get("status"), 20);
    const filter = allowedStatuses.has(status) ? status : null;

    const listQuery = filter
      ? env.DB.prepare(
          `SELECT
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
             source,
             is_public,
             public_title,
             public_note,
             fixed_version,
             fixed_build,
             updated_at
           FROM feedback
           WHERE status = ?
           ORDER BY created_at DESC
           LIMIT 200`
        ).bind(filter)
      : env.DB.prepare(
          `SELECT
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
             source,
             is_public,
             public_title,
             public_note,
             fixed_version,
             fixed_build,
             updated_at
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

    const summary = {
      new: 0,
      in_progress: 0,
      resolved: 0,
      closed: 0
    };

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

  /*
   * =========================================================
   * 私人管理後台：更新回報
   * PATCH /dashboard/api/feedback
   *
   * 可修改：
   * - status
   * - 是否公開
   * - 公開標題
   * - 公開進度
   * - 修復版本
   * - 修復 Build
   * =========================================================
   */
  if (
    url.pathname === "/dashboard/api/feedback" &&
    request.method === "PATCH"
  ) {
    const origin = request.headers.get("Origin");

    if (origin && origin !== url.origin) {
      return json(
        {
          ok: false,
          error: "Invalid origin"
        },
        403
      );
    }

    const type = request.headers.get("Content-Type") || "";

    if (!type.includes("application/json")) {
      return json(
        {
          ok: false,
          error: "JSON required"
        },
        415
      );
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return json(
        {
          ok: false,
          error: "Invalid JSON"
        },
        400
      );
    }

    const id = clean(body.id, 80);

    if (!id) {
      return json(
        {
          ok: false,
          error: "Missing feedback id"
        },
        400
      );
    }

    const updates = [];
    const values = [];

    /*
     * 狀態
     */
    if (Object.hasOwn(body, "status")) {
      const status = clean(body.status, 20);

      if (!allowedStatuses.has(status)) {
        return json(
          {
            ok: false,
            error: "Invalid status"
          },
          400
        );
      }

      updates.push("status = ?");
      values.push(status);
    }

    /*
     * 公開資訊
     */
    if (Object.hasOwn(body, "isPublic")) {
      const isPublic =
        body.isPublic === true ||
        body.isPublic === 1 ||
        body.isPublic === "1";

      const publicTitle = clean(body.publicTitle, 180);
      const publicNote = clean(body.publicNote, 2000);
      const fixedVersion = clean(body.fixedVersion, 80);
      const fixedBuild = clean(body.fixedBuild, 80);

      /*
       * 如果要公開，至少必須提供公開標題。
       * 避免直接把原始回報內容公開出去。
       */
      if (isPublic && publicTitle.length < 3) {
        return json(
          {
            ok: false,
            error: "Public title is required"
          },
          400
        );
      }

      updates.push("is_public = ?");
      values.push(isPublic ? 1 : 0);

      updates.push("public_title = ?");
      values.push(publicTitle || null);

      updates.push("public_note = ?");
      values.push(publicNote || null);

      updates.push("fixed_version = ?");
      values.push(fixedVersion || null);

      updates.push("fixed_build = ?");
      values.push(fixedBuild || null);
    }

    if (!updates.length) {
      return json(
        {
          ok: false,
          error: "Nothing to update"
        },
        400
      );
    }

    /*
     * 每次管理員修改時記錄最後更新時間。
     */
    updates.push("updated_at = ?");
    values.push(new Date().toISOString());

    values.push(id);

    const result = await env.DB.prepare(
      `UPDATE feedback
       SET ${updates.join(", ")}
       WHERE id = ?`
    )
      .bind(...values)
      .run();

    if (!result.meta?.changes) {
      return json(
        {
          ok: false,
          error: "Feedback not found"
        },
        404
      );
    }

    return json({
      ok: true
    });
  }

  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /*
     * =========================================================
     * 私人 Dashboard
     * Cloudflare Access 保護
     * =========================================================
     */
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

      if (apiResponse) {
        return apiResponse;
      }

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

    /*
     * =========================================================
     * 健康檢查
     * =========================================================
     */
    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        service: "ChaiPhoto Web",
        database: Boolean(env.DB),
        timestamp: new Date().toISOString()
      });
    }

    /*
     * =========================================================
     * 公開 Known Issues API
     *
     * 只提供管理員明確設定為公開的資料。
     *
     * 不會公開：
     * - 原始 description
     * - steps
     * - iOS 版本
     * - 裝置型號
     * - 其他可能包含個人資訊的內容
     * =========================================================
     */
    if (
      url.pathname === "/api/public-feedback" &&
      request.method === "GET"
    ) {
      const requestedStatus = clean(
        url.searchParams.get("status"),
        20
      );

      const filter = allowedStatuses.has(requestedStatus)
        ? requestedStatus
        : null;

      const query = filter
        ? env.DB.prepare(
            `SELECT
               id,
               created_at,
               status,
               category,
               public_title,
               public_note,
               fixed_version,
               fixed_build,
               updated_at
             FROM feedback
             WHERE is_public = 1
               AND status = ?
             ORDER BY COALESCE(updated_at, created_at) DESC
             LIMIT 200`
          ).bind(filter)
        : env.DB.prepare(
            `SELECT
               id,
               created_at,
               status,
               category,
               public_title,
               public_note,
               fixed_version,
               fixed_build,
               updated_at
             FROM feedback
             WHERE is_public = 1
             ORDER BY COALESCE(updated_at, created_at) DESC
             LIMIT 200`
          );

      const result = await query.all();

      return json({
        ok: true,
        feedback: result.results || []
      });
    }

    /*
     * =========================================================
     * 使用者送出問題回報
     * POST /api/feedback
     * =========================================================
     */
    if (url.pathname === "/api/feedback") {
      if (request.method !== "POST") {
        return json(
          {
            ok: false,
            error: "Method not allowed"
          },
          405
        );
      }

      const origin = request.headers.get("Origin");

      if (origin && origin !== url.origin) {
        return json(
          {
            ok: false,
            error: "Invalid origin"
          },
          403
        );
      }

      const type = request.headers.get("Content-Type") || "";

      if (!type.includes("application/json")) {
        return json(
          {
            ok: false,
            error: "JSON required"
          },
          415
        );
      }

      let body;

      try {
        body = await request.json();
      } catch {
        return json(
          {
            ok: false,
            error: "Invalid JSON"
          },
          400
        );
      }

      /*
       * Honeypot
       */
      if (clean(body.website, 200)) {
        return json({
          ok: true
        });
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

      if (description.length < 5) {
        return json(
          {
            ok: false,
            error: "Description is too short"
          },
          400
        );
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
        return json(
          {
            ok: false,
            error: "Invalid category"
          },
          400
        );
      }

      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();

      try {
        await env.DB.prepare(
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
           VALUES (
             ?,
             ?,
             'new',
             ?,
             ?,
             ?,
             ?,
             ?,
             ?,
             ?,
             'web'
           )`
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

        return json(
          {
            ok: false,
            error: "Unable to save feedback"
          },
          500
        );
      }

      return json(
        {
          ok: true,
          id
        },
        201
      );
    }

    /*
     * 其他不存在的 API
     */
    if (url.pathname.startsWith("/api/")) {
      return json(
        {
          ok: false,
          error: "Not found"
        },
        404
      );
    }

    /*
     * 靜態網站
     */
    return env.ASSETS.fetch(request);
  }
};
