const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY_SIZE = 8 * 1024 * 1024;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

const BLOCKED_FORWARD_HEADERS = new Set([
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

const tokenCache = new Map();

const AUTO_TOKEN_CONFIG = {
  mode: "keycloak-password",
  tokenUrl: process.env.LKDS_TOKEN_URL || "https://sso.lkds.alabuga.ru/realms/KIS/protocol/openid-connect/token",
  username: process.env.LKDS_USERNAME || "admin",
  password: process.env.LKDS_PASSWORD || "admin",
  clientId: process.env.LKDS_CLIENT_ID || "postman",
  clientSecret: process.env.LKDS_CLIENT_SECRET || "l41I5Xtlos4EuhVOsD0stIR0upZYlDB0",
  scope: process.env.LKDS_SCOPE || ""
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function isTextLike(contentType) {
  return /(^text\/)|json|xml|yaml|csv|javascript|problem\+json/i.test(contentType || "");
}

function tlsHint(error) {
  const code = error?.code || error?.cause?.code;
  if (
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "CERT_HAS_EXPIRED"
  ) {
    return "TLS certificate verification failed. Enable Ignore TLS for internal dev hosts, or add the corporate CA to Node.js.";
  }
  return "";
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        reject(Object.assign(new Error("Payload is too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function performRequest({ url, method, headers, body, timeoutMs, ignoreTls }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;
    const bodyBuffer = body == null ? null : Buffer.from(String(body));
    const requestHeaders = { ...headers };

    if (bodyBuffer && !Object.keys(requestHeaders).some((name) => name.toLowerCase() === "content-length")) {
      requestHeaders["content-length"] = String(bodyBuffer.length);
    }

    const request = transport.request(
      target,
      {
        method,
        headers: requestHeaders,
        rejectUnauthorized: !ignoreTls
      },
      (response) => {
        const chunks = [];

        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode || 0,
            statusText: response.statusMessage || "",
            url,
            redirected: false,
            headers: response.headers,
            bodyBuffer: Buffer.concat(chunks)
          });
        });
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(Object.assign(new Error("Request timed out"), { code: "ETIMEDOUT" }));
    });

    request.on("error", reject);

    if (bodyBuffer && !["GET", "HEAD"].includes(method)) {
      request.write(bodyBuffer);
    }

    request.end();
  });
}

function cacheKeyForAuth(auth) {
  const stableAuth = {
    mode: auth.mode,
    tokenUrl: auth.tokenUrl,
    clientId: auth.clientId,
    username: auth.username,
    scope: auth.scope,
    credentialHash: crypto
      .createHash("sha256")
      .update(`${auth.password || ""}:${auth.clientSecret || ""}`)
      .digest("hex")
  };
  return crypto.createHash("sha256").update(JSON.stringify(stableAuth)).digest("hex");
}

function formBody(entries) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value != null && String(value).trim() !== "") params.set(key, String(value));
  }
  return params.toString();
}

async function getKeycloakToken(auth, { ignoreTls, timeoutMs, forceRefresh = false }) {
  const mode = String(auth.mode || "");
  const tokenUrl = String(auth.tokenUrl || "").trim();
  const clientId = String(auth.clientId || "").trim();
  const clientSecret = String(auth.clientSecret || "");
  const username = String(auth.username || "").trim();
  const password = String(auth.password || "");
  const scope = String(auth.scope || "").trim();

  if (!tokenUrl) throw Object.assign(new Error("Keycloak token URL is required"), { statusCode: 400 });
  if (!clientId) throw Object.assign(new Error("Keycloak client ID is required"), { statusCode: 400 });

  const cacheKey = cacheKeyForAuth({ mode, tokenUrl, clientId, username, scope });
  const cached = tokenCache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAt - Date.now() > 15000) {
    return { accessToken: cached.accessToken, expiresAt: cached.expiresAt, cached: true };
  }

  let body;
  if (mode === "keycloak-password") {
    if (!username || !password) {
      throw Object.assign(new Error("Keycloak username and password are required"), { statusCode: 400 });
    }
    body = formBody({
      grant_type: "password",
      client_id: clientId,
      client_secret: clientSecret,
      username,
      password,
      scope
    });
  } else if (mode === "keycloak-client") {
    if (!clientSecret) {
      throw Object.assign(new Error("Keycloak client secret is required"), { statusCode: 400 });
    }
    body = formBody({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope
    });
  } else {
    throw Object.assign(new Error("Unsupported auth mode"), { statusCode: 400 });
  }

  const response = await performRequest({
    url: tokenUrl,
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded"
    },
    body,
    timeoutMs,
    ignoreTls
  });

  const text = response.bodyBuffer.toString("utf8");
  let tokenPayload;
  try {
    tokenPayload = JSON.parse(text || "{}");
  } catch {
    tokenPayload = {};
  }

  if (response.status < 200 || response.status >= 300) {
    const description = tokenPayload.error_description || tokenPayload.error || text || response.statusText;
    throw Object.assign(new Error(`Keycloak token request failed: ${description}`), {
      statusCode: 502,
      keycloakStatus: response.status,
      keycloakBody: tokenPayload
    });
  }

  if (!tokenPayload.access_token) {
    throw Object.assign(new Error("Keycloak response did not contain access_token"), { statusCode: 502 });
  }

  const expiresIn = Number(tokenPayload.expires_in || 60);
  const expiresAt = Date.now() + Math.max(5, expiresIn - 10) * 1000;
  tokenCache.set(cacheKey, { accessToken: tokenPayload.access_token, expiresAt });

  return { accessToken: tokenPayload.access_token, expiresAt, cached: false };
}

