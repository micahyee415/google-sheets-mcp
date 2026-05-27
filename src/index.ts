/**
 * Google Sheets MCP Server
 *
 * Provides Google Sheets and Drive access for @example.com accounts via Claude.ai.
 * Deployed to Cloud Run in the your-gcp-project GCP project.
 *
 * Architecture (same pattern as salesforce-mcp and github-mcp):
 *   1. Express HTTP server with Google OAuth validation on every /mcp request
 *   2. Per-request McpServer + StreamableHTTPServerTransport (stateless)
 *   3. Google Sheets/Drive API calls made via the user's own OAuth token (per-user, not SA)
 *   4. Write tools restricted to an explicit allowlist — non-allowlisted users get read-only
 *
 * Security decisions:
 *   - Only @example.com accounts can connect (Google OAuth domain check)
 *   - API calls run as the requesting user — Google enforces their own Drive/Sheets permissions
 *   - share_spreadsheet tool is NOT implemented (would allow silent external sharing)
 *   - raw batch_update tool is NOT implemented (unvalidated API passthrough)
 *   - Write tools registered for all authenticated @example.com users — per-user OAuth means
 *     each user can only write to sheets they already have Google permission to edit
 *   - Jordan/Morgan's private sheets are protected by Google — users can only access what they have permission to in Drive
 */

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SheetsClient } from "./sheets-client.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";
import { registerCompareTools } from "./tools/compare.js";
import { verifyGoogleToken, extractBearerToken, AuthError } from "./auth.js";
import { logger } from "./logger.js";
import { RateLimiter } from "./rate-limiter.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const ALLOWED_DOMAIN = process.env.ALLOWED_DOMAIN ?? "example.com";
const SERVER_URL = process.env.SERVER_URL ?? `http://localhost:${PORT}`;
const ALLOWED_ORIGINS = ["https://claude.ai", "https://api.claude.ai"];
const VERSION = "2.4.0";

// Write tools are available to every authenticated @example.com user.
// Per-user OAuth means each user can only edit sheets they already have Google
// permission to edit — the domain check (verifyGoogleToken) is the gate.
logger.info("Write tools enabled for all authenticated @example.com users");

// ─── MCP server factory ───────────────────────────────────────────────────────

/**
 * Creates a fresh McpServer per request (stateless pattern).
 * Registers read, compare, and write tools for every authenticated @example.com user.
 * Per-user OAuth means Google enforces each user's own Drive/Sheets permissions
 * on every write — the user can only modify sheets they already have access to.
 */
function createMcpServer(userEmail: string, accessToken: string): McpServer {
  const server = new McpServer({ name: "gsheets-mcp", version: VERSION });
  const client = new SheetsClient(accessToken);

  registerReadTools(server, client);
  registerCompareTools(server, client);
  registerWriteTools(server, client, userEmail);

  return server;
}

// ─── Express app ──────────────────────────────────────────────────────────────

const rateLimiter = new RateLimiter(60, 60_000);
const registerRateLimiter = new RateLimiter(10, 60_000);
const app = express();
app.use(express.json({ limit: "512kb" }));

// Security headers on all responses
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("Cache-Control", "no-store");
  next();
});

// ─── Health check ─────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", version: VERSION, transport: "http" });
});

// ─── OAuth discovery metadata (RFC 8414) ──────────────────────────────────────

app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json({
    issuer: SERVER_URL,
    authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    token_endpoint: "https://oauth2.googleapis.com/token",
    registration_endpoint: `${SERVER_URL}/register`,
    scopes_supported: ["openid", "email", "profile", "https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive.readonly"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
  });
});

app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: SERVER_URL,
    authorization_servers: [SERVER_URL],
    scopes_supported: ["openid", "email", "profile", "https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive.readonly"],
    bearer_methods_supported: ["header"],
  });
});

app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
  res.json({
    resource: `${SERVER_URL}/mcp`,
    authorization_servers: [SERVER_URL],
    scopes_supported: ["openid", "email", "profile", "https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive.readonly"],
    bearer_methods_supported: ["header"],
  });
});

// ─── Dynamic Client Registration (RFC 7591) ───────────────────────────────────
// Claude.ai calls this to obtain the Google OAuth client credentials it uses
// when redirecting the user through the Google sign-in flow.

