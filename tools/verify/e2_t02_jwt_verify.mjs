import { createPublicKey, verify } from "node:crypto";

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

export function inspectAndVerifyJwt(token, servedJwks, expected) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("JWT must have exactly three segments");
  const [protectedSegment, payloadSegment, signatureSegment] = parts;
  const header = decodeSegment(protectedSegment);
  const payload = decodeSegment(payloadSegment);
  if (header.alg !== "RS256") throw new Error(`unexpected JWT alg: ${String(header.alg)}`);
  if (header.kid !== expected.kid) throw new Error(`unexpected JWT kid: ${String(header.kid)}`);
  const matchingKeys = servedJwks.keys.filter(
    (key) => key.kid === header.kid && key.alg === "RS256",
  );
  if (matchingKeys.length !== 1) throw new Error(`expected one served key for kid ${header.kid}`);
  const publicKey = createPublicKey({ key: matchingKeys[0], format: "jwk" });
  const valid = verify(
    "RSA-SHA256",
    Buffer.from(`${protectedSegment}.${payloadSegment}`),
    publicKey,
    Buffer.from(signatureSegment, "base64url"),
  );
  if (!valid) throw new Error("RS256 signature verification failed");
  for (const [name, value] of Object.entries(expected.claims)) {
    if (payload[name] !== value) {
      throw new Error(
        `claim ${name} mismatch: expected ${JSON.stringify(value)}, got ${JSON.stringify(payload[name])}`,
      );
    }
  }
  return { header, payload };
}

export function mutateSignature(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("JWT must have exactly three segments");
  const bytes = Buffer.from(parts[2], "base64url");
  bytes[bytes.length - 1] ^= 1;
  parts[2] = bytes.toString("base64url");
  return parts.join(".");
}