function responsePayload(response, startedAt, authInfo) {
  const contentType = response.headers["content-type"] || "";
  const buffer = response.bodyBuffer;
  const textBody = isTextLike(contentType) ? buffer.toString("utf8") : "";

  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    redirected: response.redirected,
    durationMs: Math.round(performance.now() - startedAt),
    headers: response.headers,
    contentType,
    body: textBody,
    bodyBase64: textBody ? null : buffer.toString("base64"),
    binary: !textBody && buffer.length > 0,
    size: buffer.length,
    auth: authInfo
  };
}

async function handleSend(req, res) {
  let payload;

  try {
    payload = JSON.parse(await readRequestBody(req));
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: "Invalid request payload" });
    return;
  }

  const method = String(payload.method || "GET").toUpperCase();
  const targetUrl = String(payload.url || "").trim();

  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    sendJson(res, 400, { error: "URL is not valid" });
    return;
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    sendJson(res, 400, { error: "Only http and https URLs are supported" });
    return;
  }

  const headers = {};
  for (const [rawName, rawValue] of Object.entries(payload.headers || {})) {
    const name = String(rawName).trim();
    const value = String(rawValue ?? "");
    if (!name || BLOCKED_FORWARD_HEADERS.has(name.toLowerCase())) continue;
    if (name.toLowerCase() === "authorization") continue;
    headers[name] = value;
  }

  const timeoutMs = Number(payload.timeoutMs || 60000);
  const startedAt = performance.now();
  let authInfo = { mode: "auto-keycloak" };

  async function applyAuthorization(forceRefresh = false) {
    delete headers.authorization;
    const token = await getKeycloakToken(AUTO_TOKEN_CONFIG, {
      ignoreTls: Boolean(payload.ignoreTls),
      timeoutMs,
      forceRefresh
    });
    headers.authorization = `Bearer ${token.accessToken}`;
    authInfo = {
      mode: "auto-keycloak",
      source: token.cached ? "keycloak-cache" : "keycloak",
      expiresAt: new Date(token.expiresAt).toISOString()
    };
  }

  async function sendTargetRequest() {
    return performRequest({
      url: targetUrl,
      method,
      headers,
      body: ["GET", "HEAD"].includes(method) ? undefined : payload.body ?? undefined,
      timeoutMs,
      ignoreTls: Boolean(payload.ignoreTls)
    });
  }

  try {
    await applyAuthorization(false);
    let response = await sendTargetRequest();

    if (response.status === 401) {
      await applyAuthorization(true);
      response = await sendTargetRequest();
      authInfo.retriedAfter401 = true;
    }

    sendJson(res, 200, responsePayload(response, startedAt, authInfo));
  } catch (error) {
    sendJson(res, error.statusCode || 502, {
      error: error.message,
      code: error.code || error.cause?.code || "",
      cause: error.cause?.message || "",
      hint: tlsHint(error),
      keycloakStatus: error.keycloakStatus || null,
      keycloakBody: error.keycloakBody || null,
      durationMs: Math.round(performance.now() - startedAt)
    });
  }
}

async function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const safePath = path.normalize(decodeURIComponent(requestUrl.pathname)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath === "/" ? "index.html" : safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME_TYPES[ext] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(file);
  } catch {
    const fallback = await fs.readFile(path.join(PUBLIC_DIR, "index.html"));
    res.writeHead(200, { "content-type": MIME_TYPES[".html"], "cache-control": "no-store" });
    res.end(fallback);
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/send") {
    handleSend(req, res);
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(req, res);
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
});

server.listen(PORT, () => {
  console.log(`Mini Postman is running at http://localhost:${PORT}`);
});
