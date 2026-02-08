// Utils imports
const ErrorHandler = require("../utils/ErrorHandler.js");
const SafeUtils = require("../utils/SafeUtils.js");
const Logger = require("../utils/Logger.js");
const ConfigFileLoader = require("../utils/ConfigFileLoader.js");
const DateTime = require("../utils/DateTime.js");

// Node.js built-ins
const { URL } = require("url");
const crypto = require("crypto");

// Constants (inlined)
const DEFAULT_HTTP_TIMEOUT_MS = 30000; // 30 seconds
const DEFAULT_MAX_REQUEST_BYTES = 1_000_000; // 1MB
const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000; // 2MB
const DEFAULT_MAX_WEBHOOK_BYTES = 1_000_000; // 1MB
const DEFAULT_USER_AGENT = process.env.AXCESS_USER_AGENT || "AxcessPaymentGateway";
// Gateway session expires at 30 minutes, using 25 minutes for buffer to ensure sessions
// are considered expired before the gateway expires them, preventing edge cases
const DEFAULT_CHECKOUT_EXPIRY_MINUTES = 25;
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5; // Open circuit after 5 failures
const CIRCUIT_BREAKER_RESET_TIMEOUT_MS = 60000; // Half-open after 60 seconds

// Circuit breaker state (shared across all requests)
const circuitBreaker = {
  state: 'CLOSED', // CLOSED, OPEN, HALF_OPEN
  failureCount: 0,
  lastFailureTime: null,
  successCount: 0, // For half-open state
};

// Helper functions (inlined)
const inFlightAbortControllers = new Set();
let isShuttingDown = false;

function createAxcessError(message, {
  code = "AXCESS_ERROR",
  origin = "Axcess",
  status = null,
  data = undefined,
  cause = undefined,
  raw = undefined,
} = {}) {
  const err = new Error(message);
  err.name = "AxcessError";
  err.code = code;
  err.origin = origin;
  if (status !== null) err.status = status;
  if (data !== undefined) err.data = data;
  if (raw !== undefined) err.raw = raw;
  if (cause) err.cause = cause;
  return err;
}

function parseMimeType(contentType) {
  if (!contentType || typeof contentType !== "string") return "";
  return contentType.split(";")[0].trim().toLowerCase();
}

function isJsonMimeType(mimeType) {
  return mimeType === "application/json" || mimeType.endsWith("+json");
}

function parseRetryAfterMs(retryAfterHeader) {
  if (!retryAfterHeader || typeof retryAfterHeader !== "string") return null;
  const v = retryAfterHeader.trim();
  if (/^\d+$/.test(v)) return Math.max(0, Number(v) * 1000);
  const parsed = Date.parse(v);
  if (!Number.isNaN(parsed)) return Math.max(0, parsed - Date.now());
  return null;
}

function parseRateLimitHeaders(headersObj) {
  const h = headersObj || {};
  const retryAfterMs = parseRetryAfterMs(h["retry-after"] || h["Retry-After"]);
  const limit = h["x-ratelimit-limit"] || h["X-RateLimit-Limit"] || null;
  const remaining = h["x-ratelimit-remaining"] || h["X-RateLimit-Remaining"] || null;
  const reset = h["x-ratelimit-reset"] || h["X-RateLimit-Reset"] || null;
  return {
    retryAfterMs,
    limit: limit !== null ? Number(limit) : null,
    remaining: remaining !== null ? Number(remaining) : null,
    reset: reset !== null ? Number(reset) : null,
  };
}

