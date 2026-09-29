export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({
        ok: true,
        service: "ChaiPhoto Web",
        timestamp: new Date().toISOString()
      });
    }

    return Response.json(
      { ok: false, error: "Not found" },
      { status: 404 }
    );
  }
};
