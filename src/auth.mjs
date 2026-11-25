import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function isLoopbackHost(host) {
  const value = String(host || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return value === "127.0.0.1" || value === "::1" || value === "localhost";
}

export function tokenFromRequest(req) {
  const header = String(req.headers.authorization || "");
  if (header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  const direct = req.headers["x-foreman-token"];
  return direct ? String(direct).trim() : "";
}

export function tokenMatches(expected, provided) {
  if (!expected || !provided) return false;
  const a = crypto.createHash("sha256").update(String(expected)).digest();
  const b = crypto.createHash("sha256").update(String(provided)).digest();
  return crypto.timingSafeEqual(a, b);
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

// Loopback access stays frictionless. Binding to a LAN address without an
// explicit token generates one on first boot and reuses it from dataDir.
export function ensureAuthToken(config, logger = console) {
  if (config.authToken) {
    if (!isLoopbackHost(config.host) && String(config.authToken).length < 16) {
      throw new Error(
        "FOREMAN_TOKEN must be at least 16 characters when binding beyond loopback",
      );
    }
    return config.authToken;
  }
  if (config.allowInsecure || isLoopbackHost(config.host)) return null;

  try {
    const existing = fs.readFileSync(config.authTokenPath, "utf8").trim();
    if (existing) {
      config.authToken = existing;
      return existing;
    }
  } catch {
    // first boot
  }

  const token = crypto.randomBytes(32).toString("base64url");
  fs.mkdirSync(path.dirname(config.authTokenPath), { recursive: true });
  fs.writeFileSync(config.authTokenPath, `${token}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(config.authTokenPath, 0o600);
  } catch {
    // best effort
  }
  config.authToken = token;
  logger.info(
    `[auth] generated access token at ${config.authTokenPath} (mode 600)`,
  );
  return token;
}

export function accessUrls(config) {
  const port = config.port;
  if (String(config.host) === "::1") {
    return [`http://[::1]:${port}`];
  }
  if (String(config.host) === "0.0.0.0" || String(config.host) === "::") {
    const urls = new Set([`http://127.0.0.1:${port}`]);
    for (const addresses of Object.values(os.networkInterfaces())) {
      for (const address of addresses || []) {
        if (address.family === "IPv4" && !address.internal) {
          urls.add(`http://${address.address}:${port}`);
        }
      }
    }
    return [...urls];
  }
  return [`http://${config.host}:${port}`];
}