async function readResponseBodyTextWithLimit(response, maxBytes) {
  if (!response?.body || typeof response.body.getReader !== "function") {
    const t = await response.text();
    if (Buffer.byteLength(t, "utf8") > maxBytes) {
      throw createAxcessError(`Response exceeds max size (${maxBytes} bytes)`, {
        code: "RESPONSE_TOO_LARGE",
        status: response?.status ?? null,
      });
    }
    return t;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const buf = Buffer.from(value);
    total += buf.length;
    if (total > maxBytes) {
      try { reader.cancel(); } catch {}
      throw createAxcessError(`Response exceeds max size (${maxBytes} bytes)`, {
        code: "RESPONSE_TOO_LARGE",
        status: response?.status ?? null,
        data: { maxBytes, actualBytes: total },
      });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function setupGracefulShutdownOnce() {
  if (setupGracefulShutdownOnce._installed) return;
  setupGracefulShutdownOnce._installed = true;

  const shutdown = (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    try {
      Logger.writeLog({
        flag: "AXCESS",
        action: "shutdown",
        message: `Received ${signal}; aborting in-flight HTTP requests`,
        data: { inFlight: inFlightAbortControllers.size },
      });
    } catch {}

    for (const c of Array.from(inFlightAbortControllers)) {
      try { c.abort(); } catch {}
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

setupGracefulShutdownOnce();

/**
 * Convert an object to form-urlencoded string
 * @param {Object} data - Object to convert
 * @returns {string} Form-urlencoded string
 */
function toFormUrlEncoded(data) {
  Logger.debugLog?.(`[Axcess] [toFormUrlEncoded] [START] Converting object to form-urlencoded`);
  
  const cleaned = SafeUtils.sanitizeValidate({
    data: { value: data, type: "object", required: false },
  });
  
  if (!cleaned.data || typeof cleaned.data !== 'object') {
    Logger.debugLog?.(`[Axcess] [toFormUrlEncoded] [EMPTY] Data is empty or not an object`);
    return '';
  }
  
  const params = new URLSearchParams();
  // Use Object.keys() instead of Object.entries() to avoid temporary array allocations
  for (const key of Object.keys(cleaned.data)) {
    const value = cleaned.data[key];
    if (value !== null && value !== undefined) {
      params.append(key, String(value));
    }
  }
  
  const result = params.toString();
  Logger.debugLog?.(`[Axcess] [toFormUrlEncoded] [SUCCESS] Converted to form-urlencoded string`);
  return result;
}

/**
 * Make HTTP request with Bearer token authentication
 * @param {Object} options - Request options
 * @param {string} options.urlString - Request URL
 * @param {string} options.method - HTTP method
 * @param {string} options.bearerToken - Bearer token for authentication
 * @param {Object} options.headers - Additional headers
 * @param {string} options.body - Request body
 * @returns {Promise<Object>} Response object with status, data, and raw
 */
async function httpRequestWithBearer({
  urlString,
  method = 'GET',
  bearerToken,
  headers = {},
  body = null,
  timeout = 30000,
  maxRetries = 3,
  userAgent = DEFAULT_USER_AGENT,
  maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
}) {
  Logger.debugLog?.(`[Axcess] [httpRequestWithBearer] [START] Making HTTP ${method} request`);
  
  const cleaned = SafeUtils.sanitizeValidate({
    urlString: { value: urlString, type: "url", required: true },
    method: { value: method, type: "string", required: false, default: "GET" },
    bearerToken: { value: bearerToken, type: "string", required: true },
    headers: { value: headers, type: "object", required: false, default: {} },
    body: { value: body, type: "string", required: false },
    timeout: { value: timeout, type: "int", required: false, default: 30000 },
    maxRetries: { value: maxRetries, type: "int", required: false, default: 3 },
    userAgent: { value: userAgent, type: "string", required: false, default: DEFAULT_USER_AGENT },
    maxRequestBytes: { value: maxRequestBytes, type: "int", required: false, default: DEFAULT_MAX_REQUEST_BYTES },
    maxResponseBytes: { value: maxResponseBytes, type: "int", required: false, default: DEFAULT_MAX_RESPONSE_BYTES },
  });
  
  // SafeUtils.sanitizeValidate already validates required fields and throws if missing
  // No need for redundant null checks after validation

  if (isShuttingDown) {
    throw createAxcessError("Process is shutting down; refusing new HTTP requests", {
      code: "SHUTTING_DOWN",
      data: { url: cleaned.urlString, method: cleaned.method },
    });
  }
  
  const sanitizedHeaders = SafeUtils.sanitizeObject(cleaned.headers) || {};
  const methodUpper = (cleaned.method || 'GET').toUpperCase();
  const requestOptions = {
    method: methodUpper,
    headers: {
      'Authorization': `Bearer ${cleaned.bearerToken}`,
      'Content-Type': 'application/json',
      'User-Agent': cleaned.userAgent || DEFAULT_USER_AGENT,
      ...sanitizedHeaders
    }
  };
  if (cleaned.body && (methodUpper === 'POST' || methodUpper === 'PUT' || methodUpper === 'PATCH')) {
    const bodySize = Buffer.byteLength(cleaned.body, "utf8");
    if (bodySize > cleaned.maxRequestBytes) {
      throw createAxcessError(`Request body exceeds max size (${cleaned.maxRequestBytes} bytes)`, {
        code: "REQUEST_TOO_LARGE",
        data: { maxBytes: cleaned.maxRequestBytes, actualBytes: bodySize },
      });
    }
    requestOptions.body = cleaned.body;
  }
  
  // Circuit breaker check
  const now = Date.now();
  if (circuitBreaker.state === 'OPEN') {
    // Check if enough time has passed to try half-open
    if (circuitBreaker.lastFailureTime && (now - circuitBreaker.lastFailureTime) >= CIRCUIT_BREAKER_RESET_TIMEOUT_MS) {
      circuitBreaker.state = 'HALF_OPEN';
      circuitBreaker.successCount = 0;
      Logger.debugLog?.(`[Axcess] [httpRequestWithBearer] [CIRCUIT_BREAKER] Circuit breaker transitioning to HALF_OPEN`);
    } else {
      ErrorHandler.addError("Circuit breaker is OPEN - API requests temporarily disabled", {
        code: "CIRCUIT_BREAKER_OPEN",
        origin: "Axcess",
        data: {
          url: cleaned.urlString,
          method: cleaned.method,
          failureCount: circuitBreaker.failureCount,
          lastFailureTime: circuitBreaker.lastFailureTime,
        },
      });
      throw createAxcessError("Circuit breaker is OPEN - API requests temporarily disabled due to repeated failures", {
        code: "CIRCUIT_BREAKER_OPEN",
        data: {
          url: cleaned.urlString,
          method: cleaned.method,
          failureCount: circuitBreaker.failureCount,
          lastFailureTime: circuitBreaker.lastFailureTime,
        },
      });
    }
  }
  
  let lastError;
  const maxAttempts = Math.max(1, Math.min(cleaned.maxRetries, 5)); // Clamp between 1 and 5
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Implement timeout using AbortController for Node.js compatibility
    const controller = new AbortController();
    inFlightAbortControllers.add(controller);
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, cleaned.timeout);
    
    try {
      Logger.debugLog?.(`[Axcess] [httpRequestWithBearer] [REQUEST] Attempt ${attempt}/${maxAttempts} - ${cleaned.method} ${cleaned.urlString}`);
      // Note: fetch() in Node.js 18+ uses undici under the hood, which provides built-in
      // connection pooling with keepAlive enabled by default, reducing latency and overhead
      // for high-throughput scenarios. Connection reuse is handled automatically.
      const response = await fetch(cleaned.urlString, {
        ...requestOptions,
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      inFlightAbortControllers.delete(controller);
      
      const headersObj = Object.fromEntries(response.headers.entries());
      const rateLimit = parseRateLimitHeaders(headersObj);

      // Handle 429 rate limiting (retryable)
      if (response.status === 429 && attempt < maxAttempts) {
        const waitMs =
          rateLimit.retryAfterMs ??
          Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Exponential backoff fallback
        Logger.debugLog?.(`[Axcess] [httpRequestWithBearer] [RATE_LIMIT] 429 received; retrying after ${waitMs}ms`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }

      const contentType = response.headers.get('content-type') || "";
      const mimeType = parseMimeType(contentType);

      const contentLengthHeader = response.headers.get("content-length");
      if (contentLengthHeader && /^\d+$/.test(contentLengthHeader)) {
        const len = Number(contentLengthHeader);
        if (len > cleaned.maxResponseBytes) {
          throw createAxcessError(`Response exceeds max size (${cleaned.maxResponseBytes} bytes)`, {
            code: "RESPONSE_TOO_LARGE",
            status: response.status,
            data: { maxBytes: cleaned.maxResponseBytes, contentLength: len },
          });
        }
      }

      const rawText = await readResponseBodyTextWithLimit(response, cleaned.maxResponseBytes);
    let responseData;
      if (isJsonMimeType(mimeType)) {
        try {
          responseData = rawText ? JSON.parse(rawText) : {};
        } catch (e) {
          throw createAxcessError("Invalid JSON response body", {
            code: "INVALID_JSON_RESPONSE",
            status: response.status,
            data: { mimeType, sample: rawText.slice(0, 200) },
            cause: e,
          });
        }
    } else {
        responseData = rawText;
    }
      
      // Don't retry on 4xx client errors
      if (response.status >= 400 && response.status < 500) {
        Logger.debugLog?.(`[Axcess] [httpRequestWithBearer] [CLIENT_ERROR] Response status: ${response.status} - not retrying`);
        ErrorHandler.addError(`HTTP request failed: Client error ${response.status}`, {
          code: "HTTP_CLIENT_ERROR",
          origin: "Axcess",
          data: {
            url: cleaned.urlString,
            method: cleaned.method,
            status: response.status,
            attempt: attempt,
          },
        });
        throw createAxcessError(`HTTP request failed: Client error ${response.status}`, {
          code: "HTTP_CLIENT_ERROR",
          status: response.status,
          data: { url: cleaned.urlString, method: cleaned.method, attempt },
          raw: responseData,
        });
      }
      
      // Retry on 5xx server errors (unless last attempt)
      if (response.status >= 500 && attempt < maxAttempts) {
        Logger.debugLog?.(`[Axcess] [httpRequestWithBearer] [RETRY] Server error ${response.status} - will retry`);
        clearTimeout(timeoutId);
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Exponential backoff, max 10s
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }
      
      // Update circuit breaker on server errors (5xx)
      if (response.status >= 500) {
        circuitBreaker.failureCount++;
        circuitBreaker.lastFailureTime = Date.now();
        if (circuitBreaker.failureCount >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
          circuitBreaker.state = 'OPEN';
          Logger.debugLog?.(`[Axcess] [httpRequestWithBearer] [CIRCUIT_BREAKER] Circuit breaker OPEN after ${circuitBreaker.failureCount} failures`);
        }
      } else {
        // Success - reset circuit breaker
        if (circuitBreaker.state === 'HALF_OPEN') {
          circuitBreaker.successCount++;
          if (circuitBreaker.successCount >= 2) {
            circuitBreaker.state = 'CLOSED';
            circuitBreaker.failureCount = 0;
            Logger.debugLog?.(`[Axcess] [httpRequestWithBearer] [CIRCUIT_BREAKER] Circuit breaker CLOSED after successful requests`);
          }
        } else {
          circuitBreaker.failureCount = 0;
        }
    }
    
    Logger.debugLog?.(`[Axcess] [httpRequestWithBearer] [SUCCESS] Response status: ${response.status}`);
    
    return {
      status: response.status,
      data: responseData,
      raw: responseData,
      headers: headersObj,
      rateLimit,
    };
  } catch (error) {
      clearTimeout(timeoutId);
      inFlightAbortControllers.delete(controller);
      const errorMessage = error.name === 'AbortError' 
        ? `Request timeout after ${cleaned.timeout}ms`
        : error.message;
      
      // Don't retry on client errors (4xx) or if it's the last attempt
      if ((error.name === 'AbortError' || errorMessage.includes('Client error')) && attempt < maxAttempts) {
        // Timeout errors should be retried, but client errors should not
        if (error.name === 'AbortError') {
          Logger.debugLog?.(`[Axcess] [httpRequestWithBearer] [RETRY] Timeout error - will retry`);
          const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Exponential backoff, max 10s
          await new Promise(resolve => setTimeout(resolve, delayMs));
          lastError = error;
          continue;
        }
      }
      
      // Network errors should be retried (unless last attempt)
      if (attempt < maxAttempts && error.name !== 'AbortError' && !errorMessage.includes('Client error')) {
        Logger.debugLog?.(`[Axcess] [httpRequestWithBearer] [RETRY] Network error: ${errorMessage} - will retry`);
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Exponential backoff, max 10s
        await new Promise(resolve => setTimeout(resolve, delayMs));
        lastError = error;
        continue;
      }
      
      // Last attempt or non-retryable error - update circuit breaker
      circuitBreaker.failureCount++;
      circuitBreaker.lastFailureTime = Date.now();
      if (circuitBreaker.failureCount >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
        circuitBreaker.state = 'OPEN';
        Logger.debugLog?.(`[Axcess] [httpRequestWithBearer] [CIRCUIT_BREAKER] Circuit breaker OPEN after ${circuitBreaker.failureCount} failures`);
      }
      
      ErrorHandler.addError(`HTTP request failed: ${errorMessage}`, {
        code: error.name === 'AbortError' ? "HTTP_REQUEST_TIMEOUT" : "HTTP_REQUEST_FAILED",
      origin: "Axcess",
      data: {
        url: cleaned.urlString,
        method: cleaned.method,
          error: errorMessage,
          timeout: cleaned.timeout,
          attempts: attempt,
          maxAttempts: maxAttempts,
          circuitBreakerState: circuitBreaker.state,
      },
    });
      Logger.debugLog?.(`[Axcess] [httpRequestWithBearer] [ERROR] ${errorMessage} after ${attempt} attempt(s)`);
      if (error && error.name === 'AbortError') {
        throw createAxcessError(`Request timeout after ${cleaned.timeout}ms`, {
          code: "HTTP_REQUEST_TIMEOUT",
          data: { url: cleaned.urlString, method: cleaned.method },
          cause: error,
        });
      }
      throw createAxcessError(`HTTP request failed: ${errorMessage}`, {
        code: "HTTP_REQUEST_FAILED",
        data: { url: cleaned.urlString, method: cleaned.method, attempt, maxAttempts },
        cause: error,
      });
    }
  }
  
  // Should not reach here, but handle edge case
  if (lastError) {
    const errorMessage = lastError.name === 'AbortError' 
      ? `Request timeout after ${cleaned.timeout}ms`
      : lastError.message;
    throw createAxcessError(`HTTP request failed after ${maxAttempts} attempts: ${errorMessage}`, {
      code: lastError.name === 'AbortError' ? "HTTP_REQUEST_TIMEOUT" : "HTTP_REQUEST_FAILED",
      data: { url: cleaned.urlString, method: cleaned.method, maxAttempts },
      cause: lastError,
    });
  }
  throw createAxcessError(`HTTP request failed after ${maxAttempts} attempts`, {
    code: "HTTP_REQUEST_FAILED",
    data: { url: cleaned.urlString, method: cleaned.method, maxAttempts },
  });
}

class Axcess {
  /**
   * @param {object} deps
   * @param {object} deps.paymentGatewayService - injected persistence/service facade (sessions, txns, schedules, tokens, webhooks, entitlements)
   * @param {object} deps.config - required global config
   * @param {string} deps.config.environment - 'test' | 'live'
   * @param {string} deps.config.baseUrl - e.g., 'https://eu-test.oppwa.com'
   * @param {string} deps.config.entityId - Axcess entityId from portal
   * @param {string} deps.config.bearerToken - Bearer token for REST API
   * @param {object} [deps.config.webhook] - webhook decryption & idempotency config
   * @param {string} [deps.config.webhook.secretKey] - base64 or hex secret for AES-256-CBC
   * @param {string} [deps.config.webhook.ivHeaderName='x-axcess-iv'] - header with base64 IV (if required)
   * @param {string} [deps.config.webhook.sigHeaderName='x-axcess-signature'] - signature header name (optional)
   * @param {number} [deps.config.webhook.idempotencyStoreTtlHours=48] - dedupe TTL
   * @param {object} [deps.config.ui]
   * @param {string[]} [deps.config.ui.widgetBrands] - e.g., ['VISA','MASTER','AMEX']
   * @param {string} [deps.config.ui.defaultLocale='en']
   * @param {object} [deps.config.locales] - map app locale -> widget 'lang'
   * @param {object} [deps.config.threeDS]
   * @param {string} [deps.config.threeDS.challengeWindowSize='05'] - per 3DS docs
   * @param {boolean} [deps.config.threeDS.attemptExemption=false]
   * @param {object} [deps.config.session]
   * @param {number} [deps.config.session.checkoutExpiryMinutes=25]
   * @param {number} [deps.config.httpTimeoutMs=30000] - HTTP request timeout in milliseconds (can be overridden per request)
   * @param {object} [deps.options] - future flags
   */
  constructor({ paymentGatewayService, config, options = {} } = {}) {
    Logger.debugLog?.(`[Axcess] [constructor] [START] Initializing Axcess payment gateway`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      paymentGatewayService: { value: paymentGatewayService, type: "object", required: true },
      environment: {
        value: config?.environment,
        type: "string",
        required: true,
      },
      baseUrl: { value: config?.baseUrl, type: "url", required: true },
      entityId: { value: config?.entityId, type: "string", required: true },
      bearerToken: {
        value: config?.bearerToken,
        type: "string",
        required: true,
      },
      merchantBaseUrl: { value: config?.merchantBaseUrl, type: "url", required: false },
      webhook: {
        value: config?.webhook || {},
        type: "object",
        required: false,
        default: {},
      },
      ui: {
        value: config?.ui || {},
        type: "object",
        required: false,
        default: {},
      },
      locales: {
        value: config?.locales || {},
        type: "object",
        required: false,
        default: {},
      },
      threeDS: {
        value: config?.threeDS || {},
        type: "object",
        required: false,
        default: {},
      },
      session: {
        value: config?.session || {},
        type: "object",
        required: false,
        default: {},
      },
      httpTimeoutMs: {
        value: config?.httpTimeoutMs,
        type: "int",
        required: false,
        default: DEFAULT_HTTP_TIMEOUT_MS,
      },
      apiVersion: {
        value: config?.apiVersion,
        type: "string",
        required: false,
        default: "v1",
      },
      schedulingApiVersion: {
        value: config?.schedulingApiVersion,
        type: "string",
        required: false,
        default: "v1",
      },
      schedulingBasePath: {
        value: config?.schedulingBasePath,
        type: "string",
        required: false,
        default: "scheduling",
      },
      userAgent: {
        value: config?.userAgent,
        type: "string",
        required: false,
        default: DEFAULT_USER_AGENT,
      },
      maxRequestBytes: {
        value: config?.maxRequestBytes,
        type: "int",
        required: false,
        default: DEFAULT_MAX_REQUEST_BYTES,
      },
      maxResponseBytes: {
        value: config?.maxResponseBytes,
        type: "int",
        required: false,
        default: DEFAULT_MAX_RESPONSE_BYTES,
      },
      options: {
        value: options || {},
        type: "object",
        required: false,
        default: {},
      },
    });

    if (!cleaned.paymentGatewayService) {
      ErrorHandler.addError("Axcess: paymentGatewayService is required", {
        code: "MISSING_REQUIRED_PARAM",
        origin: "Axcess",
        data: { configProvided: !!config },
      });
      throw createAxcessError("Axcess: paymentGatewayService is required", {
        code: "MISSING_REQUIRED_PARAM",
        data: { configProvided: !!config },
      });
    }

    this.svc = cleaned.paymentGatewayService;

    Logger.debugLog?.(`[Axcess] [constructor] [VALIDATION] Config validated successfully`);

    this.environmentLabel = cleaned.environment;
    // Derive per-instance test mode from environment:
    // - 'live' / 'prod' / 'production' => 'LIVE'
    // - everything else => 'TEST'
    const envLabel = (this.environmentLabel || '').toLowerCase();
    this.testMode = (envLabel === 'live' || envLabel === 'prod' || envLabel === 'production')
      ? 'LIVE'
      : 'TEST';
    this.apiBaseUrl = cleaned.baseUrl.replace(/\/+$/, ""); // trim trailing slash
    this.entityId = cleaned.entityId;
    this.apiBearerToken = cleaned.bearerToken;
    this.baseUrl = cleaned.merchantBaseUrl || 'http://localhost:3000'; // merchant callback URL

    this.webhookConfig = {
      secretKey: cleaned.webhook.secretKey || null,
      ivHeaderName: (
        cleaned.webhook.ivHeaderName || "x-initialization-vector"
      ).toLowerCase(),
      sigHeaderName: (
        cleaned.webhook.sigHeaderName || "x-authentication-tag"
      ).toLowerCase(),
      cipherMode: (
        cleaned.webhook.cipherMode || "GCM"
      ).toUpperCase(), // 'GCM' or 'CBC', defaults to 'GCM'
      idempotencyStoreTtlHours: Number(
        cleaned.webhook.idempotencyStoreTtlHours || 48
      ),
      maxBytes: Number(cleaned.webhook.maxBytes || DEFAULT_MAX_WEBHOOK_BYTES),
    };

    this.uiConfig = {
      widgetBrands: Array.isArray(cleaned.ui.widgetBrands)
        ? cleaned.ui.widgetBrands
        : ["VISA", "MASTER"],
      defaultLocale: cleaned.ui.defaultLocale || "en",
      callbackPath: cleaned.ui.callbackPath || "/payments/axcess/callback",
    };

    const baseUrlTrimmed = String(this.baseUrl || "").replace(/\/+$/, "");
    const callbackPath =
      String(this.uiConfig.callbackPath || "/payments/axcess/callback").startsWith("/")
        ? this.uiConfig.callbackPath
        : `/${this.uiConfig.callbackPath}`;
    this.callbackUrl = `${baseUrlTrimmed}${callbackPath}`;

    this.localeMap = SafeUtils.sanitizeObject(cleaned.locales) || {};
    this.threeDSDefaults = {
      challengeWindowSize: cleaned.threeDS.challengeWindowSize || "05",
      attemptExemption: !!cleaned.threeDS.attemptExemption,
    };
    this.sessionConfig = {
      checkoutExpiryMinutes: Number(
        cleaned.session.checkoutExpiryMinutes || DEFAULT_CHECKOUT_EXPIRY_MINUTES
      ),
    };

    this.httpTimeoutMs = Number(cleaned.httpTimeoutMs) || DEFAULT_HTTP_TIMEOUT_MS;
    this.apiVersion = (cleaned.apiVersion || "v1").trim();
    this.schedulingApiVersion = (cleaned.schedulingApiVersion || "v1").trim();
    this.schedulingBasePath = (cleaned.schedulingBasePath || "scheduling").trim().replace(/^\/+|\/+$/g, "");
    this.userAgent = cleaned.userAgent || DEFAULT_USER_AGENT;
    this.maxRequestBytes = Number(cleaned.maxRequestBytes) || DEFAULT_MAX_REQUEST_BYTES;
    this.maxResponseBytes = Number(cleaned.maxResponseBytes) || DEFAULT_MAX_RESPONSE_BYTES;
    this.options = SafeUtils.sanitizeObject(cleaned.options) || {};

    // In-memory cache for GET requests to reduce redundant API calls
    // Cache TTL: 30 seconds (configurable via options)
    this._responseCache = new Map();
    this._cacheTTL = Number(cleaned.options?.cacheTTL) || 30000; // 30 seconds default

    // Cache Logger methods to reduce optional chaining overhead
    // Check once during construction and store references for faster access
    this._loggerDebugLog = typeof Logger.debugLog === 'function' ? Logger.debugLog.bind(Logger) : null;
    this._loggerWriteLog = typeof Logger.writeLog === 'function' ? Logger.writeLog.bind(Logger) : Logger.writeLog || null;

    if (this._loggerDebugLog) {
      this._loggerDebugLog(`[Axcess] [constructor] [SUCCESS] Axcess initialized with environment: ${this.environmentLabel}`);
    }

    this._writeLog("initialized", "Axcess payment gateway initialized", {
        environment: this.environmentLabel,
        baseUrl: this.apiBaseUrl,
        entityId: this.entityId,
    });
  }

  /**
   * Optimized Logger.debugLog wrapper - uses cached method reference to avoid optional chaining overhead
   * @param {...any} args - arguments to pass to Logger.debugLog
   */
  _debugLog(...args) {
    if (this._loggerDebugLog) {
      this._loggerDebugLog(...args);
    }
  }

  /**
   * Standardized structured log wrapper (enforces schema for Logger.writeLog)
   * @param {string} action
   * @param {string} message
   * @param {object} [data]
   */
  _writeLog(action, message, data = {}) {
    if (this._loggerWriteLog) {
      this._loggerWriteLog({
        flag: "AXCESS",
        action,
        message,
        data,
      });
    }
  }

  /**
   * Canonical timestamp generator (RFC3339, UTC).
   * @returns {string}
   */
  _now() {
    return (
      DateTime.now(DateTime.FORMATS?.RFC3339 || "yyyy-MM-dd'T'HH:mm:ssZZ", "UTC") ||
      new Date().toISOString()
    );
  }

  /**
   * Canonical Unix timestamp (seconds) derived from _now().
   * @returns {number}
   */
  _nowUnixSeconds() {
    return DateTime.toUnixTimestamp(this._now());
  }

  /**
   * Build a payment API URL using configured apiVersion (defaults to v1).
   * @param {string} path - e.g. "/checkouts/abc/payment"
   * @returns {URL}
   */
  _paymentUrl(path) {
    const p = (path || "").startsWith("/") ? path : `/${path || ""}`;
    return new URL(`/${this.apiVersion}${p}`, this.apiBaseUrl);
  }

  /**
   * Build a scheduling API URL using configured schedulingBasePath + schedulingApiVersion.
   * @param {string} path - e.g. "/schedules" or "/schedules/{id}"
   * @returns {URL}
   */
  _schedulingUrl(path) {
    const p = (path || "").startsWith("/") ? path : `/${path || ""}`;
    return new URL(`/${this.schedulingBasePath}/${this.schedulingApiVersion}${p}`, this.apiBaseUrl);
  }

  /**
   * Normalize headers to a lower-cased key map.
   * @param {object} headers
   * @returns {object}
   */
  _normalizeHeaders(headers) {
    const h = {};
    const src = headers && typeof headers === "object" ? headers : {};
    for (const k of Object.keys(src)) {
      h[String(k).toLowerCase()] = src[k];
    }
    return h;
  }

  /**
   * Validate incoming Content-Type when present (webhooks).
   * Accepts application/json, text/plain, and application/octet-stream (encrypted/raw bodies).
   * @param {object} headersLower - normalized lower-cased headers
   */
  _assertAllowedIncomingContentType(headersLower) {
    const contentType = headersLower?.["content-type"];
    if (!contentType) return; // allow missing header (common in some gateways)
    const mimeType = parseMimeType(String(contentType));
    const allowed = new Set(["application/json", "text/plain", "application/octet-stream"]);
    if (!allowed.has(mimeType) && !isJsonMimeType(mimeType)) {
      throw createAxcessError(`Unsupported Content-Type: ${mimeType}`, {
        code: "UNSUPPORTED_CONTENT_TYPE",
        data: { contentType },
      });
    }
  }

  /**
   * Get cached response for a GET request if available and not expired
   * @param {string} cacheKey - unique cache key (typically the full URL)
   * @returns {object|null} - cached response or null if not found/expired
   */
  _getCachedResponse(cacheKey) {
    const cached = this._responseCache.get(cacheKey);
    if (!cached) {
      return null;
    }
    
    const now = Date.now();
    if (now - cached.timestamp > this._cacheTTL) {
      // Cache expired, remove it
      this._responseCache.delete(cacheKey);
      return null;
    }
    
    return cached.data;
  }

  /**
   * Store response in cache for GET requests
   * @param {string} cacheKey - unique cache key (typically the full URL)
   * @param {object} responseData - response data to cache
   */
  _setCachedResponse(cacheKey, responseData) {
    this._responseCache.set(cacheKey, {
      data: responseData,
      timestamp: Date.now(),
    });
    
    // Clean up expired entries periodically (every 100 entries to avoid overhead)
    if (this._responseCache.size > 100) {
      const now = Date.now();
      for (const [key, value] of this._responseCache.entries()) {
        if (now - value.timestamp > this._cacheTTL) {
          this._responseCache.delete(key);
        }
      }
    }
  }

  /**
   * Build standardized error message in consistent format: [Component] [Action] Failed: reason
   * @param {string} component - component name (e.g., "Axcess", "PaymentGateway")
   * @param {string} action - action that failed (e.g., "createCheckoutSession", "processPayment")
   * @param {string} reason - reason for failure
   * @returns {string} - standardized error message
   */
  _buildErrorMessage(component, action, reason) {
    return `${component} [${action}] Failed: ${reason}`;
  }

  /**
   * Check if a required service method exists and throw descriptive error if missing
   * @param {string} methodName - name of the service method
   * @param {boolean} required - whether the method is required (default: true)
   * @returns {boolean} - true if method exists, false if optional and missing
   */
  _checkServiceMethod(methodName, required = true) {
    if (typeof this.svc[methodName] !== 'function') {
      if (required) {
        const errorMsg = this._buildErrorMessage("Axcess", "checkServiceMethod", `Required service method '${methodName}' is not implemented`);
        ErrorHandler.addError(errorMsg, {
          code: "MISSING_SERVICE_METHOD",
          origin: "Axcess",
          data: { methodName, serviceType: typeof this.svc },
        });
        throw createAxcessError(errorMsg, {
          code: "MISSING_SERVICE_METHOD",
          data: { methodName, serviceType: typeof this.svc },
        });
      }
      return false;
    }
    return true;
  }

  /**
   * Generate a UUID-based idempotency key for payment requests
   * @param {string} [providedKey] - optional idempotency key provided by caller
   * @returns {string} - idempotency key
   */
  _generateIdempotencyKey(providedKey = null) {
    if (providedKey && typeof providedKey === 'string' && providedKey.trim().length > 0) {
      return providedKey.trim();
    }
    // Generate UUID v4 - use crypto.randomUUID() if available (Node.js 14.17.0+), otherwise generate manually
    if (crypto.randomUUID) {
      return crypto.randomUUID();
    }
    // Fallback UUID generation for older Node.js versions
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /**
   * Get reusable validation configs for common parameter patterns
   * These can be spread into SafeUtils.sanitizeValidate calls to reduce duplication
   * Example: SafeUtils.sanitizeValidate({ ...this._getPaymentParams(params), ...otherParams })
   * @param {object} params - the params object containing values to validate
   * @returns {object} - validation config objects for common patterns
   */
  _getCommonValidationSchemas(params) {
    return {
      // Common payment parameters (amount, currency)
      paymentParams: {
        amount: { value: params.amount, type: "float", required: true },
        currency: { value: params.currency, type: "string", required: true },
      },
      // User and order identifiers
      userOrderParams: {
        userId: { value: params.userId, type: "string", required: true },
        orderId: { value: params.orderId, type: "string", required: true },
      },
      // Common optional S2S parameters
      s2SOptionalParams: {
        customer: { value: params.customer || {}, type: "object", required: false, default: {} },
        billing: { value: params.billing || {}, type: "object", required: false, default: {} },
        threeDSParams: { value: params.threeDSParams || {}, type: "object", required: false, default: {} },
        idempotencyKey: { value: params.idempotencyKey, type: "string", required: false },
      },
      // Common optional parameters
      optionalParams: {
        timeout: { value: params.timeout, type: "int", required: false },
        idempotencyKey: { value: params.idempotencyKey, type: "string", required: false },
        userId: { value: params.userId, type: "string", required: false },
      },
    };
  }

  _getCurrencyDecimals(currency) {
    const c = String(currency || "").toUpperCase().slice(0, 3);
    // Common zero-decimal currencies (ISO 4217)
    const zero = new Set(["JPY", "KRW", "VND", "CLP", "PYG", "UGX", "RWF", "XAF", "XOF", "XPF"]);
    if (zero.has(c)) return 0;
    // Common three-decimal currencies (ISO 4217)
    const three = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);
    if (three.has(c)) return 3;
    return 2;
  }

  _formatAmount(amount, currency) {
    const dec = this._getCurrencyDecimals(currency);
    const n = Number(amount);
    if (!Number.isFinite(n)) return null;
    return n.toFixed(dec);
  }

  /* ============================================================================
   * SECTION A — Copy&Pay Widget (no iframe; script-based widget)
   * Docs:
   *  - Widget: https://axcessms.docs.oppwa.com/integrations/widget
   *  - Widget API: https://axcessms.docs.oppwa.com/integrations/widget/api
   *  - Customization: https://axcessms.docs.oppwa.com/integrations/widget/customization
   *  - Advanced Options: https://axcessms.docs.oppwa.com/integrations/widget/advanced-options
   * ========================================================================== */

  /**
   * Create (or reuse) a widget checkout session. Persists via paymentGatewayService.
   * @param {object} params
   * @param {string} params.userId - your user id
   * @param {string} params.orderId - your order id
   * @param {number|string} params.amount - e.g., 24.99
   * @param {string} params.currency - ISO 4217 (e.g., 'USD')
   * @param {string} [params.paymentType='DB'] - 'DB' (debit/purchase) | 'PA' (preauth)
   * @param {object} [params.customer] - optional customer fields to include in metadata
   * @param {object} [params.metadata] - optional metadata to attach to session
   * @param {number} [params.timeout] - optional request timeout in milliseconds (overrides instance default)
   * @param {string} [params.idempotencyKey] - optional idempotency key for request deduplication
   * @returns {Promise<{checkoutId:string, redirectUrl:string, sessionId:string}>}
   *
   * Axcess Docs: Widget / API
   * https://axcessms.docs.oppwa.com/integrations/widget
   * https://axcessms.docs.oppwa.com/integrations/widget/api
   */
  async createCheckoutSession(params = {}) {
    Logger.debugLog?.(`[Axcess] [createCheckoutSession] [START] Creating checkout session`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      userId: { value: params.userId, type: "string", required: true },
      orderId: { value: params.orderId, type: "string", required: true },
      amount: { value: params.amount, type: "float", required: true },
      currency: { value: params.currency, type: "string", required: true },
      paymentType: {
        value: params.paymentType || "DB",
        type: "string",
        required: true,
      },
      customer: {
        value: params.customer || {},
        type: "object",
        required: false,
        default: {},
      },
      metadata: {
        value: params.metadata || {},
        type: "object",
        required: false,
        default: {},
      },
      billing: {
        value: params.billing || {},
        type: "object",
        required: false,
        default: {},
      },
      browser: {
        value: params.browser || {},
        type: "object",
        required: false,
        default: {},
      },
      timeout: { value: params.timeout, type: "int", required: false },
      idempotencyKey: {
        value: params.idempotencyKey,
        type: "string",
        required: false,
      },
    });
    
    Logger.debugLog?.(`[Axcess] [createCheckoutSession] [VALIDATION] Input validated: ${JSON.stringify({ userId: cleaned.userId, orderId: cleaned.orderId, amount: cleaned.amount, currency: cleaned.currency })}`);
    
    // Reuse any existing "pending" session within TTL
    const existing =
      (await this.svc.getSessionsBy?.("orderId", cleaned.orderId)) || [];
    Logger.debugLog?.(`[Axcess] [createCheckoutSession] [SESSION_CHECK] Found ${existing.length} existing sessions`);
    const reusable = existing.find((s) => this.isCheckoutSessionValid(s));
    if (reusable) {
      Logger.debugLog?.(`[Axcess] [createCheckoutSession] [REUSE] Reusing existing session: ${reusable.id}`);
      this._writeLog("reuseCheckoutSession", "Using existing pending Axcess checkout session", {
          sessionId: reusable.id,
          orderId: cleaned.orderId,
          userId: cleaned.userId,
      });
      const redirectUrl = this._paymentUrl(`/checkouts/${encodeURIComponent(reusable.checkoutId)}/payment`);
      return {
        checkoutId: reusable.checkoutId,
        redirectUrl: redirectUrl.toString(),
        sessionId: reusable.id,
      };
    }

    // Generate idempotency key if not provided
    const idempotencyKey = this._generateIdempotencyKey(cleaned.idempotencyKey);
    Logger.debugLog?.(`[Axcess] [createCheckoutSession] [IDEMPOTENCY] Using idempotency key: ${idempotencyKey}`);

    // Create new checkout with proper 3DS parameters
    const endpoint = this._paymentUrl("/checkouts").toString();

    // Prepare the request payload (no hardcoded test customer / billing / browser data)
    const customer = SafeUtils.sanitizeObject(cleaned.customer) || {};
    const billing = SafeUtils.sanitizeObject(cleaned.billing) || {};
    const browser = SafeUtils.sanitizeObject(cleaned.browser) || {};

    const bodyParams = {
      entityId: this.entityId,
      amount: this._formatAmount(cleaned.amount, cleaned.currency),
      currency: cleaned.currency,
      paymentType: cleaned.paymentType,
      merchantTransactionId: cleaned.orderId,
      merchantCustomerId: cleaned.userId,
      // Customer / billing / browser are optional and MUST come from caller input (no hardcoded defaults)
      ...(Object.keys(customer).length ? { customer } : {}),
      ...(Object.keys(billing).length ? { billing } : {}),
      ...(Object.keys(browser).length ? { browser } : {}),

      // 3DS configuration
      threeDSecure: {
        ...(this.testMode !== 'LIVE' ? { challengeIndicator: 4 } : {}), // Force challenge flow only in test mode
        authenticationIndicator: 1,
        amount: cleaned.amount, // Authentication amount
        currency: cleaned.currency // Authentication currency
      },

      // Custom parameters for 3DS testing and risk assessment
      customParameters: {
        // Risk assessment parameters (always included)
        'TransactionType': '01', // Goods/Service Purchase
        'DeliveryTimeframe': '01', // Electronic Delivery
        'ReorderItemsIndicator': '01', // First time ordered
        'PreOrderPurchaseIndicator': '01', // Merchandise available
        'GiftCardAmount': '0',
        'GiftCardCurrency': cleaned.currency,
        'GiftCardCount': '0',
        // Test-only 3DS parameters (only included in test mode)
        ...(this.testMode !== 'LIVE' ? {
          '3DS2_enrolled': 'true', // Force 3DS enrollment for any test card
          '3DS2_flow': 'challenge' // Force challenge flow for testing
        } : {})
      },

      // Redirect URLs
      redirect: {
        url: this.callbackUrl
      }
    };

    Logger.debugLog?.(`[Axcess] [createCheckoutSession] [REQUEST] Creating checkout with 3DS params: ${JSON.stringify(bodyParams)}`);

    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      userAgent: this.userAgent,
      maxRequestBytes: this.maxRequestBytes,
      maxResponseBytes: this.maxResponseBytes,
      headers: { 
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(bodyParams),
      timeout: cleaned.timeout || this.httpTimeoutMs,
    });
    // console.log("res", res);

    if (res.status < 200 || res.status >= 300 || !res.data?.id) {
      const errorMsg = this._buildErrorMessage("Axcess", "createCheckoutSession", `HTTP ${res.status} - ${res.raw?.result?.description || 'Unknown error'}`);
      ErrorHandler.addError(errorMsg, {
        code: "CHECKOUT_CREATE_FAILED",
        origin: "Axcess",
        data: {
        status: res.status,
          raw: res.raw,
          orderId: cleaned.orderId,
          userId: cleaned.userId,
        },
      });
      Logger.debugLog?.(`[Axcess] [createCheckoutSession] [ERROR] Failed to create checkout: status ${res.status}`);
      throw createAxcessError(errorMsg, {
        code: "CHECKOUT_CREATE_FAILED",
        status: res.status,
        raw: res.raw,
        data: { orderId: cleaned.orderId, userId: cleaned.userId },
      });
    }

    const checkoutId = res.data.id;
    const redirectUrl = this._paymentUrl(`/checkouts/${encodeURIComponent(checkoutId)}/payment`).toString();
    // console.log("redirectUrl", redirectUrl);
    const sessionId = `session#${cleaned.orderId}`;
    const sessionRecord = {
      id: sessionId,
      pk: `user#${cleaned.userId}`, // required partition key
      sk: `session#${cleaned.orderId}`,
      gateway: "axcess",
      userId: cleaned.userId,
      orderId: cleaned.orderId,
      order_id: cleaned.orderId, // Add this for GSI compatibility
      checkoutId,
      status: "pending",
      amount: cleaned.amount,
      currency: cleaned.currency,
      paymentType: cleaned.paymentType,
      metadata: cleaned.metadata,
      customer: cleaned.customer,
      createdAt: this._now(),
      updatedAt: this._now(),
      version: 1, // Optimistic locking version number
    };

    this._checkServiceMethod('saveSession', true);
    await this.svc.saveSession(sessionRecord);

    Logger.debugLog?.(`[Axcess] [createCheckoutSession] [SUCCESS] Checkout session created: ${checkoutId}`);

    this._writeLog("createCheckoutSession", "Axcess checkout created", {
        checkoutId,
        sessionId: sessionRecord.id,
        orderId: cleaned.orderId,
        userId: cleaned.userId,
        amount: cleaned.amount,
        currency: cleaned.currency,
    });
    return { checkoutId, redirectUrl, sessionId: sessionRecord.id };
  }

  /**
   * Check if a checkout session is still valid ("pending" and within configured TTL).
   * @param {object} session - session record
   * @returns {boolean}
   */
  isCheckoutSessionValid(session) {
    Logger.debugLog?.(`[Axcess] [isCheckoutSessionValid] [START] Validating session`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      session: { value: session, type: "object", required: false },
    });
    
    if (!cleaned.session || cleaned.session.status !== "pending" || !cleaned.session.createdAt) {
      Logger.debugLog?.(`[Axcess] [isCheckoutSessionValid] [INVALID] Session is invalid or expired`);
      return false;
    }
    
    const ms = Number(this.sessionConfig.checkoutExpiryMinutes) * 60 * 1000;
    const sessionTimestamp = DateTime.parseDateToTimestamp(cleaned.session.createdAt);
    const currentTimestamp = this._nowUnixSeconds();
    const isValid = (currentTimestamp - sessionTimestamp) < (ms / 1000);
    
    Logger.debugLog?.(`[Axcess] [isCheckoutSessionValid] [RESULT] Session valid: ${isValid}`);
    return isValid;
  }

  /**
   * Purge expired sessions for a given user or order id.
   * @param {object} params
   * @param {'userId'|'orderId'} params.by
   * @param {string} params.value
   * @returns {Promise<number>}
   */
  async purgeExpiredSessions(params = {}) {
    Logger.debugLog?.(`[Axcess] [purgeExpiredSessions] [START] Purging expired sessions`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      by: { value: params.by, type: "string", required: true },
      value: { value: params.value, type: "string", required: true },
    });
    
    Logger.debugLog?.(`[Axcess] [purgeExpiredSessions] [VALIDATION] Input validated: by=${cleaned.by}, value=${cleaned.value}`);
    
    const sessions =
      (await this.svc.getSessionsBy?.(cleaned.by, cleaned.value)) || [];
    
    Logger.debugLog?.(`[Axcess] [purgeExpiredSessions] [SESSION_CHECK] Found ${sessions.length} sessions to check`);
    
    let purged = 0;
    for (const s of sessions) {
      if (!this.isCheckoutSessionValid(s)) {
        await this.svc.deleteSession?.(s.id);
        purged++;
        Logger.debugLog?.(`[Axcess] [purgeExpiredSessions] [DELETE] Deleted expired session: ${s.id}`);
      }
    }
    
    Logger.debugLog?.(`[Axcess] [purgeExpiredSessions] [SUCCESS] Purged ${purged} expired sessions`);
    
    this._writeLog("purgeExpiredSessions", "Purged expired sessions", {
        by: cleaned.by,
        value: cleaned.value,
        totalSessions: sessions.length,
        purgedCount: purged,
    });
    
    return purged;
  }

  /**
   * Return Copy&Pay widget HTML snippet (script + minimal form). No iframe.
   * The consumer should validate DOM presence before inserting this HTML.
   *
   * @param {object} params
   * @param {string} params.checkoutId - ID returned by createCheckoutSession
   * @param {string} [params.locale] - app locale; mapped to widget 'lang'
   * @param {string[]} [params.brands] - e.g., ['VISA','MASTER']
   * @returns {string} HTML snippet
   *
   * Docs: Widget / API / Customization / Advanced Options
   * https://axcessms.docs.oppwa.com/integrations/widget
   */
  getPaymentWidgetHtml(params = {}) {
    Logger.debugLog?.(`[Axcess] [getPaymentWidgetHtml] [START] Generating payment widget HTML`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      checkoutId: { value: params.checkoutId, type: "string", required: true },
      locale: {
        value: params.locale || this.uiConfig.defaultLocale,
        type: "string",
        required: true,
      },
      brands: {
        value: params.brands || this.uiConfig.widgetBrands,
        type: "array",
        required: false,
        default: this.uiConfig.widgetBrands,
      },
    });

    Logger.debugLog?.(`[Axcess] [getPaymentWidgetHtml] [VALIDATION] Input validated: checkoutId=${cleaned.checkoutId}, locale=${cleaned.locale}`);

    const widgetLang =
      this.resolveWidgetLanguage(cleaned.locale) || this.uiConfig.defaultLocale;
    const brandsParam =
      Array.isArray(cleaned.brands) && cleaned.brands.length
        ? `data-brands="${cleaned.brands.join(" ")}"`
        : "";

    // The actual DOM insertion is up to the caller; we return a string.
    // IMPORTANT: Copy&Pay is script-based; not an <iframe>.
    const widgetScriptUrl = this._paymentUrl("/paymentWidgets.js");
    widgetScriptUrl.searchParams.set("checkoutId", cleaned.checkoutId);
    const html = [
      `<script src="${widgetScriptUrl.toString()}" async></script>`,
      `<form action="${this.callbackUrl}" class="paymentWidgets" data-lang="${widgetLang}" ${brandsParam}></form>`,
    ].join("\n");
    
    Logger.debugLog?.(`[Axcess] [getPaymentWidgetHtml] [SUCCESS] Generated payment widget HTML`);
    
    return html;
  }

  /**
   * Handle the redirect callback from Copy&Pay and persist the transaction result.
   * Supports both checkout ID and resourcePath patterns, with enhanced 3DS support.
   * @param {object} params
   * @param {string} [params.id] - checkout ID (preferred if provided)
   * @param {string} [params.resourcePath] - provided by Axcess on return (used if id not provided)
   * @param {string} params.orderId - your order id
   * @param {string} params.userId - your user id
   * @param {string} [params.PaRes] - Payment Authentication Response for 3DS callback
   * @param {string} [params.MD] - Merchant Data for 3DS callback
   * @returns {Promise<{status:string, resultCode:string, payload:object}>}
   *
   * Docs: Widget API (reading payment result via resourcePath)
   * https://axcessms.docs.oppwa.com/integrations/widget/api
   */
  async handleRedirectCallback(params = {}) {
    const cleaned = SafeUtils.sanitizeValidate({
      id: { value: params.id, type: "string", required: false },
      resourcePath: { value: params.resourcePath, type: "string", required: false },
      orderId: { value: params.orderId, type: "string", required: true },
      userId: { value: params.userId, type: "string", required: true },
      PaRes: { value: params.PaRes, type: "string", required: false },
      MD: { value: params.MD, type: "string", required: false },
    });

    if (!cleaned.id && !cleaned.resourcePath) {
      ErrorHandler.addError("handleRedirectCallback requires either 'id' or 'resourcePath'", {
        code: "MISSING_REQUIRED_PARAM",
        origin: "Axcess",
        data: { params },
      });
      throw createAxcessError("handleRedirectCallback requires either 'id' or 'resourcePath'", {
        code: "MISSING_REQUIRED_PARAM",
        data: { params },
      });
    }

    Logger.debugLog?.(`[Axcess] [handleRedirectCallback] [VALIDATION] Input validated: id=${cleaned.id || 'null'}, resourcePath=${cleaned.resourcePath || 'null'}, orderId=${cleaned.orderId}, userId=${cleaned.userId}`);

    try {
      const statusRes = await this._fetchRedirectStatus(cleaned);
      const normalized = this._normalizePaymentResult(statusRes.data);
      const rawResult = statusRes.data?.result;

      if (this._is3DSAuthenticationRequired(normalized, rawResult)) {
        return this._build3DSRequiredResponse(cleaned, statusRes, normalized, rawResult);
      }

      if (cleaned.PaRes) {
        return await this._handlePaResRedirect3DSCallback(cleaned);
      }

      const txn = this._buildRedirectTxn(cleaned, statusRes, normalized);
      await this._persistRedirectTxnAndSideEffects(cleaned, txn, normalized);
      await this._updateSessionsAfterRedirect(cleaned, txn, normalized);

      this._writeLog("handleRedirectCallback", "Redirect callback processed", {
        orderId: cleaned.orderId,
        userId: cleaned.userId,
        status: txn.status,
        resultCode: normalized.resultCode,
        amount: normalized.amount,
        currency: normalized.currency,
      });

      return {
        success: txn.status === "success",
        status: (txn.status || "").toUpperCase(),
        resultCode: normalized.resultCode || "",
        amount: normalized.amount,
        currency: normalized.currency,
        reason: normalized.description || (normalized.approved ? "Payment successful" : normalized.uiMessage),
        payload: statusRes.data,
        threeDS: txn.threeDS,
      };
    } catch (error) {
      ErrorHandler.addError("Redirect callback processing failed", {
        code: "REDIRECT_CALLBACK_FAILED",
        origin: "Axcess",
        data: {
          error: error.message,
          id: cleaned.id,
          resourcePath: cleaned.resourcePath,
          orderId: cleaned.orderId,
        },
      });
      Logger.debugLog?.(`[Axcess] [handleRedirectCallback] [ERROR] Redirect callback processing failed: ${error.message}`);
      throw createAxcessError(`Redirect callback failed: ${error.message}`, {
        code: "REDIRECT_CALLBACK_FAILED",
        data: { id: cleaned.id, resourcePath: cleaned.resourcePath, orderId: cleaned.orderId },
        cause: error,
      });
    }
  }

  async _fetchRedirectStatus(cleaned) {
      if (cleaned.id) {
      const requestUrl = this._paymentUrl(`/checkouts/${encodeURIComponent(cleaned.id)}/payment`);
        requestUrl.searchParams.set('entityId', this.entityId);
      return await httpRequestWithBearer({
          urlString: requestUrl.toString(),
          method: 'GET',
          bearerToken: this.apiBearerToken,
        userAgent: this.userAgent,
        maxRequestBytes: this.maxRequestBytes,
        maxResponseBytes: this.maxResponseBytes,
        headers: { 'Content-Type': 'application/json' },
        timeout: this.httpTimeoutMs,
      });
    }
    return await this.getPaymentStatus(cleaned.resourcePath, cleaned.orderId);
  }

  _is3DSAuthenticationRequired(normalized, result) {
    return (
      normalized.resultCode === '800.400.500' ||
          normalized.resultCode === '800.400.501' || 
          result?.code === '800.400.500' || 
      (result?.description && result.description.includes('3DS')) ||
      result?.code === '100.390.106'
    );
  }

  _build3DSRequiredResponse(cleaned, statusRes, normalized, result) {
    Logger.debugLog?.(`[Axcess] [handleRedirectCallback] [3DS_REQUIRED] 3DS authentication required for payment`);
        const redirect = statusRes.data?.redirect;
    const resultCode = normalized.resultCode || result?.code;
        if (redirect && redirect.url) {
      this._writeLog("handleRedirectCallback", "3DS authentication required", {
          orderId: cleaned.orderId,
          userId: cleaned.userId,
        resultCode,
      });
      return {
            success: false,
            requires3DS: true,
            redirectUrl: redirect.url,
            redirectParams: redirect.parameters,
            orderId: cleaned.orderId,
            userId: cleaned.userId,
        message: '3DS authentication required - redirecting to bank',
          };
    }
          return {
            success: false,
        requires3DS: true,
        redirectUrl: normalized.redirectUrl,
        redirectParams: normalized.redirectParams,
        orderId: cleaned.orderId,
            userId: cleaned.userId,
      message: '3DS authentication required but not properly configured',
      };
    }

  async _handlePaResRedirect3DSCallback(cleaned) {
        let checkoutId = cleaned.id || cleaned.resourcePath?.match(/\/checkouts\/([^\/]+)/)?.[1];
        if (!checkoutId && cleaned.orderId) {
          const sessions = (await this.svc.getSessionsBy?.("orderId", cleaned.orderId)) || [];
          if (sessions.length > 0 && sessions[0].checkoutId) {
            checkoutId = sessions[0].checkoutId;
          }
        }
        if (!checkoutId) {
      throw createAxcessError("Cannot process 3DS callback: checkoutId not found", {
            code: "MISSING_CHECKOUT_ID",
            data: { id: cleaned.id, resourcePath: cleaned.resourcePath, orderId: cleaned.orderId },
          });
        }
      return await this.handle3DSCallback({
      checkoutId,
        PaRes: cleaned.PaRes,
        MD: cleaned.MD,
        orderId: cleaned.orderId,
      userId: cleaned.userId,
    });
  }

  _buildRedirectTxn(cleaned, statusRes, normalized) {
    const currentTimestamp = this._nowUnixSeconds();
    return {
      pk: `user#${cleaned.userId}`,
      sk: `ORDER#${cleaned.orderId}#${currentTimestamp}`,
      gateway: "axcess",
      orderId: cleaned.orderId,
      userId: cleaned.userId,
      gatewayTxnId: normalized.id || null,
      amount: normalized.amount || null,
      currency: normalized.currency || null,
      status: normalized.approved ? "success" : normalized.pending ? "pending" : "failed",
      code: normalized.resultCode || null,
      uiMessage: normalized.uiMessage,
      raw: statusRes.data,
      responseHeaders: statusRes?.headers || null,
      rateLimit: statusRes?.rateLimit || null,
      createdAt: this._now(),
        threeDS: statusRes.data?.result?.threeDS ? {
          authentication: statusRes.data.result.threeDS.authentication,
          eci: statusRes.data.result.threeDS.eci,
          cavv: statusRes.data.result.threeDS.cavv,
          xid: statusRes.data.result.threeDS.xid,
        enrolled: statusRes.data.result.threeDS.enrolled,
      } : null,
      };
  }

  async _persistRedirectTxnAndSideEffects(cleaned, txn) {
      this._checkServiceMethod('saveTransaction', true);
      await this.svc.saveTransaction(txn);

    if (txn.status === "success") {
        if (this._checkServiceMethod('grantAccess', false)) {
          try {
            await this.svc.grantAccess({ txn });
          } catch (entitlementError) {
            ErrorHandler.addError("Failed to grant access after successful transaction", {
              code: "ENTITLEMENT_GRANT_FAILED",
              origin: "Axcess",
            data: { orderId: cleaned.orderId, userId: cleaned.userId, gatewayTxnId: txn.gatewayTxnId, error: entitlementError.message },
          });
          }
        }
    } else if (txn.status === "failed") {
        if (this._checkServiceMethod('denyAccess', false)) {
          try {
            await this.svc.denyAccess({ txn });
          } catch (entitlementError) {
            ErrorHandler.addError("Failed to deny access after failed transaction", {
              code: "ENTITLEMENT_DENY_FAILED",
              origin: "Axcess",
            data: { orderId: cleaned.orderId, userId: cleaned.userId, gatewayTxnId: txn.gatewayTxnId, error: entitlementError.message },
          });
        }
      }
    }
  }

  async _updateSessionsAfterRedirect(cleaned, txn, normalized) {
    const sessions = (await this.svc.getSessionsBy?.("orderId", cleaned.orderId)) || [];
    for (const s of sessions) {
      if (s.checkoutId && normalized.id && s.status === "pending") {
          const currentVersion = s.version || 1;
        await this.svc.saveSession?.({
          ...s,
          status: txn.status,
          updatedAt: this._now(),
          version: currentVersion + 1,
          expectedVersion: currentVersion,
        });
      }
    }
  }

  /**
   * GET payment status by resourcePath returned from Axcess (Copy&Pay).
   * @param {string} resourcePath
   * @param {string} [orderId=null] - optional order ID for session lookup
   * @param {number} [timeout] - optional request timeout in milliseconds (overrides instance default)
   * @returns {Promise<{status:number,data:object,raw:string}>}
   *
   * Docs: Widget API
   * https://axcessms.docs.oppwa.com/integrations/widget/api
   */
  async getPaymentStatus(resourcePath, orderId = null, timeout = null) {
    Logger.debugLog?.(`[Axcess] [getPaymentStatus] [START] Getting payment status`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      resourcePath: { value: resourcePath, type: "string", required: true },
      orderId: { value: orderId, type: "string", required: false },
      timeout: { value: timeout, type: "int", required: false },
    });

    Logger.debugLog?.(`[Axcess] [getPaymentStatus] [VALIDATION] Input validated: resourcePath=${cleaned.resourcePath}, orderId=${cleaned.orderId || 'null'}`);

    const url = new URL(this.apiBaseUrl + cleaned.resourcePath);
    url.searchParams.set("entityId", this.entityId);

    // Try to get original payment details from session if orderId is provided
    if (cleaned.orderId) {
      Logger.debugLog?.(`[Axcess] [getPaymentStatus] [SESSION_LOOKUP] Looking up session for orderId: ${cleaned.orderId}`);
      const sessions = (await this.svc.getSessionsBy?.("orderId", cleaned.orderId)) || [];
      Logger.debugLog?.(`[Axcess] [getPaymentStatus] [SESSION_LOOKUP] Found ${sessions.length} sessions`);

      const session = sessions.find(s => s.status === "pending");
      Logger.debugLog?.(`[Axcess] [getPaymentStatus] [SESSION_LOOKUP] Pending session found: ${session ? 'Yes' : 'No'}`);

      if (session && session.amount && session.currency && session.paymentType) {
        Logger.debugLog?.(`[Axcess] [getPaymentStatus] [SESSION_PARAMS] Using session parameters: ${JSON.stringify({
          paymentType: session.paymentType,
          currency: session.currency,
          amount: session.amount
        })}`);
        url.searchParams.set("paymentType", session.paymentType);
        url.searchParams.set("currency", session.currency);
        url.searchParams.set("amount", session.amount.toString());
      } else {
        Logger.debugLog?.(`[Axcess] [getPaymentStatus] [DEFAULT_PARAMS] Session not found or missing parameters, using defaults`);
        // Fallback to default values if session not found
        url.searchParams.set("paymentType", "DB");
        url.searchParams.set("currency", "USD");
        url.searchParams.set("amount", "32.39");
      }
    } else {
      Logger.debugLog?.(`[Axcess] [getPaymentStatus] [DEFAULT_PARAMS] No orderId provided, using default values`);
      // Fallback to default values
      url.searchParams.set("paymentType", "DB");
      url.searchParams.set("currency", "USD");
      url.searchParams.set("amount", "32.39");
    }

    const cacheKey = url.toString();
    
    // Check cache first for GET requests
    const cachedResponse = this._getCachedResponse(cacheKey);
    if (cachedResponse) {
      Logger.debugLog?.(`[Axcess] [getPaymentStatus] [CACHE_HIT] Returning cached response`);
      return cachedResponse;
    }
    
    Logger.debugLog?.(`[Axcess] [getPaymentStatus] [REQUEST] Making request to: ${url.toString()}`);

    const res = await httpRequestWithBearer({
      urlString: url.toString(),
      method: "GET",
      bearerToken: this.apiBearerToken,
      userAgent: this.userAgent,
      maxRequestBytes: this.maxRequestBytes,
      maxResponseBytes: this.maxResponseBytes,
      timeout: cleaned.timeout || this.httpTimeoutMs,
    });

    if (res.status < 200 || res.status >= 300) {
      const errorMsg = this._buildErrorMessage("Axcess", "getPaymentStatus", `HTTP ${res.status} - ${res.raw?.result?.description || 'Unknown error'}`);
      ErrorHandler.addError(errorMsg, {
        code: "PAYMENT_STATUS_FETCH_FAILED",
        origin: "Axcess",
        data: {
        status: res.status,
        raw: res.raw,
          resourcePath: cleaned.resourcePath,
          orderId: cleaned.orderId,
        },
      });
      Logger.debugLog?.(`[Axcess] [getPaymentStatus] [ERROR] Failed to fetch payment status: status ${res.status}`);
      throw createAxcessError(errorMsg, {
        code: "PAYMENT_STATUS_FETCH_FAILED",
        status: res.status,
        raw: res.raw,
        data: { resourcePath: cleaned.resourcePath, orderId: cleaned.orderId },
      });
    }
    
    // Cache successful GET responses
    this._setCachedResponse(cacheKey, res);
    
    Logger.debugLog?.(`[Axcess] [getPaymentStatus] [SUCCESS] Payment status retrieved successfully`);
    
    return res;
  }

  /* ============================================================================
   * SECTION B — Server-to-Server (S2S) Payments (no widget)
   * Docs:
   *  https://axcessms.docs.oppwa.com/integrations/server-to-server
   *  https://axcessms.docs.oppwa.com/reference/parameters
   *  https://axcessms.docs.oppwa.com/reference/resultCodes
   * ========================================================================== */

  /**
   * Server-to-Server Authorization (paymentType=PA).
   * @param {object} params
   * @param {number|string} params.amount
   * @param {string} params.currency
   * @param {string} params.paymentBrand - e.g., 'VISA', 'MASTER'
   * @param {object} params.card - { number, holder, expiryMonth, expiryYear, cvv }
   * @param {object} [params.customer] - optional customer details
   * @param {object} [params.threeDSParams] - 3DS fields; see 3DS docs
   * @param {string} [params.idempotencyKey] - optional idempotency key for request deduplication
   * @param {string} [params.userId] - user ID for transaction tracking (defaults to "system" if not provided)
   * @returns {Promise<object>} normalized result
   *
   * Docs: S2S + 3DS Parameters
   * https://axcessms.docs.oppwa.com/integrations/server-to-server
   * https://axcessms.docs.oppwa.com/tutorials/threeDSecure/Parameters
   */
  async s2sAuthorize(params = {}) {
    Logger.debugLog?.(`[Axcess] [s2sAuthorize] [START] Processing S2S authorization`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      amount: { value: params.amount, type: "float", required: true },
      currency: { value: params.currency, type: "string", required: true },
      paymentBrand: {
        value: params.paymentBrand,
        type: "string",
        required: true,
      },
      card: { value: params.card, type: "object", required: true },
      customer: {
        value: params.customer || {},
        type: "object",
        required: false,
        default: {},
      },
      billing: {
        value: params.billing || {},
        type: "object",
        required: false,
        default: {},
      },
      threeDSParams: {
        value: params.threeDSParams || {},
        type: "object",
        required: false,
        default: {},
      },
      idempotencyKey: {
        value: params.idempotencyKey,
        type: "string",
        required: false,
      },
      userId: {
        value: params.userId,
        type: "string",
        required: false,
      },
    });

    Logger.debugLog?.(`[Axcess] [s2sAuthorize] [VALIDATION] Input validated: amount=${cleaned.amount}, currency=${cleaned.currency}, paymentBrand=${cleaned.paymentBrand}`);

    // Generate idempotency key if not provided
    const idempotencyKey = this._generateIdempotencyKey(cleaned.idempotencyKey);
    Logger.debugLog?.(`[Axcess] [s2sAuthorize] [IDEMPOTENCY] Using idempotency key: ${idempotencyKey}`);

    const endpoint = this._paymentUrl("/payments").toString();
    const bodyParams = {
      entityId: this.entityId,
      paymentBrand: cleaned.paymentBrand,
      paymentType: "PA",
      amount: this._formatAmount(cleaned.amount, cleaned.currency),
      currency: cleaned.currency,
      "card.number": cleaned.card.number,
      "card.holder": cleaned.card.holder,
      "card.expiryMonth": cleaned.card.expiryMonth,
      "card.expiryYear": cleaned.card.expiryYear,
      "card.cvv": cleaned.card.cvv,
      // Add required S2S parameters
      testMode: this.testMode,
      merchantTransactionId: cleaned.threeDSParams?.merchantTransactionId,
      // Add customer info if provided
      ...(cleaned.customer.givenName && { "customer.givenName": cleaned.customer.givenName }),
      ...(cleaned.customer.surname && { "customer.surname": cleaned.customer.surname }),
      ...(cleaned.customer.email && { "customer.email": cleaned.customer.email }),
      ...(cleaned.customer.phone && { "customer.phone": cleaned.customer.phone }),
      ...(cleaned.customer.ip && { "customer.ip": cleaned.customer.ip }),
      // Add billing info if provided
      ...(cleaned.billing.street1 && { "billing.street1": cleaned.billing.street1 }),
      ...(cleaned.billing.city && { "billing.city": cleaned.billing.city }),
      ...(cleaned.billing.state && { "billing.state": cleaned.billing.state }),
      ...(cleaned.billing.postcode && { "billing.postcode": cleaned.billing.postcode }),
      ...(cleaned.billing.country && { "billing.country": cleaned.billing.country }),
      // Note: 3DS parameters are NOT needed in INTERNAL test mode as it bypasses 3DS
    };
    
    Logger.debugLog?.(`[Axcess] [s2sAuthorize] [REQUEST] Making authorization request to: ${endpoint}`);
    
    const body = toFormUrlEncoded(bodyParams);
    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      userAgent: this.userAgent,
      maxRequestBytes: this.maxRequestBytes,
      maxResponseBytes: this.maxResponseBytes,
      headers: { 
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": idempotencyKey,
      },
      body,
      timeout: this.httpTimeoutMs,
    });
    
    Logger.debugLog?.(`[Axcess] [s2sAuthorize] [RESPONSE] Received response, processing...`);
    
    const result = await this._handleS2SResponse(res, "authorize", cleaned.userId);
    
    this._writeLog("s2sAuthorize", "S2S authorization processed", {
        amount: cleaned.amount,
        currency: cleaned.currency,
        paymentBrand: cleaned.paymentBrand,
        status: result.normalized?.approved ? "success" : "failed",
        resultCode: result.normalized?.resultCode,
    });
    
    return result;
  }

  /**
   * Server-to-Server Capture (paymentType=CP).
   * @param {object} params
   * @param {string} params.paymentId
   * @param {number|string} [params.amount] - optional partial capture
   * @param {string} [params.idempotencyKey] - optional idempotency key for request deduplication
   * @param {string} [params.userId] - user ID for transaction tracking (defaults to "system" if not provided)
   * @returns {Promise<object>} normalized result
   *
   * Docs: Backoffice
   * https://axcessms.docs.oppwa.com/integrations/backoffice
   */
  async s2sCapture(params = {}) {
    Logger.debugLog?.(`[Axcess] [s2sCapture] [START] Processing S2S capture`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      paymentId: { value: params.paymentId, type: "string", required: true },
      amount: { value: params.amount, type: "float", required: false },
      currency: { value: params.currency, type: "string", required: false },
      merchantTransactionId: { value: params.merchantTransactionId, type: "string", required: false },
      idempotencyKey: {
        value: params.idempotencyKey,
        type: "string",
        required: false,
      },
      userId: {
        value: params.userId,
        type: "string",
        required: false,
      },
    });

    Logger.debugLog?.(`[Axcess] [s2sCapture] [VALIDATION] Input validated: paymentId=${cleaned.paymentId}, amount=${cleaned.amount || 'null'}`);

    // Generate idempotency key if not provided
    const idempotencyKey = this._generateIdempotencyKey(cleaned.idempotencyKey);
    Logger.debugLog?.(`[Axcess] [s2sCapture] [IDEMPOTENCY] Using idempotency key: ${idempotencyKey}`);

    const endpoint = this._paymentUrl(`/payments/${encodeURIComponent(cleaned.paymentId)}`).toString();
    const bodyParams = {
      entityId: this.entityId,
      paymentType: "CP",
      ...(cleaned.amount ? { amount: this._formatAmount(cleaned.amount, cleaned.currency) } : {}),
      ...(cleaned.currency ? { currency: cleaned.currency } : {}),
      ...(cleaned.merchantTransactionId ? { merchantTransactionId: cleaned.merchantTransactionId } : {}),
    };
    
    Logger.debugLog?.(`[Axcess] [s2sCapture] [REQUEST] Making capture request to: ${endpoint}`);
    
    const body = toFormUrlEncoded(bodyParams);

    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      userAgent: this.userAgent,
      maxRequestBytes: this.maxRequestBytes,
      maxResponseBytes: this.maxResponseBytes,
      headers: { 
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": idempotencyKey,
      },
      body,
      timeout: this.httpTimeoutMs,
    });
    
    Logger.debugLog?.(`[Axcess] [s2sCapture] [RESPONSE] Received response, processing...`);
    
    const result = await this._handleS2SResponse(res, "capture", cleaned.userId);
    
    this._writeLog("s2sCapture", "S2S capture processed", {
        paymentId: cleaned.paymentId,
        amount: cleaned.amount,
        currency: cleaned.currency,
        status: result.normalized?.approved ? "success" : "failed",
        resultCode: result.normalized?.resultCode,
    });
    
    return result;
  }

  /**
   * Server-to-Server Void/Reverse (paymentType=RV).
   * @param {object} params
   * @param {string} params.paymentId
   * @param {string} [params.idempotencyKey] - optional idempotency key for request deduplication
   * @param {string} [params.userId] - user ID for transaction tracking (defaults to "system" if not provided)
   * @returns {Promise<object>} normalized result
   *
   * Docs: Backoffice
   * https://axcessms.docs.oppwa.com/integrations/backoffice
   */
  async s2sVoid(params = {}) {
    Logger.debugLog?.(`[Axcess] [s2sVoid] [START] Processing S2S void`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      paymentId: { value: params.paymentId, type: "string", required: true },
      merchantTransactionId: { value: params.merchantTransactionId, type: "string", required: false },
      idempotencyKey: {
        value: params.idempotencyKey,
        type: "string",
        required: false,
      },
      userId: {
        value: params.userId,
        type: "string",
        required: false,
      },
    });

    Logger.debugLog?.(`[Axcess] [s2sVoid] [VALIDATION] Input validated: paymentId=${cleaned.paymentId}`);

    // Generate idempotency key if not provided
    const idempotencyKey = this._generateIdempotencyKey(cleaned.idempotencyKey);
    Logger.debugLog?.(`[Axcess] [s2sVoid] [IDEMPOTENCY] Using idempotency key: ${idempotencyKey}`);

    const endpoint = this._paymentUrl(`/payments/${encodeURIComponent(cleaned.paymentId)}`).toString();
    const body = toFormUrlEncoded({
      entityId: this.entityId,
      paymentType: "RV",
      ...(cleaned.merchantTransactionId ? { merchantTransactionId: cleaned.merchantTransactionId } : {}),
    });

    Logger.debugLog?.(`[Axcess] [s2sVoid] [REQUEST] Making void request to: ${endpoint}`);

    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      userAgent: this.userAgent,
      maxRequestBytes: this.maxRequestBytes,
      maxResponseBytes: this.maxResponseBytes,
      headers: { 
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": idempotencyKey,
      },
      body,
      timeout: this.httpTimeoutMs,
    });
    
    Logger.debugLog?.(`[Axcess] [s2sVoid] [RESPONSE] Received response, processing...`);
    
    const result = await this._handleS2SResponse(res, "void", cleaned.userId);
    
    this._writeLog("s2sVoid", "S2S void processed", {
        paymentId: cleaned.paymentId,
        merchantTransactionId: cleaned.merchantTransactionId,
        status: result.normalized?.approved ? "success" : "failed",
        resultCode: result.normalized?.resultCode,
    });
    
    return result;
  }

  /**
   * Server-to-Server Debit/Purchase (paymentType=DB).
   * @param {object} params
   * @param {number|string} params.amount
   * @param {string} params.currency
   * @param {string} params.paymentBrand
   * @param {object} params.card - { number, holder, expiryMonth, expiryYear, cvv }
   * @param {object} [params.customer]
   * @param {object} [params.threeDSParams]
   * @param {string} [params.idempotencyKey] - optional idempotency key for request deduplication
   * @param {string} [params.userId] - user ID for transaction tracking (defaults to "system" if not provided)
   * @returns {Promise<object>} normalized result
   *
   * Docs: S2S + 3DS Parameters
   * https://axcessms.docs.oppwa.com/integrations/server-to-server
   * https://axcessms.docs.oppwa.com/tutorials/threeDSecure/Parameters
   */
  async s2sDebit(params = {}) {
    Logger.debugLog?.(`[Axcess] [s2sDebit] [START] Processing S2S debit`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      amount: { value: params.amount, type: "float", required: true },
      currency: { value: params.currency, type: "string", required: true },
      paymentBrand: {
        value: params.paymentBrand,
        type: "string",
        required: true,
      },
      card: { value: params.card, type: "object", required: true },
      customer: {
        value: params.customer || {},
        type: "object",
        required: false,
        default: {},
      },
      billing: {
        value: params.billing || {},
        type: "object",
        required: false,
        default: {},
      },
      threeDSParams: {
        value: params.threeDSParams || {},
        type: "object",
        required: false,
        default: {},
      },
      idempotencyKey: {
        value: params.idempotencyKey,
        type: "string",
        required: false,
      },
      userId: {
        value: params.userId,
        type: "string",
        required: false,
      },
    });

    Logger.debugLog?.(`[Axcess] [s2sDebit] [VALIDATION] Input validated: amount=${cleaned.amount}, currency=${cleaned.currency}, paymentBrand=${cleaned.paymentBrand}`);

    // Generate idempotency key if not provided
    const idempotencyKey = this._generateIdempotencyKey(cleaned.idempotencyKey);
    Logger.debugLog?.(`[Axcess] [s2sDebit] [IDEMPOTENCY] Using idempotency key: ${idempotencyKey}`);

    const endpoint = this._paymentUrl("/payments").toString();
    const bodyParams = {
      entityId: this.entityId,
      paymentBrand: cleaned.paymentBrand,
      paymentType: "DB",
      amount: this._formatAmount(cleaned.amount, cleaned.currency),
      currency: cleaned.currency,
      "card.number": cleaned.card.number,
      "card.holder": cleaned.card.holder,
      "card.expiryMonth": cleaned.card.expiryMonth,
      "card.expiryYear": cleaned.card.expiryYear,
      "card.cvv": cleaned.card.cvv,
      // Add required S2S parameters
      testMode: this.testMode,
      merchantTransactionId: cleaned.threeDSParams?.merchantTransactionId,
      // Add customer info if provided
      ...(cleaned.customer.givenName && { "customer.givenName": cleaned.customer.givenName }),
      ...(cleaned.customer.surname && { "customer.surname": cleaned.customer.surname }),
      ...(cleaned.customer.email && { "customer.email": cleaned.customer.email }),
      ...(cleaned.customer.phone && { "customer.phone": cleaned.customer.phone }),
      ...(cleaned.customer.ip && { "customer.ip": cleaned.customer.ip }),
      // Add billing info if provided
      ...(cleaned.billing.street1 && { "billing.street1": cleaned.billing.street1 }),
      ...(cleaned.billing.city && { "billing.city": cleaned.billing.city }),
      ...(cleaned.billing.state && { "billing.state": cleaned.billing.state }),
      ...(cleaned.billing.postcode && { "billing.postcode": cleaned.billing.postcode }),
      ...(cleaned.billing.country && { "billing.country": cleaned.billing.country }),
      // Note: 3DS parameters are NOT needed in INTERNAL test mode as it bypasses 3DS
    };
    
    Logger.debugLog?.(`[Axcess] [s2sDebit] [REQUEST] Making debit request to: ${endpoint}`);
    
    const body = toFormUrlEncoded(bodyParams);

    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      userAgent: this.userAgent,
      maxRequestBytes: this.maxRequestBytes,
      maxResponseBytes: this.maxResponseBytes,
      headers: { 
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": idempotencyKey,
      },
      body,
      timeout: this.httpTimeoutMs,
    });

    Logger.debugLog?.(`[Axcess] [s2sDebit] [RESPONSE] Received response, processing...`);
    
    const result = await this._handleS2SResponse(res, "debit", cleaned.userId);
    
    this._writeLog("s2sDebit", "S2S debit processed", {
        amount: cleaned.amount,
        currency: cleaned.currency,
        paymentBrand: cleaned.paymentBrand,
        status: result.normalized?.approved ? "success" : "failed",
        resultCode: result.normalized?.resultCode,
    });
    
    return result;
  }

  /**
   * Server-to-Server Refund (paymentType=RF).
   * @param {object} params
   * @param {string} params.paymentId - original captured payment id
   * @param {number|string} [params.amount] - optional partial refund
   * @param {number} [params.timeout] - optional request timeout in milliseconds (overrides instance default)
   * @param {string} [params.idempotencyKey] - optional idempotency key for request deduplication
   * @param {string} [params.userId] - user ID for transaction tracking (defaults to "system" if not provided)
   * @returns {Promise<object>} normalized result
   *
   * Docs: Backoffice
   * https://axcessms.docs.oppwa.com/integrations/backoffice
   */
  async s2sRefund(params = {}) {
    Logger.debugLog?.(`[Axcess] [s2sRefund] [START] Processing S2S refund`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      paymentId: { value: params.paymentId, type: "string", required: true },
      amount: { value: params.amount, type: "float", required: false },
      currency: { value: params.currency, type: "string", required: false },
      timeout: { value: params.timeout, type: "int", required: false },
      idempotencyKey: {
        value: params.idempotencyKey,
        type: "string",
        required: false,
      },
      userId: {
        value: params.userId,
        type: "string",
        required: false,
      },
    });

    Logger.debugLog?.(`[Axcess] [s2sRefund] [VALIDATION] Input validated: paymentId=${cleaned.paymentId}, amount=${cleaned.amount || 'null'}`);

    // Generate idempotency key if not provided
    const idempotencyKey = this._generateIdempotencyKey(cleaned.idempotencyKey);
    Logger.debugLog?.(`[Axcess] [s2sRefund] [IDEMPOTENCY] Using idempotency key: ${idempotencyKey}`);

    const endpoint = this._paymentUrl(`/payments/${encodeURIComponent(cleaned.paymentId)}`).toString();
    const bodyParams = {
      entityId: this.entityId,
      paymentType: "RF",
      ...(cleaned.amount ? { amount: this._formatAmount(cleaned.amount, cleaned.currency) } : {}),
      ...(cleaned.currency ? { currency: cleaned.currency } : {}),
    };
    
    Logger.debugLog?.(`[Axcess] [s2sRefund] [REQUEST] Making refund request to: ${endpoint}`);
    
    const body = toFormUrlEncoded(bodyParams);

    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      userAgent: this.userAgent,
      maxRequestBytes: this.maxRequestBytes,
      maxResponseBytes: this.maxResponseBytes,
      headers: { 
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": idempotencyKey,
      },
      body,
      timeout: cleaned.timeout || this.httpTimeoutMs,
    });
    
    Logger.debugLog?.(`[Axcess] [s2sRefund] [RESPONSE] Received response, processing...`);
    
    const result = await this._handleS2SResponse(res, "refund", cleaned.userId);
    
    this._writeLog("s2sRefund", "S2S refund processed", {
        paymentId: cleaned.paymentId,
        amount: cleaned.amount,
        currency: cleaned.currency,
        status: result.normalized?.approved ? "success" : "failed",
        resultCode: result.normalized?.resultCode,
    });
    
    return result;
  }

  /**
   * Initiate standalone 3-D Secure authentication (if using separate flow).
   * @param {object} params
   * @param {number|string} params.amount
   * @param {string} params.currency
   * @param {object} params.card
   * @param {object} params.customer
   * @param {object} params.threeDSParams
   * @returns {Promise<object>} raw/normalized depending on Axcess response
   *
   * Docs: Standalone 3DS
   * https://axcessms.docs.oppwa.com/integrations/server-to-server/standalone3DS
   */
  async initiateStandalone3DS(params = {}) {
    Logger.debugLog?.(`[Axcess] [initiateStandalone3DS] [START] Initiating standalone 3DS`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      amount: { value: params.amount, type: "float", required: true },
      currency: { value: params.currency, type: "string", required: true },
      card: { value: params.card, type: "object", required: true },
      customer: {
        value: params.customer || {},
        type: "object",
        required: false,
        default: {},
      },
      threeDSParams: {
        value: params.threeDSParams || {},
        type: "object",
        required: true,
      },
    });

    Logger.debugLog?.(`[Axcess] [initiateStandalone3DS] [VALIDATION] Input validated: amount=${cleaned.amount}, currency=${cleaned.currency}`);

    const endpoint = this._paymentUrl("/threeDSecure").toString();
    const bodyParams = {
      entityId: this.entityId,
      amount: cleaned.amount,
      currency: cleaned.currency,
      "card.number": cleaned.card.number,
      "card.holder": cleaned.card.holder,
      "card.expiryMonth": cleaned.card.expiryMonth,
      "card.expiryYear": cleaned.card.expiryYear,
      "card.cvv": cleaned.card.cvv,
      ...this._flattenThreeDS(cleaned.threeDSParams),
    };
    
    Logger.debugLog?.(`[Axcess] [initiateStandalone3DS] [REQUEST] Making 3DS request to: ${endpoint}`);
    
    const body = toFormUrlEncoded(bodyParams);

    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      userAgent: this.userAgent,
      maxRequestBytes: this.maxRequestBytes,
      maxResponseBytes: this.maxResponseBytes,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      timeout: this.httpTimeoutMs,
    });

    if (res.status < 200 || res.status >= 300) {
      ErrorHandler.addError("Axcess initiateStandalone3DS failed", {
        code: "STANDALONE_3DS_FAILED",
        origin: "Axcess",
        data: {
          status: res.status,
          raw: res.raw,
          amount: cleaned.amount,
          currency: cleaned.currency,
        },
      });
      Logger.debugLog?.(`[Axcess] [initiateStandalone3DS] [ERROR] Failed to initiate standalone 3DS: status ${res.status}`);
      throw createAxcessError("Failed to initiate standalone 3DS", {
        code: "STANDALONE_3DS_FAILED",
        status: res.status,
        raw: res.raw,
      });
    }
    
    Logger.debugLog?.(`[Axcess] [initiateStandalone3DS] [SUCCESS] Standalone 3DS initiated successfully`);
    
    this._writeLog("initiateStandalone3DS", "Standalone 3DS initiated", {
        amount: cleaned.amount,
        currency: cleaned.currency,
        status: res.status,
    });
    
    return res.data || {};
  }

  /**
   * Continue 3DS after ACS challenge (PaRes/CRes).
   * @param {object} params
   * @param {string} params.id - 3DS transaction id
   * @param {string} [params.paRes] - for 3DS1
   * @param {string} [params.cres] - for 3DS2
   * @returns {Promise<object>}
   *
   * Docs: 3DS Response Parameters
   * https://axcessms.docs.oppwa.com/tutorials/threeDSecure/Parameters#Response-Parameters
   */
  async continue3DSChallenge(params = {}) {
    Logger.debugLog?.(`[Axcess] [continue3DSChallenge] [START] Continuing 3DS challenge`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      id: { value: params.id, type: "string", required: true },
      paRes: { value: params.paRes, type: "string", required: false },
      cres: { value: params.cres, type: "string", required: false },
    });
    
    Logger.debugLog?.(`[Axcess] [continue3DSChallenge] [VALIDATION] Input validated: id=${cleaned.id}, hasPaRes=${!!cleaned.paRes}, hasCres=${!!cleaned.cres}`);
    
    const endpoint = this._paymentUrl(`/threeDSecure/${encodeURIComponent(cleaned.id)}`).toString();
    const body = toFormUrlEncoded({
      entityId: this.entityId,
      ...(cleaned.paRes ? { paRes: cleaned.paRes } : {}),
      ...(cleaned.cres ? { cres: cleaned.cres } : {}),
    });

    Logger.debugLog?.(`[Axcess] [continue3DSChallenge] [REQUEST] Making 3DS challenge continuation request to: ${endpoint}`);

    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      userAgent: this.userAgent,
      maxRequestBytes: this.maxRequestBytes,
      maxResponseBytes: this.maxResponseBytes,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      timeout: this.httpTimeoutMs,
    });

    if (res.status < 200 || res.status >= 300) {
      ErrorHandler.addError("Axcess continue3DSChallenge failed", {
        code: "3DS_CHALLENGE_CONTINUE_FAILED",
        origin: "Axcess",
        data: {
          status: res.status,
          raw: res.raw,
          id: cleaned.id,
        },
      });
      Logger.debugLog?.(`[Axcess] [continue3DSChallenge] [ERROR] Failed to continue 3DS challenge: status ${res.status}`);
      throw createAxcessError("Failed to continue 3DS challenge", {
        code: "3DS_CHALLENGE_CONTINUE_FAILED",
        status: res.status,
        raw: res.raw,
      });
    }
    
    Logger.debugLog?.(`[Axcess] [continue3DSChallenge] [SUCCESS] 3DS challenge continued successfully`);
    
    this._writeLog("continue3DSChallenge", "3DS challenge continued", {
        id: cleaned.id,
        status: res.status,
    });
    
    return res.data || {};
  }

  /**
   * Request a Standalone SCA Exemption (if supported for your entity/flows).
   * @param {object} params
   * @param {number|string} params.amount
   * @param {string} params.currency
   * @param {string} params.paymentBrand
   * @param {object} params.cardOrToken - { card.* } or { registrationId }
   * @param {string} params.exemptionType - e.g., 'TRA', 'LVP' (see docs)
   * @returns {Promise<object>}
   *
   * Docs: Standalone Exemption
   * https://axcessms.docs.oppwa.com/integrations/server-to-server/standaloneexemption
   */
  async requestStandaloneExemption(params = {}) {
    Logger.debugLog?.(`[Axcess] [requestStandaloneExemption] [START] Requesting standalone SCA exemption`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      amount: { value: params.amount, type: "float", required: true },
      currency: { value: params.currency, type: "string", required: true },
      paymentBrand: {
        value: params.paymentBrand,
        type: "string",
        required: true,
      },
      cardOrToken: {
        value: params.cardOrToken,
        type: "object",
        required: true,
      },
      exemptionType: {
        value: params.exemptionType,
        type: "string",
        required: true,
      },
    });

    Logger.debugLog?.(`[Axcess] [requestStandaloneExemption] [VALIDATION] Input validated: amount=${cleaned.amount}, currency=${cleaned.currency}, exemptionType=${cleaned.exemptionType}`);

    const endpoint = this._paymentUrl("/exemptions").toString();
    const bodyParams = {
      entityId: this.entityId,
      paymentBrand: cleaned.paymentBrand,
      amount: cleaned.amount,
      currency: cleaned.currency,
      exemptionType: cleaned.exemptionType,
    };
    if (cleaned.cardOrToken.registrationId) {
      bodyParams.registrationId = cleaned.cardOrToken.registrationId;
    } else {
      bodyParams["card.number"] = cleaned.cardOrToken.card?.number;
      bodyParams["card.holder"] = cleaned.cardOrToken.card?.holder;
      bodyParams["card.expiryMonth"] = cleaned.cardOrToken.card?.expiryMonth;
      bodyParams["card.expiryYear"] = cleaned.cardOrToken.card?.expiryYear;
      bodyParams["card.cvv"] = cleaned.cardOrToken.card?.cvv;
    }

    Logger.debugLog?.(`[Axcess] [requestStandaloneExemption] [REQUEST] Making exemption request to: ${endpoint}`);

    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      userAgent: this.userAgent,
      maxRequestBytes: this.maxRequestBytes,
      maxResponseBytes: this.maxResponseBytes,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: toFormUrlEncoded(bodyParams),
      timeout: this.httpTimeoutMs,
    });

    if (res.status < 200 || res.status >= 300) {
      ErrorHandler.addError("Axcess requestStandaloneExemption failed", {
        code: "STANDALONE_EXEMPTION_FAILED",
        origin: "Axcess",
        data: {
          status: res.status,
          raw: res.raw,
          amount: cleaned.amount,
          currency: cleaned.currency,
          exemptionType: cleaned.exemptionType,
        },
      });
      Logger.debugLog?.(`[Axcess] [requestStandaloneExemption] [ERROR] Failed to request 3DS exemption: status ${res.status}`);
      throw createAxcessError("Failed to request 3DS exemption", {
        code: "STANDALONE_EXEMPTION_FAILED",
        status: res.status,
        raw: res.raw,
      });
    }
    
    Logger.debugLog?.(`[Axcess] [requestStandaloneExemption] [SUCCESS] Standalone exemption requested successfully`);
    
    this._writeLog("requestStandaloneExemption", "Standalone SCA exemption requested", {
        amount: cleaned.amount,
        currency: cleaned.currency,
        exemptionType: cleaned.exemptionType,
        status: res.status,
    });
    
    return res.data || {};
  }

  /* ============================================================================
   * SECTION C — Card-on-File / Registration Tokens
   * Docs:
   *  https://axcessms.docs.oppwa.com/tutorials/card-on-file
   *  https://axcessms.docs.oppwa.com/integrations/widget/registration-tokens
   *  https://axcessms.docs.oppwa.com/integrations/server-to-server/registrationtokens
   *  https://axcessms.docs.oppwa.com/integrations/server-to-server/networktokens
   * ========================================================================== */

  /**
   * Create a registration token for later charges (card-on-file).
   * @param {object} params
   * @param {object} params.card - { number, holder, expiryMonth, expiryYear, cvv }
   * @param {object} [params.customer]
   * @returns {Promise<{registrationId:string, maskedPan?:string, brand?:string, expiry?:string}>}
   */
  // async createRegistrationToken(cardWrapper) {
  //   const card = cardWrapper.card; // extract inner object
  //   console.log("card", card);
  //   const bodyParams = {
  //     entityId: CONFIG.ENTITY_ID,
  //     "card.number": card.number,
  //     "card.holder": card.holder,
  //     "card.expiryMonth": card.expiryMonth,
  //     "card.expiryYear": card.expiryYear,
  //     "card.cvv": card.cvv,
  //     paymentBrand: "VISA", // explicitly add this
  //   };
  //   console.log("bodyParams", bodyParams);

  //   const url = `${CONFIG.API_BASE}/v1/registrations`;
  //   const res = await testhttpRequest({
  //     urlString: url,
  //     method: "POST",
  //     bearerToken: CONFIG.BEARER_TOKEN,
  //     body: testtoFormUrlEncoded(bodyParams),
  //   });
  //   console.log(res);

  //   return res;
  // }
  async createRegistrationToken(params = {}) {
    Logger.debugLog?.(`[Axcess] [createRegistrationToken] [START] Creating registration token`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      card: { value: params.card, type: "object", required: true },
      customer: {
        value: params.customer || {},
        type: "object",
        required: false,
        default: {},
      },
      billing: {
        value: params.billing || {},
        type: "object",
        required: false,
        default: {},
      },
      userId: { value: params.userId, type: "string", required: true },
    });

    Logger.debugLog?.(`[Axcess] [createRegistrationToken] [VALIDATION] Input validated: hasCard=${!!cleaned.card}, hasCustomer=${!!cleaned.customer}`);

    const endpoint = this._paymentUrl("/registrations").toString();
    const bodyParams = {
      entityId: this.entityId,
      "card.number": cleaned.card.number,
      "card.holder": cleaned.card.holder,
      "card.expiryMonth": cleaned.card.expiryMonth,
      "card.expiryYear": cleaned.card.expiryYear,
      "card.cvv": cleaned.card.cvv,
      testMode: this.testMode,
      // Add customer info if provided
      ...(cleaned.customer.givenName && { "customer.givenName": cleaned.customer.givenName }),
      ...(cleaned.customer.surname && { "customer.surname": cleaned.customer.surname }),
      ...(cleaned.customer.email && { "customer.email": cleaned.customer.email }),
      ...(cleaned.customer.phone && { "customer.phone": cleaned.customer.phone }),
      ...(cleaned.customer.ip && { "customer.ip": cleaned.customer.ip }),
      // Add billing info if provided
      ...(cleaned.billing.street1 && { "billing.street1": cleaned.billing.street1 }),
      ...(cleaned.billing.city && { "billing.city": cleaned.billing.city }),
      ...(cleaned.billing.state && { "billing.state": cleaned.billing.state }),
      ...(cleaned.billing.postcode && { "billing.postcode": cleaned.billing.postcode }),
      ...(cleaned.billing.country && { "billing.country": cleaned.billing.country }),
    };
    
    Logger.debugLog?.(`[Axcess] [createRegistrationToken] [REQUEST] Making registration request to: ${endpoint}`);
    
    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      userAgent: this.userAgent,
      maxRequestBytes: this.maxRequestBytes,
      maxResponseBytes: this.maxResponseBytes,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: toFormUrlEncoded(bodyParams),
      timeout: this.httpTimeoutMs,
    });

    Logger.debugLog?.(`[Axcess] [createRegistrationToken] [RESPONSE] Received response: ${JSON.stringify({ status: res.status, hasId: !!res.data?.id })}`);

    if (res.status < 200 || res.status >= 300 || !res.data?.id) {
      // Extract error details from the gateway response
      const errorMessage = res.data?.result?.description || "Failed to create registration token";
      const errorCode = res.data?.result?.code || "UNKNOWN_ERROR";
      const errorMsg = this._buildErrorMessage("Axcess", "createRegistrationToken", errorMessage);

      ErrorHandler.addError(errorMsg, {
        code: errorCode,
        origin: "Axcess",
        data: {
          status: res.status,
          errorCode: errorCode,
          errorMessage: errorMessage,
          raw: res.raw,
        },
      });

      Logger.debugLog?.(`[Axcess] [createRegistrationToken] [ERROR] Failed to create registration token: ${errorMessage}`);
      
      throw createAxcessError(errorMsg, {
        code: errorCode,
        status: res.status,
        raw: res.raw,
        data: {
          errorMessage,
          gatewayResponse: res.data,
        },
      });
    }

    const userId = cleaned.userId;
    const tokenId = res.data.id;

    const tokenRecord = {
      pk: `user#${userId}`,
      sk: `token#${tokenId}`,
      userId: userId,
      registrationId: tokenId,
      id: tokenId,
      gateway: "axcess",
      last4: res.data.card?.last4Digits || res.data.card?.last4 || null,
      brand: res.data.paymentBrand || null,
      expiry:
        res.data.card?.expiryMonth && res.data.card?.expiryYear
          ? `${res.data.card.expiryYear}-${res.data.card.expiryMonth}`
          : null,
      createdAt: this._now(),
    };
    this._checkServiceMethod('saveToken', true);
    await this.svc.saveToken(tokenRecord);

    Logger.debugLog?.(`[Axcess] [createRegistrationToken] [SUCCESS] Registration token created: ${tokenId}`);

    this._writeLog("createRegistrationToken", "Registration token created", {
        registrationId: tokenId,
        userId: userId,
        brand: tokenRecord.brand,
        last4: tokenRecord.last4,
    });

    return {
      registrationId: res.data.id,
      maskedPan: res.data.card?.bin
        ? `${res.data.card.bin}******${res.data.card?.last4 || ""}`
        : undefined,
      brand: res.data.paymentBrand || undefined,
      expiry: tokenRecord.expiry || undefined,
    };
  }

  /**
   * Charge with a registration token (paymentType=DB).
   * @param {object} params
   * @param {string} params.registrationId
   * @param {number|string} params.amount
   * @param {string} params.currency
   * @param {object} [params.threeDSParams]
   * @param {string} [params.idempotencyKey] - optional idempotency key for request deduplication
   * @param {string} [params.userId] - user ID for transaction tracking (defaults to "system" if not provided)
   * @returns {Promise<object>} normalized result
   */
  async debitWithRegistrationToken(params = {}) {
    Logger.debugLog?.(`[Axcess] [debitWithRegistrationToken] [START] Processing debit with registration token`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      registrationId: {
        value: params.registrationId,
        type: "string",
        required: true,
      },
      amount: { value: params.amount, type: "float", required: true },
      currency: { value: params.currency, type: "string", required: true },
      threeDSParams: {
        value: params.threeDSParams || {},
        type: "object",
        required: false,
        default: {},
      },
      idempotencyKey: {
        value: params.idempotencyKey,
        type: "string",
        required: false,
      },
      userId: {
        value: params.userId,
        type: "string",
        required: false,
      },
    });
    
    Logger.debugLog?.(`[Axcess] [debitWithRegistrationToken] [VALIDATION] Input validated: registrationId=${cleaned.registrationId}, amount=${cleaned.amount}, currency=${cleaned.currency}`);

    // Generate idempotency key if not provided
    const idempotencyKey = this._generateIdempotencyKey(cleaned.idempotencyKey);
    Logger.debugLog?.(`[Axcess] [debitWithRegistrationToken] [IDEMPOTENCY] Using idempotency key: ${idempotencyKey}`);
    
    const endpoint = this._paymentUrl(`/registrations/${encodeURIComponent(cleaned.registrationId)}/payments`).toString();
    
    const currentTimestamp = this._nowUnixSeconds();
    const bodyParams = {
      entityId: this.entityId,
      paymentType: "DB",
      amount: cleaned.amount,
      currency: cleaned.currency,
      // Required for registration token payments
      merchantTransactionId: cleaned.threeDSParams?.merchantTransactionId || `ORDER${currentTimestamp}`,
      testMode: this.testMode,
      // Standing instruction parameters for recurring payments
      'standingInstruction.type': 'RECURRING',
      'standingInstruction.mode': 'REPEATED',
      'standingInstruction.source': 'MIT',
      'standingInstruction.recurringType': 'SUBSCRIPTION',
      // Note: 3DS parameters are NOT supported for registration token payments
    };
    
    Logger.debugLog?.(`[Axcess] [debitWithRegistrationToken] [REQUEST] Making debit request to: ${endpoint}`);
    
    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      userAgent: this.userAgent,
      maxRequestBytes: this.maxRequestBytes,
      maxResponseBytes: this.maxResponseBytes,
      headers: { 
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": idempotencyKey,
      },
      body: toFormUrlEncoded(bodyParams),
      timeout: this.httpTimeoutMs,
    });
    
    Logger.debugLog?.(`[Axcess] [debitWithRegistrationToken] [RESPONSE] Received response, processing...`);
    
    const result = await this._handleS2SResponse(res, "debit_token", cleaned.userId);
    
    this._writeLog("debitWithRegistrationToken", "Debit with registration token processed", {
        registrationId: cleaned.registrationId,
        amount: cleaned.amount,
        currency: cleaned.currency,
        status: result.normalized?.approved ? "success" : "failed",
        resultCode: result.normalized?.resultCode,
    });
    
    return result;
  }

  /**
   * Authorize with a registration token (paymentType=PA).
   * @param {object} params
   * @param {string} params.registrationId
   * @param {number|string} params.amount
   * @param {string} params.currency
   * @param {object} [params.threeDSParams]
   * @param {string} [params.idempotencyKey] - optional idempotency key for request deduplication
   * @param {string} [params.userId] - user ID for transaction tracking (defaults to "system" if not provided)
   * @returns {Promise<object>} normalized result
   */
  async authorizeWithRegistrationToken(params = {}) {
    Logger.debugLog?.(`[Axcess] [authorizeWithRegistrationToken] [START] Processing authorization with registration token`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      registrationId: {
        value: params.registrationId,
        type: "string",
        required: true,
      },
      amount: { value: params.amount, type: "float", required: true },
      currency: { value: params.currency, type: "string", required: true },
      threeDSParams: {
        value: params.threeDSParams || {},
        type: "object",
        required: false,
        default: {},
      },
      idempotencyKey: {
        value: params.idempotencyKey,
        type: "string",
        required: false,
      },
      userId: {
        value: params.userId,
        type: "string",
        required: false,
      },
    });
    
    Logger.debugLog?.(`[Axcess] [authorizeWithRegistrationToken] [VALIDATION] Input validated: registrationId=${cleaned.registrationId}, amount=${cleaned.amount}, currency=${cleaned.currency}`);

    // Generate idempotency key if not provided
    const idempotencyKey = this._generateIdempotencyKey(cleaned.idempotencyKey);
    Logger.debugLog?.(`[Axcess] [authorizeWithRegistrationToken] [IDEMPOTENCY] Using idempotency key: ${idempotencyKey}`);
    
    const endpoint = this._paymentUrl(`/registrations/${encodeURIComponent(cleaned.registrationId)}/payments`).toString();
    
    const currentTimestamp = this._nowUnixSeconds();
    const bodyParams = {
      entityId: this.entityId,
      paymentType: "PA",
      amount: cleaned.amount,
      currency: cleaned.currency,
      // Required for registration token payments
      merchantTransactionId: cleaned.threeDSParams?.merchantTransactionId || `ORDER${currentTimestamp}`,
      testMode: this.testMode,
      // Standing instruction parameters for recurring payments
      'standingInstruction.type': 'RECURRING',
      'standingInstruction.mode': 'REPEATED',
      'standingInstruction.source': 'MIT',
      'standingInstruction.recurringType': 'SUBSCRIPTION',
      // Note: 3DS parameters are NOT supported for registration token payments
    };
    
    Logger.debugLog?.(`[Axcess] [authorizeWithRegistrationToken] [REQUEST] Making authorization request to: ${endpoint}`);
    
    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      userAgent: this.userAgent,
      maxRequestBytes: this.maxRequestBytes,
      maxResponseBytes: this.maxResponseBytes,
      headers: { 
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": idempotencyKey,
      },
      body: toFormUrlEncoded(bodyParams),
      timeout: this.httpTimeoutMs,
    });
    
    Logger.debugLog?.(`[Axcess] [authorizeWithRegistrationToken] [RESPONSE] Received response, processing...`);
    
    const result = await this._handleS2SResponse(res, "authorize_token", cleaned.userId);
    
    this._writeLog("authorizeWithRegistrationToken", "Authorization with registration token processed", {
        registrationId: cleaned.registrationId,
        amount: cleaned.amount,
        currency: cleaned.currency,
        status: result.normalized?.approved ? "success" : "failed",
        resultCode: result.normalized?.resultCode,
    });
    
    return result;
  }

  /**
   * Delete a registration token (if supported for your entity).
   * @param {object} params
   * @param {string} params.registrationId
   * @returns {Promise<boolean>}
   */
  async deleteRegistrationToken(params = {}) {
    Logger.debugLog?.(`[Axcess] [deleteRegistrationToken] [START] Deleting registration token`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      registrationId: {
        value: params.registrationId,
        type: "string",
        required: true,
      },
    });
    
    Logger.debugLog?.(`[Axcess] [deleteRegistrationToken] [VALIDATION] Input validated: registrationId=${cleaned.registrationId}`);
    
    const endpoint = this._paymentUrl(`/registrations/${encodeURIComponent(cleaned.registrationId)}`);
    endpoint.searchParams.set('entityId', this.entityId);
    
    Logger.debugLog?.(`[Axcess] [deleteRegistrationToken] [REQUEST] Making delete request to: ${endpoint.toString()}`);
    
    const res = await httpRequestWithBearer({
      urlString: endpoint.toString(),
      method: "DELETE",
      bearerToken: this.apiBearerToken,
      userAgent: this.userAgent,
      maxRequestBytes: this.maxRequestBytes,
      maxResponseBytes: this.maxResponseBytes,
      timeout: this.httpTimeoutMs,
    });
    
    if (res.status >= 200 && res.status < 300) {
      Logger.debugLog?.(`[Axcess] [deleteRegistrationToken] [SUCCESS] Registration token deleted successfully`);
      
      // Delete local database record to keep state synchronized with gateway
      try {
        if (this._checkServiceMethod('deleteToken', false)) {
          await this.svc.deleteToken(cleaned.registrationId);
          Logger.debugLog?.(`[Axcess] [deleteRegistrationToken] [LOCAL_DELETE] Local token record deleted`);
        }
      } catch (localDeleteError) {
        ErrorHandler.addError("Failed to delete local token record after gateway deletion", {
          code: "LOCAL_TOKEN_DELETE_FAILED",
          origin: "Axcess",
          data: {
            registrationId: cleaned.registrationId,
            error: localDeleteError.message,
          },
        });
        Logger.debugLog?.(`[Axcess] [deleteRegistrationToken] [LOCAL_DELETE_ERROR] Failed to delete local token record: ${localDeleteError.message}`);
        // Continue - gateway deletion succeeded, local deletion failure is logged but doesn't fail the operation
      }
      
      this._writeLog("deleteRegistrationToken", "Registration token deleted", {
          registrationId: cleaned.registrationId,
          status: res.status,
      });
      
      return true;
    }
    
    ErrorHandler.addError("Axcess deleteRegistrationToken failed", {
      code: "DELETE_REGISTRATION_TOKEN_FAILED",
      origin: "Axcess",
      data: {
        status: res.status,
        raw: res.raw,
        registrationId: cleaned.registrationId,
      },
    });
    
    Logger.debugLog?.(`[Axcess] [deleteRegistrationToken] [ERROR] Failed to delete registration token: status ${res.status}`);
    
    return false;
  }

  /**
   * List tokens for a user (pass-through to service).
   * @param {string} userId
   * @returns {Promise<Array>}
   */
  async listUserTokens(userId) {
    Logger.debugLog?.(`[Axcess] [listUserTokens] [START] Listing tokens for user`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      userId: { value: userId, type: "string", required: true },
    });
    
    Logger.debugLog?.(`[Axcess] [listUserTokens] [VALIDATION] Input validated: userId=${cleaned.userId}`);
    
    const tokens = await this.svc.getTokensByUser?.(cleaned.userId);
    
    Logger.debugLog?.(`[Axcess] [listUserTokens] [SUCCESS] Found ${tokens?.length || 0} tokens for user`);
    
    return tokens;
  }

  /**
   * Tokens expiring in a given YYYY-MM.
   * @param {string} yyyymm
   * @returns {Promise<Array>}
   */
  async getTokensExpiring(yyyymm) {
    Logger.debugLog?.(`[Axcess] [getTokensExpiring] [START] Getting tokens expiring in month`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      yyyymm: { value: yyyymm, type: "string", required: true },
    });
    
    Logger.debugLog?.(`[Axcess] [getTokensExpiring] [VALIDATION] Input validated: yyyymm=${cleaned.yyyymm}`);
    
    const tokens = await this.svc.getTokensByExpiry?.(cleaned.yyyymm);
    
    Logger.debugLog?.(`[Axcess] [getTokensExpiring] [SUCCESS] Found ${tokens?.length || 0} tokens expiring in ${cleaned.yyyymm}`);
    
    return tokens;
  }

  /* ============================================================================
   * SECTION D — Subscriptions
   * Docs:
   *  https://axcessms.docs.oppwa.com/integrations/subscriptions
   * ========================================================================== */

  // sub test for daily, weekly, monthly, end of month, quarterly, yearly
  // Cancel Sub didn't show gatway or db
  // test upgrade Subscription
  // first charge the additional amount
  // then cancel the schedule_rescheduled
  // create a new schedule with the new amount
  // test downgrade Subscription
  // when downgrading we fist cancel the current schedule with the old amount, and create a new schedule with the new amount
  // test Pause 
  // test Resume
  // to preserver the old schedule id we keep the data on the db with updated status

  /**
   * Create a subscription schedule using a registration token.
   * @param {object} params
   * @param {string} params.registrationId
   * @param {number|string} params.amount
   * @param {string} params.currency
   * @param {string} params.interval - e.g., 'P1M' (ISO 8601 period) or provider-specific
   * @param {string} [params.startDate] - yyyy-MM-dd
   * @param {object} [params.trial] - { amount, lengthDays }
   * @returns {Promise<{status:string, scheduleId?:string}>}
   *
   * Docs: Subscriptions
   * https://axcessms.docs.oppwa.com/integrations/subscriptions
   */
  async createSubscriptionFromToken(params = {}) {
    Logger.debugLog?.(`[Axcess] [createSubscriptionFromToken] [START] Creating subscription from token`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      registrationId: {
        value: params.registrationId,
        type: "string",
        required: true,
      },
      amount: { value: params.amount, type: "float", required: true },
      currency: { value: params.currency, type: "string", required: true },
      interval: { value: params.interval, type: "string", required: true },
      startDate: { value: params.startDate, type: "string", required: false },
      trial: {
        value: params.trial || {},
        type: "object",
        required: false,
        default: {},
      },
      userId: { value: params.userId, type: "string", required: true },
    });

    Logger.debugLog?.(`[Axcess] [createSubscriptionFromToken] [VALIDATION] Input validated: registrationId=${cleaned.registrationId}, amount=${cleaned.amount}, currency=${cleaned.currency}, interval=${cleaned.interval}`);

    // Standardize on the scheduling API for subscriptions (schedules)
    const scheduleRes = await this.createSchedule({
      registrationId: cleaned.registrationId,
      amount: cleaned.amount,
      currency: cleaned.currency,
      schedule: cleaned.interval,
      subscriptionPlan: params.subscriptionPlan,
      userId: cleaned.userId,
    });

    this._writeLog("createSubscriptionFromToken", "Subscription schedule created from token", {
      registrationId: cleaned.registrationId,
      scheduleId: scheduleRes.scheduleId,
      userId: cleaned.userId,
      amount: cleaned.amount,
      currency: cleaned.currency,
      interval: cleaned.interval,
    });

    return { status: scheduleRes.status, scheduleId: scheduleRes.scheduleId };
  }

  /**
   * Cancel subscription (future billings).
   * @param {object} params
   * @param {string} params.subscriptionId
   * @param {string} [params.reason]
   * @returns {Promise<{status:string}>}
   */
  async cancelSubscription(params = {}) {
    Logger.debugLog?.(`[Axcess] [cancelSubscription] [START] Canceling subscription`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      subscriptionId: {
        value: params.subscriptionId,
        type: "string",
        required: true,
      },
      reason: { value: params.reason, type: "string", required: false },
    });

    Logger.debugLog?.(`[Axcess] [cancelSubscription] [VALIDATION] Input validated: subscriptionId=${cleaned.subscriptionId}`);

    // Standardize on the scheduling API for subscriptions (schedules)
    await this.cancelSchedule({ scheduleId: cleaned.subscriptionId });

    try {
      await this.svc.updateSchedule?.(cleaned.subscriptionId, {
        status: "canceled",
        updatedAt: this._now(),
        reason: cleaned.reason || null,
      });
    } catch (updateError) {
      ErrorHandler.addError("Failed to update schedule in DB", {
        code: "UPDATE_SCHEDULE_FAILED",
        origin: "Axcess",
        data: {
          subscriptionId: cleaned.subscriptionId,
          error: updateError.message,
        },
      });
      throw updateError;
    }

    this._writeLog("cancelSubscription", "Subscription canceled", {
      subscriptionId: cleaned.subscriptionId,
      reason: cleaned.reason || null,
    });

    return { status: "canceled" };
  }

  /**
   * Pause subscription (policy: cancel now, store resume instruction)
   * @param {object} params
   * @param {string} params.subscriptionId
   * @param {string} params.resumeAt - yyyy-MM-dd
   * @returns {Promise<{status:string, resumeAt:string}>}
   */
  async pauseSubscription(params = {}) {
    Logger.debugLog?.(`[Axcess] [pauseSubscription] [START] Pausing subscription`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      subscriptionId: {
        value: params.subscriptionId,
        type: "string",
        required: true,
      },
      resumeAt: { value: params.resumeAt, type: "string", required: true },
    });
    
    Logger.debugLog?.(`[Axcess] [pauseSubscription] [VALIDATION] Input validated: subscriptionId=${cleaned.subscriptionId}, resumeAt=${cleaned.resumeAt}`);
    
    Logger.debugLog?.(`[Axcess] [pauseSubscription] [CANCEL] Canceling schedule before pausing`);
    
    await this.cancelSchedule({
      scheduleId: cleaned.subscriptionId,
    });
    
    Logger.debugLog?.(`[Axcess] [pauseSubscription] [UPDATE] Updating schedule status to paused`);
    
    await this.svc.updateSchedule?.(cleaned.subscriptionId, {
      status: "paused",
      resumeAt: cleaned.resumeAt,
      pausedAt: this._now(),
    });
    
    Logger.debugLog?.(`[Axcess] [pauseSubscription] [SUCCESS] Subscription paused successfully`);
    
    this._writeLog("pauseSubscription", "Subscription paused", {
        subscriptionId: cleaned.subscriptionId,
        resumeAt: cleaned.resumeAt,
    });
    
    return { status: "paused", resumeAt: cleaned.resumeAt };
  }

  /**
   * Resume subscription = create new schedule from token (your policy).
   * @param {object} params
   * @param {string} params.userId
   * @param {string} params.registrationId
   * @param {object} params.recurringShape - { amount, currency, interval, startDate? }
   * @returns {Promise<{status:string, scheduleId?:string}>}
   */
  async resumeSubscription(params = {}) {
    Logger.debugLog?.(`[Axcess] [resumeSubscription] [START] Resuming subscription`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      userId: { value: params.userId, type: "string", required: true },
      registrationId: {
        value: params.registrationId,
        type: "string",
        required: true,
      },
      recurringShape: {
        value: params.recurringShape,
        type: "object",
        required: true,
      },
    });
    
    Logger.debugLog?.(`[Axcess] [resumeSubscription] [VALIDATION] Input validated: userId=${cleaned.userId}, registrationId=${cleaned.registrationId}`);
    
    Logger.debugLog?.(`[Axcess] [resumeSubscription] [CREATE] Creating new schedule from token`);
    
    const res = await this.createSchedule({
      registrationId: cleaned.registrationId,
      amount: cleaned.recurringShape.amount,
      currency: cleaned.recurringShape.currency,
      schedule: cleaned.recurringShape.interval,
      subscriptionPlan: cleaned.recurringShape.subscriptionPlan
    });
    
    Logger.debugLog?.(`[Axcess] [resumeSubscription] [SUCCESS] Subscription resumed successfully: scheduleId=${res.scheduleId || null}`);
    
    this._writeLog("resumeSubscription", "Subscription resumed", {
        userId: cleaned.userId,
        registrationId: cleaned.registrationId,
        scheduleId: res.scheduleId || null,
    });
    
    return { status: "resumed", scheduleId: res.scheduleId || null };
  }

  /**
   * Upgrade subscription = immediate proration debit + recreate schedule with higher price.
   * @param {object} params
   * @param {string} params.subscriptionId
   * @param {number|string} params.prorationCharge
   * @param {object} params.newRecurring - { registrationId, amount, currency, interval, startDate? }
   * @returns {Promise<{status:string, scheduleId?:string}>}
   */
  async upgradeSubscription(params = {}) {
    Logger.debugLog?.(`[Axcess] [upgradeSubscription] [START] Upgrading subscription`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      subscriptionId: {
        value: params.subscriptionId,
        type: "string",
        required: true,
      },
      prorationCharge: {
        value: params.prorationCharge,
        type: "float",
        required: true,
      },
      newRecurring: {
        value: params.newRecurring,
        type: "object",
        required: true,
      },
    });

    Logger.debugLog?.(`[Axcess] [upgradeSubscription] [VALIDATION] Input validated: subscriptionId=${cleaned.subscriptionId}, prorationCharge=${cleaned.prorationCharge}`);

    // Charge proration immediately (token required)
    if (!cleaned.newRecurring.registrationId) {
      ErrorHandler.addError("upgradeSubscription requires newRecurring.registrationId for proration charge", {
        code: "MISSING_REGISTRATION_ID",
        origin: "Axcess",
        data: {
          subscriptionId: cleaned.subscriptionId,
        },
      });
      throw createAxcessError("upgradeSubscription requires newRecurring.registrationId for proration charge", {
        code: "MISSING_REGISTRATION_ID",
        data: { subscriptionId: cleaned.subscriptionId },
      });
    }
    
    Logger.debugLog?.(`[Axcess] [upgradeSubscription] [PRORATION] Charging proration amount`);
    
    // Step 1: Charge proration - track payment ID for potential refund
    let prorationPaymentId = null;
    let prorationDebitResult = null;
    try {
      prorationDebitResult = await this.debitWithRegistrationToken({
      registrationId: cleaned.newRecurring.registrationId,
      amount: cleaned.prorationCharge,
      currency: cleaned.newRecurring.currency,
    });
      prorationPaymentId = prorationDebitResult?.normalized?.id || prorationDebitResult?.raw?.id || null;
      Logger.debugLog?.(`[Axcess] [upgradeSubscription] [PRORATION] Proration charged: paymentId=${prorationPaymentId}`);
    } catch (debitError) {
      ErrorHandler.addError("Failed to charge proration for subscription upgrade", {
        code: "UPGRADE_PRORATION_CHARGE_FAILED",
        origin: "Axcess",
        data: {
          subscriptionId: cleaned.subscriptionId,
          prorationCharge: cleaned.prorationCharge,
          error: debitError.message,
        },
      });
      throw debitError; // Fail fast if proration charge fails
    }

    Logger.debugLog?.(`[Axcess] [upgradeSubscription] [CANCEL] Canceling current schedule`);
    
    // Step 2: Cancel current schedule - track for potential restoration
    let oldScheduleCanceled = false;
    try {
    await this.cancelSchedule({
      scheduleId: cleaned.subscriptionId,
    });
      oldScheduleCanceled = true;
      Logger.debugLog?.(`[Axcess] [upgradeSubscription] [CANCEL] Old schedule canceled successfully`);
    } catch (cancelError) {
      // Compensation: Refund proration charge if cancel fails
      Logger.debugLog?.(`[Axcess] [upgradeSubscription] [COMPENSATE] Cancel failed, refunding proration charge`);
      ErrorHandler.addError("Failed to cancel old schedule during upgrade, refunding proration", {
        code: "UPGRADE_CANCEL_FAILED",
        origin: "Axcess",
        data: {
          subscriptionId: cleaned.subscriptionId,
          prorationPaymentId: prorationPaymentId,
          error: cancelError.message,
        },
      });
      
      if (prorationPaymentId) {
        try {
          await this.s2sRefund({
            paymentId: prorationPaymentId,
            amount: cleaned.prorationCharge,
            currency: cleaned.newRecurring.currency,
          });
          Logger.debugLog?.(`[Axcess] [upgradeSubscription] [COMPENSATE] Proration refunded successfully`);
        } catch (refundError) {
          ErrorHandler.addError("Failed to refund proration after cancel failure - manual intervention required", {
            code: "UPGRADE_REFUND_FAILED",
            origin: "Axcess",
            data: {
              subscriptionId: cleaned.subscriptionId,
              prorationPaymentId: prorationPaymentId,
              refundError: refundError.message,
            },
          });
          Logger.debugLog?.(`[Axcess] [upgradeSubscription] [COMPENSATE_ERROR] Failed to refund proration: ${refundError.message}`);
        }
      }
      throw cancelError; // Re-throw cancel error
    }
    
    Logger.debugLog?.(`[Axcess] [upgradeSubscription] [CREATE] Creating new schedule`);
    
    // Step 3: Create new schedule - if this fails, we can't restore old schedule but should refund
    let newSchedule = null;
    try {
      newSchedule = await this.createSchedule({
      registrationId: cleaned.newRecurring.registrationId,
      amount: cleaned.newRecurring.amount,
      currency: cleaned.newRecurring.currency,
      schedule: cleaned.newRecurring.interval,
      subscriptionPlan: cleaned.newRecurring.subscriptionPlan
    });
      Logger.debugLog?.(`[Axcess] [upgradeSubscription] [CREATE] New schedule created successfully`);
    } catch (createError) {
      // Compensation: Refund proration charge if create fails (can't restore old schedule)
      Logger.debugLog?.(`[Axcess] [upgradeSubscription] [COMPENSATE] Create failed, refunding proration charge`);
      ErrorHandler.addError("Failed to create new schedule during upgrade, refunding proration", {
        code: "UPGRADE_CREATE_FAILED",
        origin: "Axcess",
        data: {
          subscriptionId: cleaned.subscriptionId,
          prorationPaymentId: prorationPaymentId,
          error: createError.message,
        },
      });
      
      if (prorationPaymentId) {
        try {
          await this.s2sRefund({
            paymentId: prorationPaymentId,
            amount: cleaned.prorationCharge,
            currency: cleaned.newRecurring.currency,
          });
          Logger.debugLog?.(`[Axcess] [upgradeSubscription] [COMPENSATE] Proration refunded successfully`);
        } catch (refundError) {
          ErrorHandler.addError("Failed to refund proration after create failure - manual intervention required", {
            code: "UPGRADE_REFUND_FAILED",
            origin: "Axcess",
            data: {
              subscriptionId: cleaned.subscriptionId,
              prorationPaymentId: prorationPaymentId,
              refundError: refundError.message,
            },
          });
          Logger.debugLog?.(`[Axcess] [upgradeSubscription] [COMPENSATE_ERROR] Failed to refund proration: ${refundError.message}`);
        }
      }
      throw createError; // Re-throw create error
    }

    Logger.debugLog?.(`[Axcess] [upgradeSubscription] [SUCCESS] Subscription upgraded successfully: scheduleId=${newSchedule.scheduleId || null}`);
    
    this._writeLog("upgradeSubscription", "Subscription upgraded", {
        subscriptionId: cleaned.subscriptionId,
        newScheduleId: newSchedule.scheduleId || null,
        prorationCharge: cleaned.prorationCharge,
        newAmount: cleaned.newRecurring.amount,
        newCurrency: cleaned.newRecurring.currency,
    });

    return {
      status: "upgrade_scheduled",
      scheduleId: newSchedule.scheduleId || null,
    };
  }

  /**
   * Downgrade subscription = schedule for next period.
   * @param {object} params
   * @param {string} params.subscriptionId
   * @param {string} params.effectiveAt - yyyy-MM-dd
   * @param {object} params.newRecurring - { registrationId, amount, currency, interval }
   * @returns {Promise<{status:string, effectiveAt:string}>}
   */
  async downgradeSubscription(params = {}) {
    Logger.debugLog?.(`[Axcess] [downgradeSubscription] [START] Downgrading subscription`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      subscriptionId: {
        value: params.subscriptionId,
        type: "string",
        required: true,
      },
      effectiveAt: {
        value: params.effectiveAt,
        type: "string",
        required: true,
      },
      newRecurring: {
        value: params.newRecurring,
        type: "object",
        required: true,
      },
    });

    Logger.debugLog?.(`[Axcess] [downgradeSubscription] [VALIDATION] Input validated: subscriptionId=${cleaned.subscriptionId}, effectiveAt=${cleaned.effectiveAt}`);

    Logger.debugLog?.(`[Axcess] [downgradeSubscription] [CANCEL] Canceling current schedule`);
    
    // Cancel current schedule
    await this.cancelSchedule({
      scheduleId: cleaned.subscriptionId,
    });

    Logger.debugLog?.(`[Axcess] [downgradeSubscription] [CREATE] Creating new schedule with downgraded amount`);
    
    // Create new schedule with downgraded amount
    const newSchedule = await this.createSchedule({
      registrationId: cleaned.newRecurring.registrationId,
      amount: cleaned.newRecurring.amount,
      currency: cleaned.newRecurring.currency,
      schedule: cleaned.newRecurring.interval,
      subscriptionPlan: cleaned.newRecurring.subscriptionPlan
    });

    Logger.debugLog?.(`[Axcess] [downgradeSubscription] [UPDATE] Updating database with downgrade information`);
    
    // Update database with downgrade information
    await this.svc.updateSchedule?.(cleaned.subscriptionId, {
      status: "downgrade_scheduled",
      effectiveAt: cleaned.effectiveAt,
      newRecurring: cleaned.newRecurring,
      downgradedAt: this._now(),
    });

    Logger.debugLog?.(`[Axcess] [downgradeSubscription] [SUCCESS] Subscription downgraded successfully: scheduleId=${newSchedule.scheduleId || null}`);
    
    this._writeLog("downgradeSubscription", "Subscription downgraded", {
        subscriptionId: cleaned.subscriptionId,
        effectiveAt: cleaned.effectiveAt,
        newScheduleId: newSchedule.scheduleId || null,
        newAmount: cleaned.newRecurring.amount,
        newCurrency: cleaned.newRecurring.currency,
    });

    return {
      status: "downgrade_scheduled",
      effectiveAt: cleaned.effectiveAt,
      scheduleId: newSchedule.scheduleId || null
    };
  }

  // ===== SCHEDULING API METHODS =====

  /**
   * Create a subscription schedule using the scheduling API.
   * @param {object} params
   * @param {string} params.registrationId - required
   * @param {number} params.amount - required
   * @param {string} params.currency - required
   * @param {string} params.schedule - required (daily, weekly, monthly, etc.)
   * @param {string} [params.subscriptionPlan] - optional
   * @returns {Promise<{status:string, scheduleId?:string}>}
   */
  async createSchedule(params = {}) {
    Logger.debugLog?.(`[Axcess] [createSchedule] [START] Creating subscription schedule`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      registrationId: {
        value: params.registrationId,
        type: "string",
        required: true,
      },
      amount: { value: params.amount, type: "float", required: true },
      currency: { value: params.currency, type: "string", required: true },
      schedule: { value: params.schedule, type: "string", required: true },
      subscriptionPlan: { value: params.subscriptionPlan, type: "string", required: false },
      userId: { value: params.userId, type: "string", required: true },
    });

    Logger.debugLog?.(`[Axcess] [createSchedule] [VALIDATION] Input validated: registrationId=${cleaned.registrationId}, amount=${cleaned.amount}, currency=${cleaned.currency}, schedule=${cleaned.schedule}`);

    // Build job schedule parameters based on schedule type
    const jobSchedule = this.buildJobSchedule(cleaned.schedule);

    const bodyParams = {
      entityId: this.entityId,
      amount: this._formatAmount(cleaned.amount, cleaned.currency),
      paymentType: 'DB',
      registrationId: cleaned.registrationId,
      currency: (cleaned.currency || "").toUpperCase().slice(0, 3),
      testMode: this.testMode,
      'standingInstruction.type': 'RECURRING',
      'standingInstruction.mode': 'REPEATED',
      'standingInstruction.source': 'MIT',
      'standingInstruction.recurringType': 'SUBSCRIPTION',
      ...jobSchedule
    };

    const endpoint = this._schedulingUrl("/schedules").toString();
    
    Logger.debugLog?.(`[Axcess] [createSchedule] [REQUEST] Making schedule creation request to: ${endpoint}`);
    
    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      userAgent: this.userAgent,
      maxRequestBytes: this.maxRequestBytes,
      maxResponseBytes: this.maxResponseBytes,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: toFormUrlEncoded(bodyParams),
      timeout: this.httpTimeoutMs,
    });

    Logger.debugLog?.(`[Axcess] [createSchedule] [RESPONSE] Raw Gateway Response - Status: ${res.status}, Data: ${JSON.stringify(res.data, null, 2)}`);

    if (res.status < 200 || res.status >= 300) {
      ErrorHandler.addError("Axcess createSchedule failed", {
        code: "CREATE_SCHEDULE_FAILED",
        origin: "Axcess",
        data: {
          status: res.status,
          raw: res.raw,
          registrationId: cleaned.registrationId,
        },
      });
      throw createAxcessError(`Schedule creation failed: ${res.data?.result?.description || 'Unknown error'}`, {
        code: "CREATE_SCHEDULE_FAILED",
        status: res.status,
        raw: res.raw,
      });
    }

    const userId = cleaned.userId;
    const scheduleId = res.data?.id || null;

    Logger.debugLog?.(`[Axcess] [createSchedule] [PROCESSING] Creating schedule record: scheduleId=${scheduleId}, userId=${userId}`);

    const schedule = {
      pk: `user#${userId}`,
      sk: `schedule#${scheduleId}`,
      userId: userId,
      registrationId: cleaned.registrationId,
      scheduleId: scheduleId,
      status: "active",
      amount: this._formatAmount(cleaned.amount, cleaned.currency),
      currency: cleaned.currency,
      schedule: cleaned.schedule,
      subscriptionPlan: cleaned.subscriptionPlan,
      createdAt: this._now(),
    };

    this._checkServiceMethod('saveSchedule', true);
    await this.svc.saveSchedule(schedule);
    
    Logger.debugLog?.(`[Axcess] [createSchedule] [SUCCESS] Schedule created successfully: scheduleId=${schedule.scheduleId}`);
    
    this._writeLog("createSchedule", "Subscription schedule created", {
        registrationId: cleaned.registrationId,
        scheduleId: schedule.scheduleId,
        userId: userId,
        amount: cleaned.amount,
        currency: cleaned.currency,
        schedule: cleaned.schedule,
    });
    
    return { status: "active", scheduleId: schedule.scheduleId };
  }

  /**
   * Cancel a subscription schedule using the scheduling API.
   * @param {object} params
   * @param {string} params.scheduleId - required
   * @returns {Promise<{status:string}>}
   */
  async cancelSchedule(params = {}) {
    Logger.debugLog?.(`[Axcess] [cancelSchedule] [START] Canceling subscription schedule`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      scheduleId: {
        value: params.scheduleId,
        type: "string",
        required: true,
      },
    });

    Logger.debugLog?.(`[Axcess] [cancelSchedule] [VALIDATION] Input validated: scheduleId=${cleaned.scheduleId}`);

    const endpoint = this._schedulingUrl(`/schedules/${encodeURIComponent(cleaned.scheduleId)}`);
    endpoint.searchParams.set('entityId', this.entityId);
    endpoint.searchParams.set('testMode', this.testMode);
    
    Logger.debugLog?.(`[Axcess] [cancelSchedule] [REQUEST] Making cancel request to: ${endpoint.toString()}`);
    
    const res = await httpRequestWithBearer({
      urlString: endpoint.toString(),
      method: "DELETE",
      bearerToken: this.apiBearerToken,
      userAgent: this.userAgent,
      maxRequestBytes: this.maxRequestBytes,
      maxResponseBytes: this.maxResponseBytes,
      timeout: this.httpTimeoutMs,
    });

    Logger.debugLog?.(`[Axcess] [cancelSchedule] [RESPONSE] Raw Gateway Response - Status: ${res.status}, Data: ${JSON.stringify(res.data, null, 2)}`);

    if (res.status < 200 || res.status >= 300) {
      ErrorHandler.addError("Axcess cancelSchedule failed", {
        code: "CANCEL_SCHEDULE_FAILED",
        origin: "Axcess",
        data: {
          status: res.status,
          raw: res.raw,
          scheduleId: cleaned.scheduleId,
        },
      });
      throw createAxcessError(`Schedule cancellation failed: ${res.data?.result?.description || 'Unknown error'}`, {
        code: "CANCEL_SCHEDULE_FAILED",
        status: res.status,
        raw: res.raw,
        data: { scheduleId: cleaned.scheduleId },
      });
    }

    Logger.debugLog?.(`[Axcess] [cancelSchedule] [UPDATE] Updating schedule status to cancelled`);

    await this.svc.updateSchedule?.(cleaned.scheduleId, {
      status: "cancelled",
      cancelledAt: this._now(),
    });

    Logger.debugLog?.(`[Axcess] [cancelSchedule] [SUCCESS] Schedule cancelled successfully`);
    
    this._writeLog("cancelSchedule", "Subscription schedule cancelled", {
        scheduleId: cleaned.scheduleId,
    });

    return { status: "cancelled" };
  }

  /**
   * Reschedule a subscription by cancelling and recreating with new schedule.
   * @param {object} params
   * @param {string} params.scheduleId - required
   * @param {string} params.newSchedule - required
   * @param {number} [params.newAmount] - optional
   * @param {string} [params.newCurrency] - optional
   * @returns {Promise<{status:string, scheduleId?:string}>}
   */
  async rescheduleSubscription(params = {}) {
    Logger.debugLog?.(`[Axcess] [rescheduleSubscription] [START] Rescheduling subscription`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      scheduleId: {
        value: params.scheduleId,
        type: "string",
        required: true,
      },
      newSchedule: {
        value: params.newSchedule,
        type: "string",
        required: true,
      },
      newAmount: { value: params.newAmount, type: "float", required: false },
      newCurrency: { value: params.newCurrency, type: "string", required: false },
    });

    Logger.debugLog?.(`[Axcess] [rescheduleSubscription] [VALIDATION] Input validated: scheduleId=${cleaned.scheduleId}, newSchedule=${cleaned.newSchedule}`);

    // Get original subscription details
    const originalSubscription = await this.svc.getScheduleById?.(cleaned.scheduleId);
    if (!originalSubscription) {
      ErrorHandler.addError("Original subscription not found", {
        code: "SUBSCRIPTION_NOT_FOUND",
        origin: "Axcess",
        data: {
          scheduleId: cleaned.scheduleId,
        },
      });
      throw createAxcessError("Original subscription not found", {
        code: "SUBSCRIPTION_NOT_FOUND",
        data: { scheduleId: cleaned.scheduleId },
      });
    }

    Logger.debugLog?.(`[Axcess] [rescheduleSubscription] [CANCEL] Step 1: Cancelling existing schedule`);
    
    // Cancel existing schedule
    await this.cancelSchedule({ scheduleId: cleaned.scheduleId });

    Logger.debugLog?.(`[Axcess] [rescheduleSubscription] [CREATE] Step 2: Creating new schedule with updated parameters`);
    
    // Create new schedule with updated parameters
    const newScheduleParams = {
      registrationId: originalSubscription.registrationId,
      amount: cleaned.newAmount || originalSubscription.amount,
      currency: cleaned.newCurrency || originalSubscription.currency,
      schedule: cleaned.newSchedule,
      subscriptionPlan: originalSubscription.subscriptionPlan
    };

    const newSchedule = await this.createSchedule(newScheduleParams);

    Logger.debugLog?.(`[Axcess] [rescheduleSubscription] [UPDATE] Updating original subscription record`);

    // Update original subscription record
    await this.svc.updateSchedule?.(cleaned.scheduleId, {
      ...newScheduleParams,
      status: 'active',
      rescheduledAt: this._now(),
    });

    Logger.debugLog?.(`[Axcess] [rescheduleSubscription] [SUCCESS] Subscription rescheduled successfully: newScheduleId=${newSchedule.scheduleId}`);
    
    this._writeLog("rescheduleSubscription", "Subscription rescheduled", {
        originalScheduleId: cleaned.scheduleId,
        newScheduleId: newSchedule.scheduleId,
        newSchedule: cleaned.newSchedule,
        newAmount: cleaned.newAmount || originalSubscription.amount,
        newCurrency: cleaned.newCurrency || originalSubscription.currency,
    });

    return {
      status: "rescheduled",
      scheduleId: newSchedule.scheduleId,
      originalScheduleId: cleaned.scheduleId
    };
  }

  /**
   * Helper method to build job schedule parameters.
   * @param {string} schedule - schedule type
   * @returns {object} job parameters
   */
  buildJobSchedule(schedule) {
    const schedules = {
      'daily': {
        'job.second': '0',
        'job.minute': '0',
        'job.hour': '9',
        'job.dayOfMonth': '*',
        'job.month': '*',
        'job.dayOfWeek': '?',
        'job.year': '*'
      },
      'weekly': {
        'job.second': '0',
        'job.minute': '0',
        'job.hour': '9',
        'job.dayOfMonth': '?',
        'job.month': '*',
        'job.dayOfWeek': 'TUE',
        'job.year': '*'
      },
      'monthly': {
        'job.second': '0',
        'job.minute': '0',
        'job.hour': '9',
        'job.dayOfMonth': '5',
        'job.month': '*',
        'job.dayOfWeek': '?',
        'job.year': '*'
      },
      'monthly-last-day': {
        'job.second': '0',
        'job.minute': '0',
        'job.hour': '9',
        'job.dayOfMonth': 'L',
        'job.month': '*',
        'job.dayOfWeek': '?',
        'job.year': '*'
      },
      'quarterly': {
        'job.second': '0',
        'job.minute': '0',
        'job.hour': '9',
        'job.dayOfMonth': '1',
        'job.month': '*/3',
        'job.dayOfWeek': '?',
        'job.year': '*'
      },
      'yearly': {
        'job.second': '0',
        'job.minute': '0',
        'job.hour': '9',
        'job.dayOfMonth': '1',
        'job.month': 'JAN',
        'job.dayOfWeek': '?',
        'job.year': '*'
      }
    };

    return schedules[schedule] || schedules['monthly'];
  }

  /* ============================================================================
   * SECTION E — Webhooks (Encrypted)
   * Docs:
   *  https://axcessms.docs.oppwa.com/tutorials/webhooks/configuration
   *  https://axcessms.docs.oppwa.com/tutorials/webhooks/payload
   *  https://axcessms.docs.oppwa.com/tutorials/webhooks/decryption
   * ========================================================================== */

  /**
   * Decrypt and (optionally) verify webhook payload using AES-256-GCM or AES-256-CBC.
   * Cipher mode is configurable via webhookConfig.cipherMode ('GCM' or 'CBC', defaults to 'GCM').
   * NOTE: Header names and signature algorithm can vary; configure in this.webhookConfig.
   * @param {string|Buffer} rawBody - the raw request body as received
   * @param {object} headers - incoming headers
   * @returns {{ decryptedJson: object, idempotencyKey?: string, verified: boolean }}
   */
  // decryptAndVerifyWebhook(rawBody, headers = {}) {
  //   if (!this.webhookConfig.secretKey) {
  //     throw new Error("Webhook secretKey is not configured");
  //   }
  //   console.log("Webhook secretKey is configured", rawBody, headers);
  //   try {
  //     const ivHeader = this.webhookConfig.ivHeaderName.toLowerCase();
  //     console.log("ivHeader", ivHeader);
  //     const sigHeader = this.webhookConfig.sigHeaderName.toLowerCase();
  //     console.log("sigHeader", sigHeader);
  //     const ivBase64 = headers[ivHeader] || headers[ivHeader.toLowerCase()];
  //     console.log("ivBase64", ivBase64);
  //     const signature = headers[sigHeader] || headers[sigHeader.toLowerCase()];
  //     console.log("signature", signature);
  //     const iv = ivBase64 ? Buffer.from(String(ivBase64), "base64") : null;

  //     // Decrypt AES-256-CBC: ciphertext is base64 in body; alternatively, rawBody may already be decrypted JSON.
  //     let plaintext = null;
  //     const bodyStr = Buffer.isBuffer(rawBody)
  //       ? rawBody.toString("utf8")
  //       : String(rawBody || "");
  //     const maybeJson = bodyStr.trim().startsWith("{") ? bodyStr : null;

  //     if (maybeJson) {
  //       plaintext = maybeJson; // already plaintext JSON
  //     } else {
  //       const cipherBuf = Buffer.from(bodyStr, "base64");
  //       const key = this._coerceKeyTo32Bytes(this.webhookConfig.secretKey);
  //       if (!iv) {
  //         throw new Error("Missing IV header for webhook decryption");
  //       }
  //       const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  //       const decrypted = Buffer.concat([
  //         decipher.update(cipherBuf),
  //         decipher.final(),
  //       ]);
  //       plaintext = decrypted.toString("utf8");
  //     }

  //     // Optional HMAC verification (if you configure to use HMAC-SHA256)
  //     let verified = true;
  //     if (signature) {
  //       const key = this._coerceKeyTo32Bytes(this.webhookConfig.secretKey);
  //       const h = crypto
  //         .createHmac("sha256", key)
  //         .update(plaintext)
  //         .digest("hex");
  //       verified = crypto.timingSafeEqual(
  //         Buffer.from(h, "hex"),
  //         Buffer.from(signature.replace(/^0x/, ""), "hex")
  //       );
  //     }

  //     const decryptedJson = JSON.parse(plaintext);
  //     const idempotencyKey =
  //       decryptedJson?.id ||
  //       decryptedJson?.eventId ||
  //       decryptedJson?.payloadId ||
  //       null;

  //     return { decryptedJson, idempotencyKey, verified };
  //   } catch (e) {
  //     ErrorHandler.add_error("Axcess webhook decrypt/verify failed", {
  //       error: e.message,
  //     });
  //     throw e;
  //   }
  // }

  decryptAndVerifyWebhook(rawBody, headers = {}) {
    Logger.debugLog?.(`[Axcess] [decryptAndVerifyWebhook] [START] Decrypting and verifying webhook`);
    const normalizedRawBody = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;
    const cleaned = SafeUtils.sanitizeValidate({
      rawBody: { value: normalizedRawBody, type: "string", required: true },
      headers: { value: headers, type: "object", required: false, default: {} },
    });

    // Payload size limit (protects against memory exhaustion)
    const rawBytes = Buffer.byteLength(String(cleaned.rawBody || ""), "utf8");
    if (rawBytes > (this.webhookConfig.maxBytes || DEFAULT_MAX_WEBHOOK_BYTES)) {
      throw createAxcessError(`Webhook body exceeds max size (${this.webhookConfig.maxBytes} bytes)`, {
        code: "WEBHOOK_BODY_TOO_LARGE",
        data: { maxBytes: this.webhookConfig.maxBytes, actualBytes: rawBytes },
      });
    }

    if (!this.webhookConfig.secretKey) {
      ErrorHandler.addError("Webhook secretKey is not configured", {
        code: "WEBHOOK_SECRET_NOT_CONFIGURED",
        origin: "Axcess",
      });
      throw createAxcessError("Webhook secretKey is not configured", {
        code: "WEBHOOK_SECRET_NOT_CONFIGURED",
      });
    }

    try {
      Logger.debugLog?.(`[Axcess] [decryptAndVerifyWebhook] [PROCESSING] Normalizing headers`);
      
      // Normalize header names
      // Use Object.keys() instead of Object.entries() to avoid temporary array allocations
      const h = this._normalizeHeaders(cleaned.headers || {});
      this._assertAllowedIncomingContentType(h);

      // Determine cipher mode (GCM or CBC)
      const cipherMode = this.webhookConfig.cipherMode || "GCM";
      Logger.debugLog?.(`[Axcess] [decryptAndVerifyWebhook] [MODE] Using cipher mode: ${cipherMode}`);

      // Axcess headers (fall back to your config if present)
      const ivValue =
        h["x-initialization-vector"] ||
        h[this.webhookConfig.ivHeaderName?.toLowerCase() || ""] ||
        null;

      const tagValue =
        h["x-authentication-tag"] ||
        h[this.webhookConfig.sigHeaderName?.toLowerCase() || ""] ||
        null;

      if (!ivValue) {
        ErrorHandler.addError("Missing X-Initialization-Vector header", {
          code: "MISSING_IV_HEADER",
          origin: "Axcess",
        });
        throw createAxcessError("Missing X-Initialization-Vector header", {
          code: "MISSING_IV_HEADER",
        });
      }
      
      // Authentication tag is required for GCM mode
      if (cipherMode === "GCM" && !tagValue) {
        ErrorHandler.addError("Missing X-Authentication-Tag header (required for GCM mode)", {
          code: "MISSING_TAG_HEADER",
          origin: "Axcess",
        });
        throw createAxcessError("Missing X-Authentication-Tag header (required for GCM mode)", {
          code: "MISSING_TAG_HEADER",
        });
      }

      Logger.debugLog?.(`[Axcess] [decryptAndVerifyWebhook] [PROCESSING] Parsing webhook body`);
      
      // Body parsing: GCM uses hex, CBC may use base64 or hex
      const bodyStr = Buffer.isBuffer(cleaned.rawBody)
        ? cleaned.rawBody.toString("utf8")
        : String(cleaned.rawBody || "");
      
      let cipherBuf;
      let plaintext;
      
      // Check if body is already plaintext JSON (for CBC mode fallback)
      const maybeJson = bodyStr.trim().startsWith("{") ? bodyStr : null;
      
      if (maybeJson && cipherMode === "CBC") {
        // Already plaintext JSON (CBC mode fallback)
        plaintext = maybeJson;
      } else {
        // Parse encrypted body
        let cipherText;
      try {
        const parsed = JSON.parse(bodyStr);
          cipherText = parsed?.encryptedBody || bodyStr.trim();
      } catch {
          cipherText = bodyStr.trim();
        }
        
        // Determine encoding: GCM uses hex, CBC may use base64 or hex
        if (cipherMode === "GCM") {
          // GCM: expect hex format
          if (!cipherText || !/^[0-9a-fA-F]+$/.test(cipherText)) {
            ErrorHandler.addError("Webhook body does not contain valid hex ciphertext (GCM mode)", {
          code: "INVALID_CIPHERTEXT",
          origin: "Axcess",
        });
            throw createAxcessError("Webhook body does not contain valid hex ciphertext (GCM mode)", {
              code: "INVALID_CIPHERTEXT",
            });
          }
          cipherBuf = Buffer.from(cipherText, "hex");
        } else {
          // CBC: try base64 first, then hex
          try {
            cipherBuf = Buffer.from(cipherText, "base64");
          } catch {
            if (/^[0-9a-fA-F]+$/.test(cipherText)) {
              cipherBuf = Buffer.from(cipherText, "hex");
            } else {
              ErrorHandler.addError("Webhook body does not contain valid base64 or hex ciphertext (CBC mode)", {
                code: "INVALID_CIPHERTEXT",
                origin: "Axcess",
              });
              throw createAxcessError("Webhook body does not contain valid base64 or hex ciphertext (CBC mode)", {
                code: "INVALID_CIPHERTEXT",
              });
            }
          }
        }
        
        // Normalize secret key (supports base64 or hex format)
        const key = this._coerceKeyTo32Bytes(this.webhookConfig.secretKey);
        
        // Parse IV: GCM uses hex (12 bytes), CBC may use base64 or hex (16 bytes)
        let iv;
        if (cipherMode === "GCM") {
          iv = Buffer.from(ivValue, "hex"); // 12 bytes for GCM
          if (iv.length !== 12) {
            ErrorHandler.addError("Invalid IV length for GCM mode (expected 12 bytes)", {
              code: "INVALID_IV_LENGTH",
              origin: "Axcess",
            });
            throw createAxcessError("Invalid IV length for GCM mode (expected 12 bytes)", {
              code: "INVALID_IV_LENGTH",
              data: { expectedBytes: 12, actualBytes: iv.length },
            });
          }
        } else {
          // CBC: try base64 first, then hex
          try {
            iv = Buffer.from(ivValue, "base64");
          } catch {
            iv = Buffer.from(ivValue, "hex");
          }
          if (iv.length !== 16) {
            ErrorHandler.addError("Invalid IV length for CBC mode (expected 16 bytes)", {
              code: "INVALID_IV_LENGTH",
              origin: "Axcess",
            });
            throw createAxcessError("Invalid IV length for CBC mode (expected 16 bytes)", {
              code: "INVALID_IV_LENGTH",
              data: { expectedBytes: 16, actualBytes: iv.length },
            });
          }
        }
        
        Logger.debugLog?.(`[Axcess] [decryptAndVerifyWebhook] [DECRYPT] Decrypting AES-256-${cipherMode}`);
        
        // Decrypt based on mode
        if (cipherMode === "GCM") {
      // Decrypt AES-256-GCM
          const tag = Buffer.from(tagValue, "hex"); // 16 bytes
          if (tag.length !== 16) {
            ErrorHandler.addError("Invalid authentication tag length for GCM mode (expected 16 bytes)", {
              code: "INVALID_TAG_LENGTH",
              origin: "Axcess",
            });
            throw createAxcessError("Invalid authentication tag length for GCM mode (expected 16 bytes)", {
              code: "INVALID_TAG_LENGTH",
              data: { expectedBytes: 16, actualBytes: tag.length },
            });
          }
          
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);

      const decrypted = Buffer.concat([
        decipher.update(cipherBuf),
        decipher.final(),
      ]);
          plaintext = decrypted.toString("utf8");
        } else {
          // Decrypt AES-256-CBC
          const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
          const decrypted = Buffer.concat([
            decipher.update(cipherBuf),
            decipher.final(),
          ]);
          plaintext = decrypted.toString("utf8");
        }
      }

      let decryptedJson;
      try {
        decryptedJson = JSON.parse(plaintext);
      } catch (parseError) {
        ErrorHandler.addError("Webhook payload is not valid JSON", {
          code: "INVALID_JSON_PAYLOAD",
          origin: "Axcess",
          data: { error: parseError.message },
        });
        throw createAxcessError("Webhook payload is not valid JSON", {
          code: "INVALID_JSON_PAYLOAD",
          data: { error: parseError.message },
          cause: parseError,
        });
      }

      // Validate payload structure - ensure it's an object and not null/undefined
      if (!decryptedJson || typeof decryptedJson !== 'object' || Array.isArray(decryptedJson)) {
        ErrorHandler.addError("Webhook payload must be a valid object", {
          code: "INVALID_PAYLOAD_STRUCTURE",
          origin: "Axcess",
          data: { type: typeof decryptedJson, isArray: Array.isArray(decryptedJson) },
        });
        throw createAxcessError("Webhook payload must be a valid object", {
          code: "INVALID_PAYLOAD_STRUCTURE",
          data: { type: typeof decryptedJson, isArray: Array.isArray(decryptedJson) },
        });
      }

      // Validate and sanitize specific fields that will be used
      const validatedFields = SafeUtils.sanitizeValidate({
        type: { value: decryptedJson.type || decryptedJson.eventType, type: "string", required: false },
        id: { value: decryptedJson.id, type: "string", required: false },
        eventId: { value: decryptedJson.eventId, type: "string", required: false },
        payloadId: { value: decryptedJson.payloadId, type: "string", required: false },
      });

      // Sanitize the payload object itself to prevent prototype pollution
      const sanitizedPayload = SafeUtils.sanitizeObject(decryptedJson) || decryptedJson;

      // Optional HMAC signature verification (if signature header is present)
      // Check for separate HMAC signature header (e.g., x-axcess-signature) distinct from GCM auth tag
      const hmacSignatureHeader = h["x-axcess-signature"] || h["x-signature"] || null;
      let verified = true; // GCM decryption success already provides authentication
      
      if (hmacSignatureHeader) {
        Logger.debugLog?.(`[Axcess] [decryptAndVerifyWebhook] [VERIFY] Validating HMAC signature`);
        try {
          // Compute HMAC-SHA256 of the decrypted plaintext
          // Normalize secret key (supports base64 or hex format)
          const hmacKey = this._coerceKeyTo32Bytes(this.webhookConfig.secretKey);
          const computedHmac = crypto
            .createHmac("sha256", hmacKey)
            .update(plaintext)
            .digest("hex");
          
          // Extract signature from header (remove '0x' prefix if present, handle hex encoding)
          const receivedSignature = hmacSignatureHeader.replace(/^0x/i, "").trim();
          const receivedSignatureBuf = Buffer.from(receivedSignature, "hex");
          const computedHmacBuf = Buffer.from(computedHmac, "hex");
          
          // Use timing-safe comparison to prevent timing attacks
          if (receivedSignatureBuf.length !== computedHmacBuf.length) {
            verified = false;
          } else {
            verified = crypto.timingSafeEqual(receivedSignatureBuf, computedHmacBuf);
          }
          
          if (!verified) {
            ErrorHandler.addError("Webhook HMAC signature validation failed", {
              code: "WEBHOOK_SIGNATURE_INVALID",
              origin: "Axcess",
            });
            throw createAxcessError("Webhook HMAC signature validation failed", {
              code: "WEBHOOK_SIGNATURE_INVALID",
            });
          }
          
          Logger.debugLog?.(`[Axcess] [decryptAndVerifyWebhook] [VERIFY] HMAC signature validated successfully`);
        } catch (hmacError) {
          if (hmacError.message === "Webhook HMAC signature validation failed") {
            throw hmacError;
          }
          // If signature parsing fails, log but don't fail (signature may be optional)
          Logger.debugLog?.(`[Axcess] [decryptAndVerifyWebhook] [WARNING] HMAC signature validation error: ${hmacError.message}`);
        }
      }

      // Choose an idempotency key field from validated fields
      const idempotencyKey =
        validatedFields.id ||
        validatedFields.eventId ||
        validatedFields.payloadId ||
        sanitizedPayload?.payload?.id ||
        null;

      Logger.debugLog?.(`[Axcess] [decryptAndVerifyWebhook] [SUCCESS] Webhook decrypted successfully: idempotencyKey=${idempotencyKey || 'none'}, verified=${verified}`);
      
      this._writeLog("decryptAndVerifyWebhook", "Webhook decrypted and verified", {
          idempotencyKey: idempotencyKey,
          eventType: validatedFields.type || null,
          verified: verified,
      });

      // With GCM, successful decryption == verified, plus optional HMAC signature verification
      return { decryptedJson: sanitizedPayload, idempotencyKey, verified };
    } catch (e) {
      ErrorHandler.addError("Axcess webhook decrypt/verify failed", {
        code: "WEBHOOK_DECRYPT_FAILED",
        origin: "Axcess",
        data: {
          error: e.message,
        },
      });
      Logger.debugLog?.(`[Axcess] [decryptAndVerifyWebhook] [ERROR] Webhook decryption failed: ${e.message}`);
      throw e;
    }
  }
  //
  /**
   * Handle webhook: decrypt → map → route → persist.
   * @param {string|Buffer} rawBody
   * @param {object} headers
   * @returns {Promise<{ok:true}>}
   */

  async handleWebhook(rawBody, headers = {}) {
    Logger.debugLog?.(`[Axcess] [handleWebhook] [START] Handling webhook`);
    const normalizedRawBody = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;
    const cleaned = SafeUtils.sanitizeValidate({
      rawBody: { value: normalizedRawBody, type: "string", required: true },
      headers: { value: headers, type: "object", required: false, default: {} },
    });

    // Validate Content-Type (when present) and enforce payload size limits early
    const h = this._normalizeHeaders(cleaned.headers || {});
    this._assertAllowedIncomingContentType(h);
    const rawBytes = Buffer.byteLength(String(cleaned.rawBody || ""), "utf8");
    if (rawBytes > (this.webhookConfig.maxBytes || DEFAULT_MAX_WEBHOOK_BYTES)) {
      throw createAxcessError(`Webhook body exceeds max size (${this.webhookConfig.maxBytes} bytes)`, {
        code: "WEBHOOK_BODY_TOO_LARGE",
        data: { maxBytes: this.webhookConfig.maxBytes, actualBytes: rawBytes },
      });
    }

    const { decryptedJson, idempotencyKey, verified } =
      this.decryptAndVerifyWebhook(cleaned.rawBody, h);

    Logger.debugLog?.(`[Axcess] [handleWebhook] [RECEIVED] Webhook received: type=${decryptedJson?.type}, txnId=${decryptedJson?.payload?.id}, orderId=${decryptedJson?.payload?.merchantTransactionId}`);
    
    // Validate idempotency key - required to prevent collisions and duplicate processing
    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
      ErrorHandler.addError("Webhook missing required idempotency key", {
        code: "MISSING_IDEMPOTENCY_KEY",
        origin: "Axcess",
        data: {
          eventType: decryptedJson?.type || decryptedJson?.eventType || null,
          payload: decryptedJson,
        },
      });
      Logger.debugLog?.(`[Axcess] [handleWebhook] [REJECT] Webhook rejected: missing idempotency key`);
      throw createAxcessError("Webhook missing required idempotency key - cannot process without unique identifier", {
        code: "MISSING_IDEMPOTENCY_KEY",
        data: {
          eventType: decryptedJson?.type || decryptedJson?.eventType || null,
        },
      });
    }
    
    const pk = `TRIGGER#${idempotencyKey}`;
    const sk = `WEBHOOK#${idempotencyKey}`;
    const createdAt = this._now();
    
    Logger.debugLog?.(`[Axcess] [handleWebhook] [SAVE] Saving webhook to database: idempotencyKey=${idempotencyKey}`);

    this._checkServiceMethod('saveWebhook', true);
    await this.svc.saveWebhook({
      pk,
      sk,
      payload: decryptedJson,
      event: null,
      createdAt: createdAt,
      verified,
      idempotencyKey,
    });

    const event = this.mapWebhookEvent(decryptedJson);

    Logger.debugLog?.(`[Axcess] [handleWebhook] [MAPPED] Event mapped: type=${event.type}, amount=${event.txn?.amount}, currency=${event.txn?.currency}, approved=${event.txn?.approved}`);

    try {
      switch (event.type) {
        case "payment_success":
          await this.onPaymentSuccess(event);
          break;
        case "payment_authorize":
          await this.onPaymentAuthorize(event);
          break;
        case "payment_capture":
          await this.onPaymentCapture(event);
          break;
        case "payment_void":
          await this.onPaymentVoid(event);
          break;
        case "payment_failed":
          await this.onPaymentFailed(event);
          break;
        case "refund":
          await this.onRefund(event);
          break;
        case "chargeback":
          await this.onChargeback(event);
          break;
        case "registration_created":
          await this.onRegistrationCreated(event);
          break;
        case "registration_updated":
          await this.onRegistrationUpdated(event);
          break;
        case "schedule_created":
        case "schedule_rescheduled":
        case "schedule_canceled":
          await this.onScheduleEvent(event);
          break;
        case "risk_flagged":
        case "risk_cleared":
          await this.onRiskEvent(event);
          break;
        default:
          this._writeLog("handleWebhook", "Unknown/ignored webhook event", {
              sample: decryptedJson?.type || decryptedJson?.eventType || null,
          });
      }

      Logger.debugLog?.(`[Axcess] [handleWebhook] [SUCCESS] Webhook processed successfully`);
      
      this._writeLog("handleWebhook", "Webhook processed successfully", {
          eventType: event.type,
          idempotencyKey: idempotencyKey,
          verified: verified,
      });
      
      return { ok: true };
    } catch (e) {
      ErrorHandler.addError("Axcess handleWebhook routing failed", {
        code: "WEBHOOK_ROUTING_FAILED",
        origin: "Axcess",
        data: {
          error: e.message,
          eventType: event?.type,
          idempotencyKey: idempotencyKey,
        },
      });
      Logger.debugLog?.(`[Axcess] [handleWebhook] [ERROR] Webhook processing failed: ${e.message}`);
      throw e;
    }
  }

  /**
   * Map the decrypted webhook JSON to a normalized event.
   * @param {object} payload
   * @returns {{type:string, txn?:object, registration?:object, schedule?:object, risk?:object, raw:object}}
   *
   * Docs: Webhooks payload
   * https://axcessms.docs.oppwa.com/tutorials/webhooks/payload
   */
  mapWebhookEvent(payload = {}) {
    Logger.debugLog?.(`[Axcess] [mapWebhookEvent] [START] Mapping webhook event`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      payload: { value: payload, type: "object", required: false, default: {} },
    });

    const t = String(cleaned.payload.type || cleaned.payload.eventType || "").toLowerCase();

    Logger.debugLog?.(`[Axcess] [mapWebhookEvent] [PROCESSING] Event type: ${t}`);

    // Build normalized txn shape if present
    // ✅ FIX: Axcess sends data in payload.payload, not payload.payment
    const txn = cleaned.payload.payload || cleaned.payload.payment || cleaned.payload.transaction || cleaned.payload.txn || {};
    const normalizedTxn = {
      gateway: "axcess",
      gatewayTxnId: txn.id || txn.transactionId || null,
      amount: SafeUtils.sanitizeFloat(txn.amount || txn.presentationAmount || 0),
      currency: txn.currency || txn.presentationCurrency || "USD",
      resultCode: txn.result?.code || txn.resultCode || null,
      approved: (txn.result?.code || "").startsWith("000."),
      pending: String(txn.result?.description || "")
        .toLowerCase()
        .includes("pending"),
      createdAt: this._now(),
    };

    // Registration (token) info
    const registrationId = cleaned.payload.registrationId || txn.registrationId || null;

    // Schedule (subscription) info
    const schedule = cleaned.payload.schedule || cleaned.payload.subscription || null;

    // Risk signals
    const risk = this.extractRiskSignals(cleaned.payload);

    // Check for specific payment operations first
    if (t.includes("capture")) {
      Logger.debugLog?.(`[Axcess] [mapWebhookEvent] [MAPPED] Event type: payment_capture`);
      return { type: "payment_capture", txn: normalizedTxn, raw: cleaned.payload };
    }
    if (t.includes("void") || t.includes("reverse")) {
      Logger.debugLog?.(`[Axcess] [mapWebhookEvent] [MAPPED] Event type: payment_void`);
      return { type: "payment_void", txn: normalizedTxn, raw: cleaned.payload };
    }
    if (t.includes("authorize") || t.includes("preauth")) {
      Logger.debugLog?.(`[Axcess] [mapWebhookEvent] [MAPPED] Event type: payment_authorize`);
      return { type: "payment_authorize", txn: normalizedTxn, raw: cleaned.payload };
    }

    // Generic payment handling
    if (t.includes("payment") && normalizedTxn.approved) {
      Logger.debugLog?.(`[Axcess] [mapWebhookEvent] [MAPPED] Event type: payment_success`);
      return {
        type: "payment_success",
        txn: normalizedTxn,
        registration: registrationId ? { registrationId } : null,
        raw: cleaned.payload,
      };
    }
    if (
      t.includes("payment") &&
      !normalizedTxn.approved &&
      !normalizedTxn.pending
    ) {
      Logger.debugLog?.(`[Axcess] [mapWebhookEvent] [MAPPED] Event type: payment_failed`);
      return { type: "payment_failed", txn: normalizedTxn, raw: cleaned.payload };
    }
    if (t.includes("refund")) {
      Logger.debugLog?.(`[Axcess] [mapWebhookEvent] [MAPPED] Event type: refund`);
      return { type: "refund", txn: normalizedTxn, raw: cleaned.payload };
    }
    if (t.includes("chargeback")) {
      Logger.debugLog?.(`[Axcess] [mapWebhookEvent] [MAPPED] Event type: chargeback`);
      return { type: "chargeback", txn: normalizedTxn, raw: cleaned.payload };
    }
    if (t.includes("registration") && t.includes("create")) {
      Logger.debugLog?.(`[Axcess] [mapWebhookEvent] [MAPPED] Event type: registration_created`);
      return {
        type: "registration_created",
        registration: { registrationId },
        raw: cleaned.payload,
      };
    }
    if (
      t.includes("registration") &&
      (t.includes("update") || t.includes("upgrade"))
    ) {
      Logger.debugLog?.(`[Axcess] [mapWebhookEvent] [MAPPED] Event type: registration_updated`);
      return {
        type: "registration_updated",
        registration: { registrationId },
        raw: cleaned.payload,
      };
    }
    if (t.includes("schedule") || t.includes("subscription")) {
      if (t.includes("cancel")) {
        Logger.debugLog?.(`[Axcess] [mapWebhookEvent] [MAPPED] Event type: schedule_canceled`);
        return { type: "schedule_canceled", schedule, raw: cleaned.payload };
      }
      if (t.includes("reschedul")) {
        Logger.debugLog?.(`[Axcess] [mapWebhookEvent] [MAPPED] Event type: schedule_rescheduled`);
        return { type: "schedule_rescheduled", schedule, raw: cleaned.payload };
      }
      Logger.debugLog?.(`[Axcess] [mapWebhookEvent] [MAPPED] Event type: schedule_created`);
      return { type: "schedule_created", schedule, raw: cleaned.payload };
    }
    if (t.includes("risk")) {
      if (t.includes("flag")) {
        Logger.debugLog?.(`[Axcess] [mapWebhookEvent] [MAPPED] Event type: risk_flagged`);
        return { type: "risk_flagged", risk, raw: cleaned.payload };
      }
      Logger.debugLog?.(`[Axcess] [mapWebhookEvent] [MAPPED] Event type: risk_cleared`);
      return { type: "risk_cleared", risk, raw: cleaned.payload };
    }
    Logger.debugLog?.(`[Axcess] [mapWebhookEvent] [MAPPED] Event type: unknown`);
    return { type: "unknown", raw: cleaned.payload };
  }

  // ---- Webhook event handlers ----

  /**
   * Persist success txn, grant access, store token if any.
   * @param {object} event
   */
  async onPaymentSuccess(event) {
    Logger.debugLog?.(`[Axcess] [onPaymentSuccess] [START] Processing payment success event`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      event: { value: event, type: "object", required: true },
    });

    const ui = this.mapResultCodeToUiMessage(cleaned.event.txn.resultCode);

    // ✅ FIX: Extract orderId and userId from webhook payload
    const orderId = cleaned.event.raw?.payload?.merchantTransactionId || cleaned.event.raw?.merchantTransactionId || 'unknown';
    const currentTimestamp = this._nowUnixSeconds();
    const txnId = cleaned.event.txn.gatewayTxnId || currentTimestamp;

    Logger.debugLog?.(`[Axcess] [onPaymentSuccess] [PROCESSING] orderId=${orderId}, txnId=${txnId}`);

    // Try to get userId from session using orderId
    let userId = null;
    try {
      let sessions = await this.svc.get_order_sessions?.(orderId);

      // If GSI query fails, try fallback method
      if (!sessions || sessions.length === 0) {
        Logger.debugLog?.(`[Axcess] [onPaymentSuccess] [FALLBACK] GSI query failed, trying fallback method for orderId: ${orderId}`);
        sessions = await this.svc.get_order_sessions_fallback?.(orderId);
      }

      if (sessions && sessions.length > 0) {
        userId = sessions[0].userId || null;
        Logger.debugLog?.(`[Axcess] [onPaymentSuccess] [SUCCESS] Found ${sessions.length} sessions for orderId: ${orderId}`);
      } else {
        Logger.debugLog?.(`[Axcess] [onPaymentSuccess] [WARNING] No sessions found for orderId: ${orderId}`);
      }
    } catch (err) {
      ErrorHandler.addError("Could not retrieve userId from session", {
        code: "RETRIEVE_USER_ID_FAILED",
        origin: "Axcess",
        data: {
          error: err.message,
          orderId: orderId,
        },
      });
      Logger.debugLog?.(`[Axcess] [onPaymentSuccess] [ERROR] Could not retrieve userId from session: ${err.message}`);
      throw createAxcessError("Could not retrieve userId from session", {
        code: "RETRIEVE_USER_ID_FAILED",
        data: { orderId, error: err.message },
        cause: err,
      });
    }

    if (!userId) {
      throw createAxcessError("Cannot process webhook event: userId not found for orderId", {
        code: "MISSING_USER_ID",
        data: { orderId },
      });
    }

    // Determine transaction status based on pending state and payment type
    let transactionStatus;
    if (cleaned.event.txn.pending) {
      transactionStatus = "pending";
    } else {
      // Check if this is an authorization (PA) payment
      const paymentType = cleaned.event.raw?.payload?.paymentType || cleaned.event.raw?.paymentType;
      if (paymentType === 'PA') {
        transactionStatus = "authorized"; // Authorization payments should be "authorized" until captured
      } else {
        transactionStatus = "success"; // Debit payments are "success" when completed
      }
    }

    Logger.debugLog?.(`[Axcess] [onPaymentSuccess] [SAVE] Saving transaction: userId=${userId}, status=${transactionStatus}`);

    await this.svc.saveTransaction?.({
      pk: `user#${userId}`,
      sk: `txn#${txnId}`,
      userId: userId,
      orderId: orderId,
      transactionId: txnId,
      ...cleaned.event.txn,
      status: transactionStatus,
      uiMessage: ui.uiMessage,
    });

    // Update session status based on transaction status
    try {
      let sessions = await this.svc.get_order_sessions?.(orderId);

      // If GSI query fails, try fallback method
      if (!sessions || sessions.length === 0) {
        Logger.debugLog?.(`[Axcess] [onPaymentSuccess] [FALLBACK] GSI query failed for session update, trying fallback method`);
        sessions = await this.svc.get_order_sessions_fallback?.(orderId);
      }

      if (sessions && sessions.length > 0) {
        for (const session of sessions) {
          const currentVersion = session.version || 1;
          await this.svc.saveSession?.({
            ...session,
            status: transactionStatus,
            updatedAt: this._now(),
            version: currentVersion + 1, // Increment version for optimistic locking
            expectedVersion: currentVersion, // Include expected version for conditional write
          });
        }
        Logger.debugLog?.(`[Axcess] [onPaymentSuccess] [SUCCESS] Updated ${sessions.length} session(s) status to: ${transactionStatus}`);
      } else {
        Logger.debugLog?.(`[Axcess] [onPaymentSuccess] [WARNING] No sessions found for orderId: ${orderId}`);
      }
    } catch (err) {
      ErrorHandler.addError("Could not update session status", {
        code: "UPDATE_SESSION_STATUS_FAILED",
        origin: "Axcess",
        data: {
          error: err.message,
          orderId: orderId,
        },
      });
      Logger.debugLog?.(`[Axcess] [onPaymentSuccess] [ERROR] Could not update session status: ${err.message}`);
      throw err;
    }

    if (cleaned.event.registration?.registrationId) {
      Logger.debugLog?.(`[Axcess] [onPaymentSuccess] [SAVE] Saving registration token: registrationId=${cleaned.event.registration.registrationId}`);
      
      await this.svc.saveToken?.({
        pk: `user#${userId}`,
        sk: `token#${cleaned.event.registration.registrationId}`,
        userId: userId,
        id: cleaned.event.registration.registrationId,
        registrationId: cleaned.event.registration.registrationId,
        gateway: "axcess",
        last4: cleaned.event.registration.last4 || null,
        brand: cleaned.event.registration.brand || null,
        expiry: cleaned.event.registration.expiry || "unknown",
        createdAt: this._now(),
      });
    }
    
    // Grant access - wrapped in try-catch to prevent transaction failures from entitlement errors
    try {
    await this.svc.grantAccess?.({ event: cleaned.event });
    } catch (entitlementError) {
      ErrorHandler.addError("Failed to grant access after payment success", {
        code: "ENTITLEMENT_GRANT_FAILED",
        origin: "Axcess",
        data: {
          eventType: cleaned.event.type,
          txnId: cleaned.event.txn?.id,
          orderId: cleaned.event.txn?.orderId,
          error: entitlementError.message,
        },
      });
      Logger.debugLog?.(`[Axcess] [onPaymentSuccess] [ENTITLEMENT_ERROR] Failed to grant access: ${entitlementError.message}`);
      // Continue processing - entitlement failure should not fail the transaction
    }
    
    Logger.debugLog?.(`[Axcess] [onPaymentSuccess] [SUCCESS] Payment success event processed successfully`);
  }

  /**
   * Persist failed txn, deny access.
   * @param {object} event
   */
  async onPaymentFailed(event) {
    Logger.debugLog?.(`[Axcess] [onPaymentFailed] [START] Processing payment failed event`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      event: { value: event, type: "object", required: true },
    });

    const ui = this.mapResultCodeToUiMessage(cleaned.event.txn.resultCode);

    // ✅ FIX: Extract orderId and userId from webhook payload
    const orderId = cleaned.event.raw?.payload?.merchantTransactionId || cleaned.event.raw?.merchantTransactionId || 'unknown';
    const currentTimestamp = this._nowUnixSeconds();
    const txnId = cleaned.event.txn.gatewayTxnId || currentTimestamp;
    
    Logger.debugLog?.(`[Axcess] [onPaymentFailed] [PROCESSING] orderId=${orderId}, txnId=${txnId}`);

    // Try to get userId from session using orderId
    let userId = null;
    try {
      let sessions = await this.svc.get_order_sessions?.(orderId);

      // If GSI query fails, try fallback method
      if (!sessions || sessions.length === 0) {
        Logger.debugLog?.(`[Axcess] [onPaymentFailed] [FALLBACK] GSI query failed, trying fallback method for orderId: ${orderId}`);
        sessions = await this.svc.get_order_sessions_fallback?.(orderId);
      }

      if (sessions && sessions.length > 0) {
        userId = sessions[0].userId || null;
        Logger.debugLog?.(`[Axcess] [onPaymentFailed] [SUCCESS] Found ${sessions.length} sessions for orderId: ${orderId}`);
      } else {
        Logger.debugLog?.(`[Axcess] [onPaymentFailed] [WARNING] No sessions found for orderId: ${orderId}`);
      }
    } catch (err) {
      ErrorHandler.addError("Could not retrieve userId from session", {
        code: "RETRIEVE_USER_ID_FAILED",
        origin: "Axcess",
        data: {
          error: err.message,
          orderId: orderId,
        },
      });
      Logger.debugLog?.(`[Axcess] [onPaymentFailed] [ERROR] Could not retrieve userId from session: ${err.message}`);
      throw createAxcessError("Could not retrieve userId from session", {
        code: "RETRIEVE_USER_ID_FAILED",
        data: { orderId, error: err.message },
        cause: err,
      });
    }

    if (!userId) {
      throw createAxcessError("Cannot process webhook event: userId not found for orderId", {
        code: "MISSING_USER_ID",
        data: { orderId },
      });
    }

    Logger.debugLog?.(`[Axcess] [onPaymentFailed] [SAVE] Saving failed transaction: userId=${userId}`);

    await this.svc.saveTransaction?.({
      pk: `user#${userId}`,
      sk: `txn#${txnId}`,
      userId: userId,
      orderId: orderId,
      transactionId: txnId,
      ...cleaned.event.txn,
      status: "failed",
      uiMessage: ui.uiMessage,
    });

    // Deny access - wrapped in try-catch to prevent transaction failures from entitlement errors
    try {
    await this.svc.denyAccess?.({ event: cleaned.event });
    } catch (entitlementError) {
      ErrorHandler.addError("Failed to deny access after payment failure", {
        code: "ENTITLEMENT_DENY_FAILED",
        origin: "Axcess",
        data: {
          eventType: cleaned.event.type,
          txnId: cleaned.event.txn?.id,
          orderId: cleaned.event.txn?.orderId,
          error: entitlementError.message,
        },
      });
      Logger.debugLog?.(`[Axcess] [onPaymentFailed] [ENTITLEMENT_ERROR] Failed to deny access: ${entitlementError.message}`);
      // Continue processing - entitlement failure should not fail the transaction
    }
    
    Logger.debugLog?.(`[Axcess] [onPaymentFailed] [SUCCESS] Payment failed event processed successfully`);
  }

  /**
   * Handle authorization webhook - sets status to "authorized".
   * @param {object} event
   */
  async onPaymentAuthorize(event) {
    Logger.debugLog?.(`[Axcess] [onPaymentAuthorize] [START] Processing payment authorize event`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      event: { value: event, type: "object", required: true },
    });

    const ui = this.mapResultCodeToUiMessage(cleaned.event.txn.resultCode);
    const orderId = cleaned.event.raw?.payload?.merchantTransactionId || cleaned.event.raw?.merchantTransactionId || 'unknown';
    const currentTimestamp = this._nowUnixSeconds();
    const txnId = cleaned.event.txn.gatewayTxnId || currentTimestamp;

    Logger.debugLog?.(`[Axcess] [onPaymentAuthorize] [PROCESSING] orderId=${orderId}, txnId=${txnId}`);

    // Try to get userId from session using orderId
    let userId = null;
    try {
      let sessions = await this.svc.get_order_sessions?.(orderId);
      if (!sessions || sessions.length === 0) {
        Logger.debugLog?.(`[Axcess] [onPaymentAuthorize] [FALLBACK] GSI query failed, trying fallback method for orderId: ${orderId}`);
        sessions = await this.svc.get_order_sessions_fallback?.(orderId);
      }
      if (sessions && sessions.length > 0) {
        userId = sessions[0].userId || null;
        Logger.debugLog?.(`[Axcess] [onPaymentAuthorize] [SUCCESS] Found ${sessions.length} sessions for orderId: ${orderId}`);
      } else {
        Logger.debugLog?.(`[Axcess] [onPaymentAuthorize] [WARNING] No sessions found for orderId: ${orderId}`);
      }
    } catch (err) {
      ErrorHandler.addError("Could not retrieve userId from session", {
        code: "RETRIEVE_USER_ID_FAILED",
        origin: "Axcess",
        data: {
          error: err.message,
          orderId: orderId,
        },
      });
      Logger.debugLog?.(`[Axcess] [onPaymentAuthorize] [ERROR] Could not retrieve userId from session: ${err.message}`);
      throw createAxcessError("Could not retrieve userId from session", {
        code: "RETRIEVE_USER_ID_FAILED",
        data: { orderId, error: err.message },
        cause: err,
      });
    }

    if (!userId) {
      throw createAxcessError("Cannot process webhook event: userId not found for orderId", {
        code: "MISSING_USER_ID",
        data: { orderId },
      });
    }

    Logger.debugLog?.(`[Axcess] [onPaymentAuthorize] [SAVE] Saving authorized transaction: userId=${userId}`);

    // Save transaction with "authorized" status
    await this.svc.saveTransaction?.({
      pk: `user#${userId}`,
      sk: `txn#${txnId}`,
      userId: userId,
      orderId: orderId,
      transactionId: txnId,
      ...cleaned.event.txn,
      status: "authorized",
      uiMessage: ui.uiMessage,
    });

    // Update session status to "authorized"
    try {
      let sessions = await this.svc.get_order_sessions?.(orderId);
      if (!sessions || sessions.length === 0) {
        Logger.debugLog?.(`[Axcess] [onPaymentAuthorize] [FALLBACK] GSI query failed for session update, trying fallback method`);
        sessions = await this.svc.get_order_sessions_fallback?.(orderId);
      }
      if (sessions && sessions.length > 0) {
        for (const session of sessions) {
          const currentVersion = session.version || 1;
          await this.svc.saveSession?.({
            ...session,
            status: "authorized",
            updatedAt: this._now(),
            version: currentVersion + 1, // Increment version for optimistic locking
            expectedVersion: currentVersion, // Include expected version for conditional write
          });
        }
        Logger.debugLog?.(`[Axcess] [onPaymentAuthorize] [SUCCESS] Updated ${sessions.length} session(s) status to: authorized`);
      } else {
        Logger.debugLog?.(`[Axcess] [onPaymentAuthorize] [WARNING] No sessions found for orderId: ${orderId}`);
      }
    } catch (err) {
      ErrorHandler.addError("Could not update session status", {
        code: "UPDATE_SESSION_STATUS_FAILED",
        origin: "Axcess",
        data: {
          error: err.message,
          orderId: orderId,
        },
      });
      Logger.debugLog?.(`[Axcess] [onPaymentAuthorize] [ERROR] Could not update session status: ${err.message}`);
      throw err;
    }
    
    Logger.debugLog?.(`[Axcess] [onPaymentAuthorize] [SUCCESS] Payment authorize event processed successfully`);
  }

  /**
   * Handle capture webhook - updates status from "authorized" to "success".
   * @param {object} event
   */
  async onPaymentCapture(event) {
    Logger.debugLog?.(`[Axcess] [onPaymentCapture] [START] Processing payment capture event`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      event: { value: event, type: "object", required: true },
    });

    const ui = this.mapResultCodeToUiMessage(cleaned.event.txn.resultCode);
    const orderId = cleaned.event.raw?.payload?.merchantTransactionId || cleaned.event.raw?.merchantTransactionId || 'unknown';
    const currentTimestamp = this._nowUnixSeconds();
    const txnId = cleaned.event.txn.gatewayTxnId || currentTimestamp;
    
    Logger.debugLog?.(`[Axcess] [onPaymentCapture] [PROCESSING] orderId=${orderId}, txnId=${txnId}`);

    // Try to get userId from session using orderId
    let userId = null;
    try {
      let sessions = await this.svc.get_order_sessions?.(orderId);
      if (!sessions || sessions.length === 0) {
        Logger.debugLog?.(`[Axcess] [onPaymentCapture] [FALLBACK] GSI query failed, trying fallback method for orderId: ${orderId}`);
        sessions = await this.svc.get_order_sessions_fallback?.(orderId);
      }
      if (sessions && sessions.length > 0) {
        userId = sessions[0].userId || null;
        Logger.debugLog?.(`[Axcess] [onPaymentCapture] [SUCCESS] Found ${sessions.length} sessions for orderId: ${orderId}`);
      } else {
        Logger.debugLog?.(`[Axcess] [onPaymentCapture] [WARNING] No sessions found for orderId: ${orderId}`);
      }
    } catch (err) {
      ErrorHandler.addError("Could not retrieve userId from session", {
        code: "RETRIEVE_USER_ID_FAILED",
        origin: "Axcess",
        data: {
          error: err.message,
          orderId: orderId,
        },
      });
      Logger.debugLog?.(`[Axcess] [onPaymentCapture] [ERROR] Could not retrieve userId from session: ${err.message}`);
      throw createAxcessError("Could not retrieve userId from session", {
        code: "RETRIEVE_USER_ID_FAILED",
        data: { orderId, error: err.message },
        cause: err,
      });
    }

    if (!userId) {
      throw createAxcessError("Cannot process webhook event: userId not found for orderId", {
        code: "MISSING_USER_ID",
        data: { orderId },
      });
    }

    Logger.debugLog?.(`[Axcess] [onPaymentCapture] [SAVE] Saving capture transaction: userId=${userId}`);

    // Save capture transaction
    await this.svc.saveTransaction?.({
      pk: `user#${userId}`,
      sk: `txn#${txnId}`,
      userId: userId,
      orderId: orderId,
      transactionId: txnId,
      ...cleaned.event.txn,
      status: "success",
      uiMessage: ui.uiMessage,
    });

    // Update session status from "authorized" to "success"
    try {
      let sessions = await this.svc.get_order_sessions?.(orderId);
      if (!sessions || sessions.length === 0) {
        Logger.debugLog?.(`[Axcess] [onPaymentCapture] [FALLBACK] GSI query failed for session update, trying fallback method`);
        sessions = await this.svc.get_order_sessions_fallback?.(orderId);
      }
      if (sessions && sessions.length > 0) {
        for (const session of sessions) {
          const currentVersion = session.version || 1;
          await this.svc.saveSession?.({
            ...session,
            status: "success",
            updatedAt: this._now(),
            version: currentVersion + 1, // Increment version for optimistic locking
            expectedVersion: currentVersion, // Include expected version for conditional write
          });
        }
        Logger.debugLog?.(`[Axcess] [onPaymentCapture] [SUCCESS] Updated ${sessions.length} session(s) status to: success (captured)`);
      } else {
        Logger.debugLog?.(`[Axcess] [onPaymentCapture] [WARNING] No sessions found for orderId: ${orderId}`);
      }
    } catch (err) {
      ErrorHandler.addError("Could not update session status", {
        code: "UPDATE_SESSION_STATUS_FAILED",
        origin: "Axcess",
        data: {
          error: err.message,
          orderId: orderId,
        },
      });
      Logger.debugLog?.(`[Axcess] [onPaymentCapture] [ERROR] Could not update session status: ${err.message}`);
      throw err;
    }
    
    Logger.debugLog?.(`[Axcess] [onPaymentCapture] [SUCCESS] Payment capture event processed successfully`);
  }

  /**
   * Handle void webhook - updates status from "authorized" to "voided".
   * @param {object} event
   */
  async onPaymentVoid(event) {
    Logger.debugLog?.(`[Axcess] [onPaymentVoid] [START] Processing payment void event`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      event: { value: event, type: "object", required: true },
    });

    const ui = this.mapResultCodeToUiMessage(cleaned.event.txn.resultCode);
    const orderId = cleaned.event.raw?.payload?.merchantTransactionId || cleaned.event.raw?.merchantTransactionId || 'unknown';
    const currentTimestamp = this._nowUnixSeconds();
    const txnId = cleaned.event.txn.gatewayTxnId || currentTimestamp;

    Logger.debugLog?.(`[Axcess] [onPaymentVoid] [PROCESSING] orderId=${orderId}, txnId=${txnId}`);

    // Try to get userId from session using orderId
    let userId = null;
    try {
      let sessions = await this.svc.get_order_sessions?.(orderId);
      if (!sessions || sessions.length === 0) {
        Logger.debugLog?.(`[Axcess] [onPaymentVoid] [FALLBACK] GSI query failed, trying fallback method for orderId: ${orderId}`);
        sessions = await this.svc.get_order_sessions_fallback?.(orderId);
      }
      if (sessions && sessions.length > 0) {
        userId = sessions[0].userId || null;
        Logger.debugLog?.(`[Axcess] [onPaymentVoid] [SUCCESS] Found ${sessions.length} sessions for orderId: ${orderId}`);
      } else {
        Logger.debugLog?.(`[Axcess] [onPaymentVoid] [WARNING] No sessions found for orderId: ${orderId}`);
      }
    } catch (err) {
      ErrorHandler.addError("Could not retrieve userId from session", {
        code: "RETRIEVE_USER_ID_FAILED",
        origin: "Axcess",
        data: {
          error: err.message,
          orderId: orderId,
        },
      });
      Logger.debugLog?.(`[Axcess] [onPaymentVoid] [ERROR] Could not retrieve userId from session: ${err.message}`);
      throw createAxcessError("Could not retrieve userId from session", {
        code: "RETRIEVE_USER_ID_FAILED",
        data: { orderId, error: err.message },
        cause: err,
      });
    }

    if (!userId) {
      throw createAxcessError("Cannot process webhook event: userId not found for orderId", {
        code: "MISSING_USER_ID",
        data: { orderId },
      });
    }

    Logger.debugLog?.(`[Axcess] [onPaymentVoid] [SAVE] Saving void transaction: userId=${userId}`);

    // Save void transaction
    await this.svc.saveTransaction?.({
      pk: `user#${userId}`,
      sk: `txn#${txnId}`,
      userId: userId,
      orderId: orderId,
      transactionId: txnId,
      ...cleaned.event.txn,
      status: "voided",
      uiMessage: ui.uiMessage,
    });

    // Update session status from "authorized" to "voided"
    try {
      let sessions = await this.svc.get_order_sessions?.(orderId);
      if (!sessions || sessions.length === 0) {
        Logger.debugLog?.(`[Axcess] [onPaymentVoid] [FALLBACK] GSI query failed for session update, trying fallback method`);
        sessions = await this.svc.get_order_sessions_fallback?.(orderId);
      }
      if (sessions && sessions.length > 0) {
        for (const session of sessions) {
          const currentVersion = session.version || 1;
          await this.svc.saveSession?.({
            ...session,
            status: "voided",
            updatedAt: this._now(),
            version: currentVersion + 1, // Increment version for optimistic locking
            expectedVersion: currentVersion, // Include expected version for conditional write
          });
        }
        Logger.debugLog?.(`[Axcess] [onPaymentVoid] [SUCCESS] Updated ${sessions.length} session(s) status to: voided`);
      } else {
        Logger.debugLog?.(`[Axcess] [onPaymentVoid] [WARNING] No sessions found for orderId: ${orderId}`);
      }
    } catch (err) {
      ErrorHandler.addError("Could not update session status", {
        code: "UPDATE_SESSION_STATUS_FAILED",
        origin: "Axcess",
        data: {
          error: err.message,
          orderId: orderId,
        },
      });
      Logger.debugLog?.(`[Axcess] [onPaymentVoid] [ERROR] Could not update session status: ${err.message}`);
      throw err;
    }
    
    Logger.debugLog?.(`[Axcess] [onPaymentVoid] [SUCCESS] Payment void event processed successfully`);
  }

  /**
   * Persist refund result.
   * @param {object} event
   */
  async onRefund(event) {
    Logger.debugLog?.(`[Axcess] [onRefund] [START] Processing refund event`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      event: { value: event, type: "object", required: true },
    });

    Logger.debugLog?.(`[Axcess] [onRefund] [SAVE] Saving refunded transaction`);
    
    await this.svc.saveTransaction?.({ ...cleaned.event.txn, status: "refunded" });
    
    Logger.debugLog?.(`[Axcess] [onRefund] [DENY] Denying access for refunded transaction`);
    
    // Deny access - wrapped in try-catch to prevent transaction failures from entitlement errors
    try {
    await this.svc.denyAccess?.({ event: cleaned.event });
    } catch (entitlementError) {
      ErrorHandler.addError("Failed to deny access after refund", {
        code: "ENTITLEMENT_DENY_FAILED",
        origin: "Axcess",
        data: {
          eventType: cleaned.event.type,
          txnId: cleaned.event.txn?.id,
          orderId: cleaned.event.txn?.orderId,
          error: entitlementError.message,
        },
      });
      Logger.debugLog?.(`[Axcess] [onRefund] [ENTITLEMENT_ERROR] Failed to deny access: ${entitlementError.message}`);
      // Continue processing - entitlement failure should not fail the transaction
    }
    
    Logger.debugLog?.(`[Axcess] [onRefund] [SUCCESS] Refund event processed successfully`);
  }

  /**
   * Persist chargeback result.
   * @param {object} event
   */
  async onChargeback(event) {
    Logger.debugLog?.(`[Axcess] [onChargeback] [START] Processing chargeback event`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      event: { value: event, type: "object", required: true },
    });

    Logger.debugLog?.(`[Axcess] [onChargeback] [SAVE] Saving chargeback transaction`);
    
    await this.svc.saveTransaction?.({ ...cleaned.event.txn, status: "chargeback" });
    
    Logger.debugLog?.(`[Axcess] [onChargeback] [DENY] Denying access for chargeback transaction`);
    
    // Deny access - wrapped in try-catch to prevent transaction failures from entitlement errors
    try {
    await this.svc.denyAccess?.({ event: cleaned.event });
    } catch (entitlementError) {
      ErrorHandler.addError("Failed to deny access after chargeback", {
        code: "ENTITLEMENT_DENY_FAILED",
        origin: "Axcess",
        data: {
          eventType: cleaned.event.type,
          txnId: cleaned.event.txn?.id,
          orderId: cleaned.event.txn?.orderId,
          error: entitlementError.message,
        },
      });
      Logger.debugLog?.(`[Axcess] [onChargeback] [ENTITLEMENT_ERROR] Failed to deny access: ${entitlementError.message}`);
      // Continue processing - entitlement failure should not fail the transaction
    }
    
    Logger.debugLog?.(`[Axcess] [onChargeback] [SUCCESS] Chargeback event processed successfully`);
  }

  /**
   * Persist new/updated token as needed.
   * @param {object} event
   */
  async onRegistrationCreated(event) {
    Logger.debugLog?.(`[Axcess] [onRegistrationCreated] [START] Processing registration created event`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      event: { value: event, type: "object", required: true },
    });

    if (cleaned.event.registration?.registrationId) {
      Logger.debugLog?.(`[Axcess] [onRegistrationCreated] [PROCESSING] registrationId=${cleaned.event.registration.registrationId}`);
      
      // Extract userId from event (required for persistence)
      const userId = cleaned.event.raw?.customer?.merchantCustomerId || null;
      if (!userId) {
        throw createAxcessError("Cannot process registration_created webhook: missing merchantCustomerId/userId", {
          code: "MISSING_USER_ID",
          data: {
            registrationId: cleaned.event.registration.registrationId,
          },
        });
      }
      
      Logger.debugLog?.(`[Axcess] [onRegistrationCreated] [SAVE] Saving registration token: userId=${userId}`);
      
      this._checkServiceMethod('saveToken', true);
      await this.svc.saveToken({
        pk: `user#${userId}`,
        sk: `token#${cleaned.event.registration.registrationId}`,
        userId: userId,
        id: cleaned.event.registration.registrationId,
        registrationId: cleaned.event.registration.registrationId,
        gateway: "axcess",
        last4: cleaned.event.registration.last4 || null,
        brand: cleaned.event.registration.brand || null,
        expiry: cleaned.event.registration.expiry || "unknown",
        createdAt: this._now(),
      });
      
      Logger.debugLog?.(`[Axcess] [onRegistrationCreated] [SUCCESS] Registration token saved successfully`);
    } else {
      Logger.debugLog?.(`[Axcess] [onRegistrationCreated] [WARNING] No registrationId found in event`);
    }
  }
  async onRegistrationUpdated(event) {
    Logger.debugLog?.(`[Axcess] [onRegistrationUpdated] [START] Processing registration updated event`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      event: { value: event, type: "object", required: true },
    });

    if (cleaned.event.registration?.registrationId) {
      Logger.debugLog?.(`[Axcess] [onRegistrationUpdated] [PROCESSING] registrationId=${cleaned.event.registration.registrationId}`);
      
      Logger.debugLog?.(`[Axcess] [onRegistrationUpdated] [UPDATE] Updating registration token`);
      
      await this.svc.updateToken?.({
        id: cleaned.event.registration.registrationId,
        gateway: "axcess",
        updatedAt: this._now(),
      });
      
      Logger.debugLog?.(`[Axcess] [onRegistrationUpdated] [SUCCESS] Registration token updated successfully`);
    } else {
      Logger.debugLog?.(`[Axcess] [onRegistrationUpdated] [WARNING] No registrationId found in event`);
    }
  }

  /**
   * Schedule events.
   * @param {object} event
   */
  async onScheduleEvent(event) {
    Logger.debugLog?.(`[Axcess] [onScheduleEvent] [START] Processing schedule event`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      event: { value: event, type: "object", required: true },
    });

    const status =
      cleaned.event.type === "schedule_canceled"
        ? "canceled"
        : cleaned.event.type === "schedule_rescheduled"
        ? "rescheduled"
        : "active";
    
    Logger.debugLog?.(`[Axcess] [onScheduleEvent] [PROCESSING] Event type: ${cleaned.event.type}, Status: ${status}`);
    
    Logger.debugLog?.(`[Axcess] [onScheduleEvent] [UPSERT] Upserting schedule`);
    
    await this.svc.upsertSchedule?.({
      ...(cleaned.event.schedule || {}),
      status,
      updatedAt: this._now(),
    });
    
    Logger.debugLog?.(`[Axcess] [onScheduleEvent] [SUCCESS] Schedule event processed successfully`);
  }

  /**
   * Risk events (flagged/cleared).
   * @param {object} event
   */
  async onRiskEvent(event) {
    Logger.debugLog?.(`[Axcess] [onRiskEvent] [START] Processing risk event`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      event: { value: event, type: "object", required: true },
    });

    Logger.debugLog?.(`[Axcess] [onRiskEvent] [PROCESSING] Risk event type: ${cleaned.event.type}`);
    
    this._writeLog("onRiskEvent", `Risk webhook: ${cleaned.event.type}`, { risk: cleaned.event.risk });
    
    Logger.debugLog?.(`[Axcess] [onRiskEvent] [SUCCESS] Risk event processed successfully`);
  }

  /* ============================================================================
   * SECTION F — Reporting / Verification
   * Docs:
   *  https://axcessms.docs.oppwa.com/integrations/reporting/transaction
   * ========================================================================== */

  /**
   * Retrieve canonical transaction details from Axcess.
   * @param {object} params
   * @param {string} params.transactionId
   * @returns {Promise<object>}
   */
  async getTransactionDetails(params = {}) {
    const cleaned = SafeUtils.sanitizeValidate({
      transactionId: {
        value: params.transactionId,
        type: "string",
        required: true,
      },
    });
    const endpoint = this._paymentUrl(`/payments/${encodeURIComponent(cleaned.transactionId)}`);
    endpoint.searchParams.set('entityId', this.entityId);
    const res = await httpRequestWithBearer({
      urlString: endpoint.toString(),
      method: "GET",
      bearerToken: this.apiBearerToken,
      userAgent: this.userAgent,
      maxRequestBytes: this.maxRequestBytes,
      maxResponseBytes: this.maxResponseBytes,
      timeout: this.httpTimeoutMs,
    });

    if (res.status < 200 || res.status >= 300) {
      ErrorHandler.addError("Axcess getTransactionDetails failed", {
        code: "GET_TRANSACTION_DETAILS_FAILED",
        origin: "Axcess",
        data: {
          status: res.status,
          raw: res.raw,
          transactionId: cleaned.transactionId,
        },
      });
      throw createAxcessError("Failed to get transaction details", {
        code: "GET_TRANSACTION_DETAILS_FAILED",
        status: res.status,
        raw: res.raw,
        data: { transactionId: cleaned.transactionId },
      });
    }

    await this.svc.saveVerification?.(res.data);
    return res.data;
  }

  /**
   * Convenience: retrieve full order history from your persistence layer.
   * @param {string} orderId
   * @returns {Promise<object>}
   */
  async findOrderHistory(orderId) {
    return this.svc.getOrderHistory?.(orderId);
  }

  /* ============================================================================
   * SECTION G — Errors, Risk, Locales & Test Plan
   * Docs:
   *  https://axcessms.docs.oppwa.com/reference/resultCodes
   *  https://axcessms.docs.oppwa.com/reference/parameters
   *  https://axcessms.docs.oppwa.com/reference/workflows
   *  https://axcessms.docs.oppwa.com/reference/regression-testing
   * ========================================================================== */

  /**
   * Map Axcess result code to user-friendly message.
   * @param {string} resultCode
   * @returns {{code:string, uiMessage:string}}
   */
  mapResultCodeToUiMessage(resultCode) {
    const code = String(resultCode || "").trim();
    const M = (msg) => ({ code, uiMessage: msg });

    if (code.startsWith("000.")) return M("Payment approved.");
    if (code.startsWith("200.300."))
      return M("Payment declined by the issuer.");
    if (code.startsWith("100.396."))
      return M("3-D Secure authentication failed or was canceled.");
    if (code.startsWith("800.400."))
      return M("Invalid card data. Please check the number and expiry.");
    if (code.startsWith("700.")) return M("Payment expired or timed out.");
    return M("Payment failed. Please try another card or contact support.");
  }

  /**
   * Extract risk signals if present in payload.
   * @param {object} payload
   * @returns {{score?:number, reason?:string, rules?:string[]}}
   */
  extractRiskSignals(payload = {}) {
    Logger.debugLog?.(`[Axcess] [extractRiskSignals] [START] Extracting risk signals`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      payload: { value: payload, type: "object", required: false, default: {} },
    });

    const riskObj = cleaned.payload.risk || cleaned.payload.fraud || {};
    
    const result = {
      score: riskObj.score !== undefined ? SafeUtils.sanitizeFloat(riskObj.score) : undefined,
      reason: riskObj.reason || undefined,
      rules: SafeUtils.sanitizeArray(riskObj.rules) || undefined,
    };
    
    Logger.debugLog?.(`[Axcess] [extractRiskSignals] [SUCCESS] Risk signals extracted: score=${result.score || 'none'}, reason=${result.reason || 'none'}`);
    
    return result;
  }

  /**
   * Map app locale to widget 'lang'.
   * @param {string} appLocale
   * @returns {string|null}
   */
  resolveWidgetLanguage(appLocale) {
    if (!appLocale) return null;
    const lc = String(appLocale).toLowerCase();
    return this.localeMap[lc] || null;
  }

  /**
   * Emit a set of regression test scenarios (widget + S2S + 3DS).
   * @returns {{env:string, cases:string[]}}
   */
  buildRegressionTestPlan() {
    return {
      env: this.environmentLabel,
      cases: [
        "Widget: DB approved",
        "Widget: DB declined (issuer)",
        "Widget: 3DS challenge → approved",
        "Widget: 3DS challenge → failed",
        "S2S: PA → CP",
        "S2S: PA → RV",
        "S2S: DB approved",
        "S2S: DB declined",
        "S2S: RF partial",
        "Token: create → debit → delete",
        "Subscriptions: create → cancel → resume",
        "Webhook: payment_success",
        "Webhook: payment_failed",
        "Webhook: refund",
        "Webhook: chargeback",
        "Webhook: schedule_created/canceled",
        "Risk: flagged/cleared",
      ],
    };
  }

  /* ============================================================================
   * Private helpers
   * ========================================================================== */

  _coerceKeyTo32Bytes(secret) {
    // Accept base64 or hex or utf8 string and coerce to 32 bytes key
    if (!secret) {
      throw createAxcessError("Missing secret key", { code: "MISSING_SECRET_KEY" });
    }
    try {
      // try base64
      const b64 = Buffer.from(secret, "base64");
      if (b64.length === 32) return b64;
    } catch { }
    try {
      // try hex
      const hex = Buffer.from(secret.replace(/^0x/, ""), "hex");
      if (hex.length === 32) return hex;
    } catch { }
    // fallback: use sha256 of string
    return crypto.createHash("sha256").update(String(secret), "utf8").digest();
  }

  _flattenThreeDS(threeDSParams = {}) {
    // Axcess uses assorted threeDSecure.* parameters; pass through known keys directly
    // Use Object.keys() instead of Object.entries() to avoid temporary array allocations
    const flat = {};
    for (const k of Object.keys(threeDSParams)) {
      const v = threeDSParams[k];
      // Some parameters like shopperResultUrl should not be prefixed with threeDSecure.
      if (k === 'shopperResultUrl' || k === 'customerEmail') {
        flat[k] = v;
      } else {
        flat[`threeDSecure.${k}`] = v;
      }
    }
    // apply defaults if not provided
    if (
      !flat["threeDSecure.challengeWindowSize"] &&
      this.threeDSDefaults.challengeWindowSize
    ) {
      flat["threeDSecure.challengeWindowSize"] =
        this.threeDSDefaults.challengeWindowSize;
    }
    return flat;
  }

  _normalizePaymentResult(data = {}) {
    // Normalize standard fields from Copy&Pay / S2S responses
    const amount = Number(data.amount || data.card?.amount || 0);
    const currency = data.currency || data.card?.currency || null;
    const id = data.id || data.ndc || data.paymentId || null;
    const resultCode = data.result?.code || data.resultCode || null;
    const description =
      data.result?.description || data.resultDescription || "";
    const approved = String(resultCode || "").startsWith("000.");
    const pending = /pending/i.test(description);
    // Extract redirect properties for 3DS authentication
    const redirectUrl = data.redirect?.url || null;
    const redirectParams = data.redirect?.parameters || null;
    const uiMessage = this.mapResultCodeToUiMessage(resultCode).uiMessage;
    return { id, amount, currency, resultCode, description, approved, pending, uiMessage, redirectUrl, redirectParams };
  }

  async _handleS2SResponse(res, label, userId = null) {
    Logger.debugLog?.(`[Axcess] [_handleS2SResponse] [START] Handling S2S response for: ${label}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      res: { value: res, type: "object", required: true },
      label: { value: label, type: "string", required: true },
      userId: { value: userId, type: "string", required: false },
    });

    if (cleaned.res.status < 200 || cleaned.res.status >= 300) {
      Logger.debugLog?.(`[Axcess] [_handleS2SResponse] [ERROR] Axcess S2S ${cleaned.label} HTTP error: status=${cleaned.res.status}`);

      // Log parameter errors if available
      if (cleaned.res.raw?.result?.parameterErrors) {
        Logger.debugLog?.(`[Axcess] [_handleS2SResponse] [ERROR] Parameter errors: ${JSON.stringify(cleaned.res.raw.result.parameterErrors)}`);
      }

      ErrorHandler.addError(`Axcess S2S ${cleaned.label} HTTP error`, {
        code: "S2S_RESPONSE_ERROR",
        origin: "Axcess",
        data: {
          status: cleaned.res.status,
          raw: cleaned.res.raw,
          label: cleaned.label,
        },
      });

      throw createAxcessError(`Axcess S2S ${cleaned.label} failed (HTTP ${cleaned.res.status})`, {
        code: "S2S_RESPONSE_ERROR",
        status: cleaned.res.status,
        raw: cleaned.res.raw,
        data: {
          label: cleaned.label,
          result: cleaned.res.raw?.result,
          responseHeaders: cleaned.res.headers || null,
          rateLimit: cleaned.res.rateLimit || null,
        },
      });
    }
    
    Logger.debugLog?.(`[Axcess] [_handleS2SResponse] [PROCESSING] Normalizing payment result`);
    
    const normalized = this._normalizePaymentResult(cleaned.res.data || {});
    const currentTimestamp = this._nowUnixSeconds();
    
    // Use provided userId or default to system account
    // userId should be provided by caller to properly track user-specific transactions
    const effectiveUserId = cleaned.userId || "system";
    
    const record = {
      // ScyllaDB primary key - use provided userId or system account
      pk: `user#${effectiveUserId}`,
      sk: `txn#${normalized.id || currentTimestamp}`,
      // Transaction data
      gateway: "axcess",
      type: `s2s_${cleaned.label}`,
      gatewayTxnId: normalized.id || null,
      amount: normalized.amount || null,
      currency: normalized.currency || null,
      status: normalized.approved
        ? "success"
        : normalized.pending
          ? "pending"
          : "failed",
      code: normalized.resultCode || null,
      uiMessage: this.mapResultCodeToUiMessage(normalized.resultCode).uiMessage,
      raw: cleaned.res.data || {},
      responseHeaders: cleaned.res.headers || null,
      rateLimit: cleaned.res.rateLimit || null,
      createdAt: this._now(),
    };
    
    Logger.debugLog?.(`[Axcess] [_handleS2SResponse] [SAVE] Saving transaction: status=${record.status}`);
    
    this._checkServiceMethod('saveTransaction', true);
    const results = await this.svc.saveTransaction(record);
    
    Logger.debugLog?.(`[Axcess] [_handleS2SResponse] [PROCESSING] Transaction save results: ${JSON.stringify(results)}`);
    
    if (record.status === "success") {
      Logger.debugLog?.(`[Axcess] [_handleS2SResponse] [GRANT] Granting access for successful transaction`);
      if (this._checkServiceMethod('grantAccess', false)) {
        try {
          await this.svc.grantAccess({ txn: record });
        } catch (entitlementError) {
          ErrorHandler.addError("Failed to grant access after successful S2S transaction", {
            code: "ENTITLEMENT_GRANT_FAILED",
            origin: "Axcess",
            data: {
              label: cleaned.label,
              gatewayTxnId: record.gatewayTxnId,
              orderId: record.orderId || null,
              error: entitlementError.message,
            },
          });
          Logger.debugLog?.(`[Axcess] [_handleS2SResponse] [ENTITLEMENT_ERROR] Failed to grant access: ${entitlementError.message}`);
          // Continue processing - entitlement failure should not fail the transaction
        }
      }
    }
    if (record.status === "failed") {
      Logger.debugLog?.(`[Axcess] [_handleS2SResponse] [DENY] Denying access for failed transaction`);
      if (this._checkServiceMethod('denyAccess', false)) {
        try {
          await this.svc.denyAccess({ txn: record });
        } catch (entitlementError) {
          ErrorHandler.addError("Failed to deny access after failed S2S transaction", {
            code: "ENTITLEMENT_DENY_FAILED",
            origin: "Axcess",
            data: {
              label: cleaned.label,
              gatewayTxnId: record.gatewayTxnId,
              orderId: record.orderId || null,
              error: entitlementError.message,
            },
          });
          Logger.debugLog?.(`[Axcess] [_handleS2SResponse] [ENTITLEMENT_ERROR] Failed to deny access: ${entitlementError.message}`);
          // Continue processing - entitlement failure should not fail the transaction
        }
      }
    }
    
    Logger.debugLog?.(`[Axcess] [_handleS2SResponse] [SUCCESS] S2S response handled successfully`);
    
    return { normalized, raw: cleaned.res.data || {} };
  }

  /**
   * Handle 3DS authentication callback
   * @param {Object} params - 3DS callback parameters
   * @param {string} params.checkoutId - The checkout ID
   * @param {string} params.PaRes - Payment Authentication Response
   * @param {string} params.MD - Merchant Data
   * @param {string} params.orderId - Order ID
   * @param {string} params.userId - User ID
   * @returns {Promise<Object>} - Processing result
   */
  async handle3DSCallback(params) {
    Logger.debugLog?.(`[Axcess] [handle3DSCallback] [START] Processing 3DS callback`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      checkoutId: { value: params.checkoutId, type: "string", required: true },
      orderId: { value: params.orderId, type: "string", required: true },
      userId: { value: params.userId, type: "string", required: true },
      PaRes: { value: params.PaRes, type: "string", required: false },
      MD: { value: params.MD, type: "string", required: false },
    });

    try {
      Logger.debugLog?.(`[Axcess] [handle3DSCallback] [PROCESSING] checkoutId=${cleaned.checkoutId}, orderId=${cleaned.orderId}, hasPaRes=${!!cleaned.PaRes}, hasMD=${!!cleaned.MD}`);

      // Send PaRes to Axcess for verification
      Logger.debugLog?.(`[Axcess] [handle3DSCallback] [REQUEST] Sending 3DS verification request`);
      
      const requestUrl = this._paymentUrl(`/checkouts/${encodeURIComponent(cleaned.checkoutId)}/payment`);
      requestUrl.searchParams.set('entityId', this.entityId);
      
      const response = await httpRequestWithBearer({
        urlString: requestUrl.toString(),
        method: 'POST',
        bearerToken: this.apiBearerToken,
        userAgent: this.userAgent,
        maxRequestBytes: this.maxRequestBytes,
        maxResponseBytes: this.maxResponseBytes,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          authenticationResponse: cleaned.PaRes,
          merchantData: cleaned.MD
        }),
        timeout: this.httpTimeoutMs,
      });

      Logger.debugLog?.(`[Axcess] [handle3DSCallback] [RESPONSE] 3DS verification response: ${JSON.stringify(response.data)}`);

      // Process the payment result
      const result = this._normalizePaymentResult(response.data);

      Logger.debugLog?.(`[Axcess] [handle3DSCallback] [SAVE] Saving transaction with 3DS data`);

      // Save transaction with 3DS data
      const currentTimestamp = this._nowUnixSeconds();
      const txn = {
        pk: `user#${cleaned.userId}`,
        sk: `ORDER#${cleaned.orderId}#${currentTimestamp}`,
        gateway: "axcess",
        orderId: cleaned.orderId,
        userId: cleaned.userId,
        gatewayTxnId: result.id || null,
        amount: result.amount || null,
        currency: result.currency || null,
        status: result.approved ? "success" : result.pending ? "pending" : "failed",
        code: result.resultCode || null,
        uiMessage: this.mapResultCodeToUiMessage(result.resultCode).uiMessage,
        raw: response.data,
        responseHeaders: response?.headers || null,
        rateLimit: response?.rateLimit || null,
        createdAt: this._now(),
        // 3DS specific data
        threeDS: {
          authentication: response.data?.result?.threeDS?.authentication || null,
          eci: response.data?.result?.threeDS?.eci || null,
          cavv: response.data?.result?.threeDS?.cavv || null,
          xid: response.data?.result?.threeDS?.xid || null,
          enrolled: response.data?.result?.threeDS?.enrolled || null
        }
      };

      this._checkServiceMethod('saveTransaction', true);
      await this.svc.saveTransaction(txn);

      Logger.debugLog?.(`[Axcess] [handle3DSCallback] [SUCCESS] 3DS callback processed successfully`);

      return {
        success: result.approved,
        orderId: cleaned.orderId,
        amount: result.amount,
        currency: result.currency,
        status: result.approved ? "success" : "failed",
        reason: result.approved ? "Payment successful" : result.uiMessage,
        threeDS: txn.threeDS
      };

    } catch (error) {
      ErrorHandler.addError("3DS callback processing failed", {
        code: "3DS_CALLBACK_FAILED",
        origin: "Axcess",
        data: {
          error: error.message,
          checkoutId: cleaned.checkoutId,
          orderId: cleaned.orderId,
        },
      });
      Logger.debugLog?.(`[Axcess] [handle3DSCallback] [ERROR] 3DS callback processing failed: ${error.message}`);
      throw createAxcessError(`3DS callback failed: ${error.message}`, {
        code: "3DS_CALLBACK_FAILED",
        data: { checkoutId: cleaned.checkoutId, orderId: cleaned.orderId },
        cause: error,
      });
    }
  }

}

// Global unhandled rejection handler to prevent crashes in Lambda functions
process.on('unhandledRejection', (reason, promise) => {
  ErrorHandler.addError("Unhandled promise rejection", {
    code: "UNHANDLED_REJECTION",
        origin: "Axcess",
        data: {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
        },
      });
  Logger.debugLog?.(`[Axcess] [UNHANDLED_REJECTION] ${reason instanceof Error ? reason.message : String(reason)}`);
  // Log the error but don't crash - allow the application to continue
  // In production, this should be monitored via CloudWatch or similar
});

module.exports = Axcess;
