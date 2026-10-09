// Cloudflare Access signs this assertion; an identity header alone is not proof.
const decodeBase64Url = value => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid JWT encoding");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
};

export async function verifyAccessRequest(request, env, fetchCerts = fetch) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  const audience = env.ACCESS_AUD;
  if (
    !token || typeof teamDomain !== "string" ||
    !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain) ||
    typeof audience !== "string" || !audience
  ) return false;

  try {
    const parts = token.split(".");
    if (parts.length !== 3 || token.length > 8192) return false;
    const header = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0])));
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1])));
    const now = Math.floor(Date.now() / 1000);
    if (
      header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid ||
      claims.iss !== `https://${teamDomain}` ||
      !Array.isArray(claims.aud) || !claims.aud.includes(audience) ||
      !Number.isSafeInteger(claims.exp) || claims.exp <= now ||
      (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now)) ||
      (claims.iat !== undefined && (!Number.isSafeInteger(claims.iat) || claims.iat > now + 60))
    ) return false;

    const response = await fetchCerts(`https://${teamDomain}/cdn-cgi/access/certs`, {
      cache: "no-store",
      redirect: "error"
    });
    if (!response.ok) return false;
    const certificates = await response.json();
    const jwk = Array.isArray(certificates.keys)
      ? certificates.keys.find(key => key.kid === header.kid && key.kty === "RSA" && key.alg === "RS256")
      : null;
    if (!jwk) return false;

    const key = await crypto.subtle.importKey(
      "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
    );
    return crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5", key, decodeBase64Url(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
  } catch {
    return false;
  }
}
