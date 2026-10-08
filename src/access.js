const decode = value => {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
};

const parsePart = value => JSON.parse(new TextDecoder().decode(decode(value)));

export async function verifyAccessJwt(request, env, fetchKeys = fetch) {
  const audience = env.CF_ACCESS_AUD;
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!audience || !teamDomain || !token) return false;

  try {
    const issuer = new URL(teamDomain);
    if (issuer.protocol !== "https:" || !issuer.hostname.endsWith(".cloudflareaccess.com") ||
        issuer.username || issuer.password || issuer.port || issuer.pathname !== "/" || issuer.search || issuer.hash) return false;

    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const header = parsePart(parts[0]);
    const claims = parsePart(parts[1]);
    if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) return false;

    const response = await fetchKeys(`${issuer.origin}/cdn-cgi/access/certs`);
    if (!response.ok) return false;
    const jwks = await response.json();
    const jwk = jwks.keys?.find(key => key.kid === header.kid && key.kty === "RSA" &&
      (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig"));
    if (!jwk) return false;

    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decode(parts[2]), signed)) return false;

    const now = Math.floor(Date.now() / 1000);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    return claims.iss === issuer.origin && audiences.includes(audience) &&
      Number.isFinite(claims.exp) && claims.exp > now &&
      (!Object.hasOwn(claims, "nbf") || (Number.isFinite(claims.nbf) && claims.nbf <= now));
  } catch {
    return false;
  }
}