app.post("/register", (req, res) => {
  const origin = req.headers.origin;
  const ip = req.ip ?? "unknown";
  const userAgent = req.headers["user-agent"] ?? "unknown";

  // 1. Origin check — only Claude.ai origins or no-origin (server-to-server)
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    logger.warn("Registration rejected — disallowed origin", {
      event: "registration",
      origin,
      ip,
      userAgent,
      allowed: false,
    });
    res.status(403).json({ error: "Registration not allowed from this origin." });
    return;
  }

  // 2. Global rate limit — 10 registrations/minute across all callers
  if (!registerRateLimiter.check("__register__")) {
    const retryAfter = registerRateLimiter.retryAfter("__register__");
    logger.warn("Registration rate limit exceeded", {
      event: "rate_limited",
      ip,
      userAgent,
      retryAfter,
    });
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ error: `Registration rate limit exceeded. Try again in ${retryAfter}s.` });
    return;
  }

  // 3. Validate OAuth credentials are configured
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    res.status(500).json({ error: "OAuth client credentials not configured on server." });
    return;
  }

  const redirectUris: string[] = (req.body?.redirect_uris ?? []).filter(
    (uri: unknown) => typeof uri === "string" && uri.startsWith("https://"),
  );

  // 4. Audit log — successful registration with full context
  logger.info("Dynamic client registration", {
    event: "registration",
    origin: origin ?? "none",
    ip,
    userAgent,
    allowed: true,
  });

  // Returns client_secret to caller — required by MCP OAuth Dynamic Client Registration (RFC 7591).
  // Claude.ai calls this server-to-server (no Origin header) to obtain credentials for the
  // Google sign-in redirect flow. The origin check + rate limit above are the access controls.
  res.status(201).json({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
  });
});

// ─── MCP endpoint ─────────────────────────────────────────────────────────────

app.all(["/", "/mcp"], async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    const origin = req.headers.origin;
    const allowedOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    res.status(204).end();
    return;
  }

  const startMs = Date.now();

  // 1. Extract and validate Google OAuth token — confirms @example.com identity
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    logger.warn("Missing auth token", { statusCode: 401 });
    res.setHeader(
      "WWW-Authenticate",
      `Bearer resource_metadata="${SERVER_URL}/.well-known/oauth-protected-resource"`,
    );
    res.status(401).json({ error: "Missing Authorization header. Use Bearer <Google OAuth token>." });
    return;
  }

  let userEmail: string;
  try {
    const authResult = await verifyGoogleToken(token, ALLOWED_DOMAIN);
    userEmail = authResult.email;
    logger.info("User authenticated", { event: "login", userEmail });
  } catch (err) {
    if (err instanceof AuthError) {
      logger.warn("Auth failed", {
        event: "auth_failure",
        statusCode: err.statusCode,
        reason: err.message,
      });
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    logger.error("Unexpected auth error", { event: "auth_failure", reason: String(err) });
    res.status(500).json({ error: "Authentication failed." });
    return;
  }

  // 2. Per-user rate limiting — 60 requests/minute
  if (!rateLimiter.check(userEmail)) {
    const retryAfter = rateLimiter.retryAfter(userEmail);
    logger.warn("Rate limit exceeded", { event: "rate_limited", userEmail, retryAfter });
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ error: `Rate limit exceeded. Try again in ${retryAfter}s.` });
    return;
  }

  // 3. CORS headers for the actual response
  const origin = req.headers.origin;
  const allowedOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

  // 4. Handle MCP request — fresh server per request (stateless)
  const tool: string | undefined =
    req.body?.method === "tools/call" ? req.body?.params?.name : req.body?.method;

  const server = createMcpServer(userEmail, token);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);

  // SOC 2 CC7.2 audit log — every tool call recorded
  logger.info("Request completed", {
    event: "usage",
    userEmail,
    tool,
    canWrite: true,
    durationMs: Date.now() - startMs,
    statusCode: res.statusCode,
  });
});

// ─── Start server ─────────────────────────────────────────────────────────────

const httpServer = app.listen(PORT, () => {
  logger.info("Google Sheets MCP server ready", { port: PORT });
});

process.on("SIGTERM", () => {
  logger.info("SIGTERM received — draining connections...");
  httpServer.close(() => {
    logger.info("HTTP server closed. Exiting.");
    process.exit(0);
  });
});
