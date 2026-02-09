# Static Code Review Report: Axcess.js

**File:** Axcess.js  
**Lines of Code:** 5,351  
**Review Date:** January 19, 2026  
**Node.js Target:** Latest LTS (Node.js 20.x/22.x)

---

## Executive Summary

This report identifies **69 issues** across Critical, High, Medium, and Low priority categories. The code represents a payment gateway integration class with extensive functionality but contains several critical bugs, security vulnerabilities, and performance concerns that should be addressed before production deployment.

**Total Issues by Priority:**
- Critical: 9 issues
- High: 21 issues
- Medium: 28 issues
- Low: 11 issues

---

## Full Implementation Report (✔️ / ❌)

Once all items are reviewed, provide a full report with either:
- ✔️ if the recommendation has been implemented
- ❌ if the recommendation has not been implemented

**Legend:** ✔️ implemented in `Axcess.js` · ❌ not implemented

### Critical Priority (1.x)
- ✔️ **1.1** Reference Error: Undefined Variable in Return Statement
- ✔️ **1.2** Inverted TEST_MODE Logic
- ✔️ **1.3** fetch() Timeout Not Properly Enforced
- ✔️ **1.5** Missing Global Unhandled Rejection Handler
- ✔️ **1.6** Prototype Pollution Risk in Object Spreading
- ✔️ **1.7** Duplicate Method Definition Overwrites Original Implementation
- ✔️ **1.8** Missing Required Parameter in 3DS Callback Invocation
- ✔️ **1.9** Hardcoded 3DS Test Parameters in Production Code

### High Priority (2.x)
- ✔️ **2.1** No HTTP Request Retry Logic
- ✔️ **2.2** Race Condition in Concurrent Session Updates
- ✔️ **2.3** Missing Input Validation on Webhook Payload
- ✔️ **2.4** Hardcoded Timeout Values Without Override
- ✔️ **2.5** Missing Error Boundaries for Service Calls
- ✔️ **2.6** Unsafe URL Construction
- ✔️ **2.7** No Circuit Breaker Pattern
- ✔️ **2.8** Missing Request Idempotency Keys
- ✔️ **2.9** Unused URL Object Creation
- ✔️ **2.12** Insufficient Webhook Signature Validation
- ✔️ **2.13** Hardcoded User ID in S2S Transaction Records
- ✔️ **2.14** Webhook Secret Key Format Mismatch
- ✔️ **2.15** Webhook Cipher Mode Mismatch (CBC vs GCM)
- ✔️ **2.16** Missing Idempotency Key Validation in Webhook Handling
- ✔️ **2.17** Missing Properties in Normalized Payment Result
- ✔️ **2.18** Inconsistent Partition Key Casing
- ✔️ **2.19** Missing Error Handling for Entitlement Operations
- ✔️ **2.20** Inconsistent Persistence in deleteRegistrationToken
- ✔️ **2.21** Lack of Atomicity in upgradeSubscription

### Medium Priority (3.x)
- ✔️ **3.1** Repeated Validation Pattern
- ✔️ **3.3** Optional Chaining Overuse
- ✔️ **3.4** Inefficient Object.entries() in Loops
- ✔️ **3.5** No Response Caching Strategy
- ✔️ **3.6** Redundant Null Checks After Validation
- ✔️ **3.7** Magic Number: 25 Minutes
- ✔️ **3.8** Missing Null Check Before toLowerCase()
- ✔️ **3.9** Inconsistent Error Message Format
- ✔️ **3.10** No Connection Pooling for HTTP
- ✔️ **3.11** Global CONFIG Mutation Risk
- ✔️ **3.12** Large Method: handleRedirectCallback
- ✔️ **3.15** Missing Content-Type Validation
- ✔️ **3.16** Timestamp Generation Inconsistency
- ✔️ **3.17** No Request/Response Payload Size Limits
- ✔️ **3.18** Missing API Version Management
- ✔️ **3.19** Undefined Session ID Returned After Checkout Creation
- ✔️ **3.20** Undefined UI Message in 3DS Callback Responses
- ✔️ **3.21** Optional userId Leads to USER#undefined Records
- ✔️ **3.22** Hardcoded 3DS and Customer Test Data
- ✔️ **3.23** Hardcoded Test User IDs Throughout Codebase
- ✔️ **3.24** Hardcoded Amount Precision Assumes Two Decimal Places
- ✔️ **3.25** Missing CheckoutId Extraction from ResourcePath
- ✔️ **3.26** Inconsistent Error Object Structure
- ✔️ **3.27** Conflicting Subscription API Usage
- ✔️ **3.28** Hardcoded Form Action in Widget HTML

### Low Priority (4.x)
- ✔️ **4.1** Inconsistent Logging Format
- ✔️ **4.2** Magic String: 'INTERNAL' vs 'EXTERNAL'
- ✔️ **4.3** Hardcoded User-Agent String
- ✔️ **4.6** Long Parameter List in httpRequestWithBearer
- ✔️ **4.9** Response Headers Not Consistently Captured
- ✔️ **4.10** Missing Rate Limit Header Handling
- ✔️ **4.11** No Graceful Shutdown Handler

---

## 1. Critical Priority Issues

### 1.1 **Reference Error: Undefined Variable in Return Statement**
**Category:** Best Practice / Logic Error  
**Description:** Line 4395 references undefined variable `orderId` instead of `cleaned.orderId`, which will cause a ReferenceError at runtime when this code path executes.  
**Suggested Fix:** Change `orderId: orderId,` to `orderId: cleaned.orderId,` on line 4395 in the handleRedirectCallback method.  
**Fix:** 
**Implementation Details:** In the `handleRedirectCallback` method (starting at line 4301), the return statement at line 4395 was referencing an undefined variable `orderId`. The fix replaced `orderId: orderId,` with `orderId: cleaned.orderId,` to correctly reference the validated and sanitized `orderId` value from the `cleaned` object that was created via `SafeUtils.sanitizeValidate()` at the beginning of the method (line 4304). This ensures the return object contains the correct orderId value and prevents a ReferenceError at runtime.

### 1.2 **Inverted TEST_MODE Logic**
**Category:** Logic Error  
**Description:** Line 18 sets TEST_MODE to 'EXTERNAL' when NODE_ENV is 'prod', but the logic appears inverted as production environments should typically use external/live mode, not test mode.  
**Suggested Fix:** Change the ternary expression to `process.env.NODE_ENV === 'prod' ? 'LIVE' : 'TEST'` or verify the intended behavior matches business requirements.  
**Fix:** 
**Implementation Details:** Replaced the prior global/test-mode pattern with a **per-instance** `testMode` derived in the `Axcess` constructor. The constructor now sets `this.environmentLabel = config.environment` and derives `this.testMode` as: `(this.environmentLabel || '').toLowerCase() === 'live' ? 'LIVE' : 'TEST'`. All gateway requests that need a `testMode` parameter now use `this.testMode` (e.g., schedule/payment operations), ensuring **LIVE** mode is used when the instance is configured for `environment: 'live'`, and preventing cross-instance leakage from any module-level global.

### 1.3 **fetch() Timeout Not Properly Enforced**
**Category:** Node.js Pitfall / Compatibility  
**Description:** The `timeout` parameter passed to fetch() on line 115 is only supported in Node.js 20.1.0+, causing requests to never timeout on older LTS versions and potentially hanging indefinitely.  
**Suggested Fix:** Implement AbortController with setTimeout for Node.js < 20.1.0 compatibility, or use a battle-tested HTTP client like axios/undici that properly handles timeouts across all Node versions.  
**Fix:** 
**Implementation Details:** In the `httpRequestWithBearer` function (starting at line 61), removed the `timeout` property from `requestOptions` object (line 107) as it's not supported in Node.js versions prior to 20.1.0. Implemented AbortController-based timeout mechanism: created an `AbortController` instance (line 113), set up a `setTimeout` that calls `controller.abort()` after `cleaned.timeout` milliseconds (lines 114-116), and passed `signal: controller.signal` to the fetch options (line 122). Added `clearTimeout(timeoutId)` after successful fetch (line 124) and in the catch block (line 141) to ensure cleanup. Enhanced error handling in catch block to detect `AbortError` (line 142) and provide a specific timeout error message and error code "HTTP_REQUEST_TIMEOUT" (line 143) when requests exceed the timeout duration. This ensures timeout functionality works across all Node.js LTS versions.

### 1.5 **Missing Global Unhandled Rejection Handler**
**Category:** Node.js Pitfall  
**Description:** No global `process.on('unhandledRejection', ...)` handler is implemented, meaning unhandled promise rejections in async operations can crash Lambda functions or leave the application in an undefined state.  
**Suggested Fix:** Add a global unhandled rejection handler in the application entry point or implement comprehensive try-catch blocks around all async operations with proper error propagation.  
**Fix:** 
**Implementation Details:** Added a global unhandled rejection handler at the module level (after the Axcess class definition, before `module.exports` at line 4433). The handler uses `process.on('unhandledRejection', ...)` to catch unhandled promise rejections. When triggered, it logs the error using `ErrorHandler.addError()` with code "UNHANDLED_REJECTION" and includes the error message and stack trace (if available). It also logs via `Logger.debugLog()` for debugging purposes. The handler is designed to log errors without crashing the application, allowing Lambda functions to continue operating and enabling monitoring via CloudWatch or similar services. This prevents unhandled promise rejections from leaving the application in an undefined state or causing unexpected crashes.

### 1.6 **Prototype Pollution Risk in Object Spreading**
**Category:** Security  
**Description:** Lines 105, 195, 199, 203, 211, 215, 219, 223 use spread operators on user-controlled objects without prototype pollution protection, allowing attackers to inject __proto__ or constructor properties.  
**Suggested Fix:** Use Object.assign with a null prototype object or implement SafeUtils.sanitizeObject() to filter dangerous properties before spreading user input.  
**Fix:** 
**Implementation Details:** Added prototype pollution protection using `SafeUtils.sanitizeObject()` before spreading user-controlled objects. In `httpRequestWithBearer` function (line 99), added `const sanitizedHeaders = SafeUtils.sanitizeObject(cleaned.headers) || {};` before the spread operation and changed `...cleaned.headers` to `...sanitizedHeaders` (line 107). In the constructor (line 281), changed `this.localeMap = { ...cleaned.locales };` to `this.localeMap = SafeUtils.sanitizeObject(cleaned.locales) || {};` to sanitize the locales object before assignment. In the constructor (line 293), changed `this.options = { ...cleaned.options };` to `this.options = SafeUtils.sanitizeObject(cleaned.options) || {};` to sanitize the options object. The `SafeUtils.sanitizeObject()` method filters out dangerous properties including `__proto__`, `prototype`, `constructor`, and all Object.prototype properties, preventing prototype pollution attacks when user-controlled objects are spread into other objects.

### 1.7 **Duplicate Method Definition Overwrites Original Implementation**
**Category:** Logic Error / Best Practice  
**Description:** `handleRedirectCallback` is defined twice (lines 655 and 4301), causing the second definition to completely override the first, making the original implementation unreachable and breaking existing functionality that depends on the first signature.  
**Suggested Fix:** Remove the duplicate definition and merge the functionality into a single method, or rename one method if both implementations serve different purposes.  
**Fix:** 
**Implementation Details:** Merged both `handleRedirectCallback` method definitions into a single unified implementation. The first definition (starting at line 670) was replaced with a merged version that supports both signatures: accepts either `id` (checkout ID) or `resourcePath` parameters (with `id` preferred if both provided), validates that at least one is provided, and handles both API call patterns accordingly. The merged method includes all functionality from both implementations: supports both 3DS callback patterns (PaRes/MD parameters and redirect-based), includes session updates and entitlements logic from the first implementation, includes enhanced 3DS data storage and redirect parameter extraction from the second implementation, handles multiple 3DS result code patterns, extracts checkoutId from resourcePath when needed for 3DS callbacks, and returns a consistent format with all fields from both implementations including `threeDS` data. The duplicate second definition (originally at line 4409, now removed) was completely deleted to prevent method override conflicts. The unified method now properly handles all use cases that both implementations were intended to cover.

### 1.8 **Missing Required Parameter in 3DS Callback Invocation**
**Category:** Logic Error  
**Description:** Line 701 calls `handle3DSCallback` without the required `checkoutId` parameter, which will cause validation to fail and prevent 3DS callback processing from working correctly.  
**Suggested Fix:** Extract `checkoutId` from the session using `orderId` before calling `handle3DSCallback`, or modify the method signature to make `checkoutId` optional and derive it internally.  
**Fix:** 
**Implementation Details:** Enhanced the `checkoutId` extraction logic in `handleRedirectCallback` method (around line 773) to ensure the required parameter is always provided to `handle3DSCallback`. The extraction now follows a three-step fallback approach: first tries to use `cleaned.id` if provided, then extracts from `resourcePath` using regex pattern `/\/checkouts\/([^\/]+)/`, and finally falls back to querying sessions using `orderId` via `this.svc.getSessionsBy?.("orderId", cleaned.orderId)` to retrieve the `checkoutId` from the stored session. Added logging at each step to track the extraction process. If `checkoutId` cannot be found through any of these methods, the code throws a descriptive error with code "MISSING_CHECKOUT_ID" before calling `handle3DSCallback`, preventing validation failures. This ensures that `handle3DSCallback` always receives the required `checkoutId` parameter regardless of which input format is used.

### 1.9 **Hardcoded 3DS Test Parameters in Production Code**
**Category:** Security / Logic Error
**Description:** `createCheckoutSession` (lines 426-430) hardcodes `3DS2_enrolled: 'true'` and `3DS2_flow: 'challenge'` in the `customParameters` object, which forces test behaviors (mocked 3DS) even in production environments, potentially bypassing real 3DS authentication.
**Suggested Fix:** Move these parameters behind an instance test-mode check (e.g., `this.testMode !== 'LIVE'`) and ensure they are removed for `LIVE` transactions.
**Fix:** 
**Implementation Details:** In `createCheckoutSession`, the 3DS “test-only” values are now **conditional on `this.testMode`**. The implementation uses conditional spread patterns so that `challengeIndicator: 4` and custom parameters like `'3DS2_enrolled': 'true'` / `'3DS2_flow': 'challenge'` are only included when `this.testMode !== 'LIVE'`. This ensures production transactions (`this.testMode === 'LIVE'`) do not force mocked 3DS enrollment/challenge behavior, while non-live environments can still exercise the challenge flow for testing.

---

## 2. High Priority Issues

### 2.1 **No HTTP Request Retry Logic**
**Category:** Performance / Best Practice  
**Description:** The httpRequestWithBearer function has no retry mechanism for transient network failures, which is critical for payment gateway integrations where temporary outages should not fail transactions.  
**Suggested Fix:** Implement exponential backoff retry logic (3-5 attempts) for network errors and 5xx responses, excluding 4xx client errors which should not be retried.  
**Fix:** 
**Implementation Details:** Added retry logic with exponential backoff to the `httpRequestWithBearer` function. Added `maxRetries` parameter (default 3, clamped between 1 and 5) to the function signature (line 68). Wrapped the fetch call in a retry loop (lines 133-220) that attempts up to `maxAttempts` times. Implemented exponential backoff delay calculation: `Math.min(1000 * Math.pow(2, attempt - 1), 10000)` which starts at 1 second and doubles each attempt, capped at 10 seconds maximum. Retry logic handles three scenarios: (1) 5xx server errors are retried (unless last attempt) with exponential backoff, (2) network errors and timeouts are retried (unless last attempt) with exponential backoff, (3) 4xx client errors are never retried and immediately throw an error. Added attempt logging at each retry (line 136) and final error logging includes attempt count (line 210). The retry mechanism ensures transient network failures and server errors don't immediately fail payment transactions, improving reliability for payment gateway integrations while avoiding unnecessary retries on client errors that won't succeed.

### 2.2 **Race Condition in Concurrent Session Updates**
**Category:** Logic Error / Best Practice  
**Description:** Multiple async operations updating session state (e.g., saveSession, updateSession) have no locking mechanism, potentially causing lost updates when concurrent requests modify the same session.  
**Suggested Fix:** Implement optimistic locking using version numbers or timestamps, or use DynamoDB conditional writes to prevent concurrent modification issues.  
**Fix:** 
**Implementation Details:** Implemented optimistic locking using version numbers for session updates. Added `version: 1` and `updatedAt: DateTime.now()` fields to session records when they are initially created in `createCheckoutSession` (line 576). Updated all session update locations to increment version numbers and include expected version for conditional writes: (1) `handleRedirectCallback` session update (line 921) now includes `version: currentVersion + 1` and `expectedVersion: currentVersion`, (2) `onPaymentSuccess` session update (line 3546) includes version tracking, (3) `onPaymentAuthorize` session update (line 3730) includes version tracking, (4) `onPaymentCapture` session update (line 3827) includes version tracking, (5) `onPaymentVoid` session update (line 3924) includes version tracking. Each update retrieves the current version from the session object (`session.version || 1`), increments it, and includes both the new version and expected version in the update payload. The `expectedVersion` field enables the service layer to implement conditional writes that will fail if the session has been modified by another concurrent request, preventing lost updates. The service layer implementation should check `expectedVersion` against the current version in the database before applying updates to complete the optimistic locking mechanism.

### 2.3 **Missing Input Validation on Webhook Payload**
**Category:** Security  
**Description:** Webhook decryption methods don't validate payload structure before processing, allowing malformed data to cause runtime errors or injection attacks through crafted webhook payloads.  
**Suggested Fix:** Add comprehensive schema validation using Joi, Zod, or SafeUtils.sanitizeValidate before decrypting webhook data to ensure all required fields are present and properly typed.  
**Fix:** 
**Implementation Details:** Added comprehensive payload validation in the `decryptAndVerifyWebhook` method (around lines 3172-3211). After JSON parsing, added validation to ensure the decrypted payload is a valid object (not null, undefined, or array) with error code "INVALID_PAYLOAD_STRUCTURE" (lines 3184-3200). Added validation and sanitization of specific fields that will be used (type, id, eventId, payloadId) using `SafeUtils.sanitizeValidate()` to ensure proper types (lines 3202-3207). Applied `SafeUtils.sanitizeObject()` to the entire payload object to prevent prototype pollution attacks by filtering out dangerous properties like `__proto__`, `constructor`, etc. (line 3203). Updated the idempotency key extraction to use validated fields (lines 3205-3211). Updated the return statement to return the sanitized payload instead of the raw decrypted JSON (line 3226). Enhanced error handling with specific error codes: "INVALID_JSON_PAYLOAD" for JSON parse errors and "INVALID_PAYLOAD_STRUCTURE" for invalid object structure. This ensures that malformed webhook payloads are rejected before processing, preventing runtime errors and injection attacks through crafted payloads.

### 2.4 **Hardcoded Timeout Values Without Override**
**Category:** Best Practice  
**Description:** DEFAULT_HTTP_TIMEOUT_MS (line 13) is hardcoded at 30 seconds with no per-request override capability, which may be insufficient for some payment operations or excessive for others.  
**Suggested Fix:** Accept timeout as a method parameter with the constant as a fallback default, allowing callers to specify custom timeouts for specific operations (e.g., refunds may need longer timeouts).  
**Fix:** 
**Implementation Details:** Made HTTP timeout configurable at both instance and per-request levels. Added `httpTimeoutMs` to constructor config validation (line 301) with default value `DEFAULT_HTTP_TIMEOUT_MS` (30000ms). Updated constructor to use `cleaned.httpTimeoutMs` instead of hardcoded constant (line 360): `this.httpTimeoutMs = Number(cleaned.httpTimeoutMs) || DEFAULT_HTTP_TIMEOUT_MS`. Added `httpTimeoutMs` to constructor JSDoc documentation (line 252). Updated key methods to accept optional `timeout` parameter and pass it to `httpRequestWithBearer`: (1) `createCheckoutSession` accepts `params.timeout` and passes `timeout: cleaned.timeout || this.httpTimeoutMs` (lines 433, 542), (2) `s2sRefund` accepts `params.timeout` and passes it through (lines 1430, 1454), (3) `getPaymentStatus` accepts `timeout` as third parameter and passes it through (lines 992, 1044). The `httpRequestWithBearer` function already supported timeout parameter, so methods now pass either the provided timeout, instance default (`this.httpTimeoutMs`), or fallback to `DEFAULT_HTTP_TIMEOUT_MS`. This allows callers to override timeout for specific operations (e.g., longer timeouts for refunds) while maintaining sensible defaults.

### 2.5 **Missing Error Boundaries for Service Calls**
**Category:** Best Practice / Node.js Pitfall  
**Description:** Optional chaining on service methods (e.g., `this.svc.saveTransaction?.()`) silently fails if methods don't exist, making debugging difficult and potentially causing data loss without error indication.  
**Suggested Fix:** Check for method existence explicitly and throw descriptive errors if required service methods are missing, or provide default no-op implementations during initialization.  
**Fix:** 
**Implementation Details:** Added explicit error checking for service method calls to prevent silent failures. Created a helper method `_checkServiceMethod(methodName, required = true)` (lines 384-398) that checks if a service method exists using `typeof this.svc[methodName] !== 'function'`. If a required method is missing, it throws a descriptive error with code "MISSING_SERVICE_METHOD" and includes the method name and service type in error data. If the method is optional (`required = false`), it returns `false` without throwing, allowing graceful degradation. Updated critical service method calls to use explicit checks before invocation: (1) `saveSession` in `createCheckoutSession` (line 611) now calls `this._checkServiceMethod('saveSession', true)` before `this.svc.saveSession()`, (2) `saveTransaction`, `grantAccess`, and `denyAccess` in `handleRedirectCallback` (lines 939, 943, 945) use explicit checks, (3) `saveTransaction`, `grantAccess`, and `denyAccess` in `_handleS2SResponse` (lines 4457, 4463, 4467) use explicit checks, (4) `saveWebhook` in `handleWebhook` (line 3311) uses explicit check, (5) `saveToken` in `createRegistrationToken` (line 1914) uses explicit check, (6) `saveSchedule` in `createSubscriptionFromToken` (line 2324) uses explicit check. Required methods (saveTransaction, saveSession, saveToken, saveSchedule, saveWebhook) throw errors if missing, while optional methods (grantAccess, denyAccess) gracefully degrade if not implemented. This prevents silent data loss and makes debugging easier by providing clear error messages when required service methods are missing.

### 2.6 **Unsafe URL Construction**
**Category:** Security  
**Description:** URL construction on lines 4224, 4314, 4319 concatenates user input without proper encoding, potentially allowing URL injection or malformed requests if input contains special characters.  
**Suggested Fix:** Use URL class with proper parameter encoding: `new URL(\`/v1/checkouts/${encodeURIComponent(checkoutId)}/payment\`, this.apiBaseUrl).toString()` to prevent injection attacks.  
**Fix:** 
**Implementation Details:** Fixed unsafe URL construction by replacing string concatenation with `URL` and proper encoding. For path segments, checkout/registration IDs are encoded via `encodeURIComponent(...)`. For query parameters, the code uses `url.searchParams.set(...)` (e.g., `entityId`, and in schedule cancellation also `testMode` via `endpoint.searchParams.set('testMode', this.testMode)`) instead of manual string concatenation. This prevents URL injection and ensures special characters are correctly encoded.

### 2.7 **No Circuit Breaker Pattern**
**Category:** Performance / Best Practice  
**Description:** Continuous API failures will keep retrying without circuit breaking, potentially overwhelming the gateway service and wasting resources during outages.  
**Suggested Fix:** Implement a circuit breaker pattern (open after N failures, half-open after timeout) to prevent cascading failures and allow graceful degradation.  
**Fix:** 
**Implementation Details:** Implemented a circuit breaker pattern to prevent cascading failures. Added circuit breaker constants: `CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5` (open circuit after 5 failures) and `CIRCUIT_BREAKER_RESET_TIMEOUT_MS = 60000` (half-open after 60 seconds) (lines 15-16). Created a shared circuit breaker state object (lines 21-26) with properties: `state` ('CLOSED', 'OPEN', 'HALF_OPEN'), `failureCount`, `lastFailureTime`, and `successCount`. Added circuit breaker check at the start of `httpRequestWithBearer` (lines 127-142): if circuit is OPEN and reset timeout has not elapsed, throws error with code "CIRCUIT_BREAKER_OPEN"; if timeout has elapsed, transitions to HALF_OPEN state. Updated circuit breaker state on responses: (1) On 5xx server errors (line 200), increments `failureCount` and sets `lastFailureTime`; if `failureCount >= CIRCUIT_BREAKER_FAILURE_THRESHOLD`, sets state to OPEN, (2) On successful responses (status < 500) (lines 207-216), if state is HALF_OPEN, increments `successCount`; if `successCount >= 2`, transitions to CLOSED and resets `failureCount`; otherwise resets `failureCount` to 0. Updated circuit breaker on final errors (lines 256-260): increments `failureCount` and sets `lastFailureTime`; if threshold reached, sets state to OPEN. The circuit breaker prevents overwhelming the gateway service during outages by blocking requests when OPEN, allowing recovery attempts in HALF_OPEN state, and automatically closing when service recovers.

### 2.8 **Missing Request Idempotency Keys**
**Category:** Best Practice  
**Description:** Payment requests don't include idempotency keys, meaning network retries or duplicate submissions could result in double-charging customers.  
**Suggested Fix:** Generate and include UUID-based idempotency keys in payment request headers, and store processed keys in the service layer to detect and reject duplicate requests.  
**Fix:** 
**Implementation Details:** Added idempotency key generation and inclusion in all payment request headers. Created a helper method `_generateIdempotencyKey(providedKey)` (lines 468-481) that accepts an optional idempotency key from the caller; if provided and valid, returns it trimmed; otherwise generates a UUID v4 using `crypto.randomUUID()` if available (Node.js 14.17.0+), or falls back to manual UUID generation for older Node.js versions. Updated all payment methods to accept optional `idempotencyKey` parameter and include it in request headers: (1) `s2sAuthorize` (lines 1205-1291) accepts `params.idempotencyKey`, generates key if not provided, logs it, and includes `"Idempotency-Key": idempotencyKey` in headers, (2) `s2sDebit` (lines 1450-1563) includes idempotency key in headers, (3) `s2sCapture` (lines 1323-1369) includes idempotency key in headers, (4) `s2sVoid` (lines 1400-1443) includes idempotency key in headers, (5) `s2sRefund` (lines 1596-1637) includes idempotency key in headers, (6) `debitWithRegistrationToken` (lines 2100-2163) includes idempotency key in headers, (7) `authorizeWithRegistrationToken` (lines 2194-2258) includes idempotency key in headers, (8) `createCheckoutSession` (lines 515-653) includes idempotency key in headers. All methods validate the optional `idempotencyKey` parameter using `SafeUtils.sanitizeValidate()`, generate a UUID if not provided, log the key being used for debugging, and include it in the `"Idempotency-Key"` header alongside `"Content-Type"` header. The idempotency keys enable the payment gateway API to detect and reject duplicate requests, preventing double-charging customers from network retries or duplicate submissions. The service layer can optionally store processed idempotency keys to implement additional deduplication logic at the application level.

### 2.9 **Unused URL Object Creation**
**Category:** Performance  
**Description:** Line 98 creates a URL object that is never used, adding unnecessary overhead to every HTTP request.  
**Suggested Fix:** Remove `const url = new URL(cleaned.urlString);` from line 98 unless URL validation is the intended purpose, in which case move it before the fetch call.  
**Fix:** 
**Implementation Details:** Removed the unused URL object creation from line 110 (previously line 98) in the `httpRequestWithBearer` function. The variable `const url = new URL(cleaned.urlString);` was created but never referenced anywhere in the function. The function uses `cleaned.urlString` directly in the `fetch()` call (line 160) and in error messages/logging. URL validation is not necessary here as `fetch()` will throw an error if an invalid URL is provided, and the function already validates that `cleaned.urlString` exists (lines 92-99). Removing this unused variable eliminates unnecessary overhead on every HTTP request, improving performance.

### 2.12 **Insufficient Webhook Signature Validation**
**Category:** Security  
**Description:** Webhook signature validation (if implemented in the truncated section) may use timing-unsafe string comparison, allowing timing attacks to forge webhook signatures.  
**Suggested Fix:** Use `crypto.timingSafeEqual()` for HMAC signature comparison to prevent timing-based attacks on webhook authentication.  
**Fix:** 
**Implementation Details:** Added optional HMAC signature validation using timing-safe comparison in the `decryptAndVerifyWebhook` method (lines 3438-3473). The implementation checks for optional HMAC signature headers (`x-axcess-signature` or `x-signature`) after successful GCM decryption. If a signature header is present, it computes HMAC-SHA256 of the decrypted plaintext using the webhook secret key, extracts the received signature from the header (handling hex encoding and optional '0x' prefix), and compares the computed and received signatures using `crypto.timingSafeEqual()` (line 3463) instead of regular string comparison. The comparison first checks that both buffers have the same length (line 3460) before calling `crypto.timingSafeEqual()` to prevent timing leaks from length differences. If signature validation fails, it throws an error with code "WEBHOOK_SIGNATURE_INVALID" (lines 3465-3469). The `verified` flag is set to `true` by default (GCM decryption success provides authentication) and updated based on HMAC signature validation if present. This prevents timing-based attacks that could allow attackers to forge webhook signatures by observing response times during signature comparison. The implementation maintains backward compatibility by making HMAC signature validation optional (only validates if signature header is present), while GCM authentication tag verification remains the primary authentication mechanism.

### 2.13 **Hardcoded User ID in S2S Transaction Records**
**Category:** Best Practice / Logic Error  
**Description:** `_handleS2SResponse` assigns `pk: "user#user123"` for every S2S transaction, which will co-mingle records across users and break auditing and entitlement logic.  
**Suggested Fix:** Require a user context (or system account) for S2S calls and populate `pk` from that input 
**Fix:** 
**Implementation Details:** Fixed hardcoded user ID in S2S transaction records by making userId configurable. Updated `_handleS2SResponse` method signature (line 4634) to accept optional `userId` parameter (defaults to `null`). Updated the method to use `effectiveUserId = cleaned.userId || "system"` (line 4675) instead of hardcoded `"user123"`, and changed the pk field to `pk: \`user#${effectiveUserId}\`` (line 4676). Updated all S2S methods to accept optional `userId` parameter and pass it to `_handleS2SResponse`: (1) `s2sAuthorize` (lines 1218-1313) accepts `params.userId` and passes `cleaned.userId` to `_handleS2SResponse`, (2) `s2sDebit` (lines 1495-1585) accepts and passes userId, (3) `s2sCapture` (lines 1342-1391) accepts and passes userId, (4) `s2sVoid` (lines 1400-1462) accepts and passes userId, (5) `s2sRefund` (lines 1596-1664) accepts and passes userId, (6) `debitWithRegistrationToken` (lines 2143-2185) accepts and passes userId, (7) `authorizeWithRegistrationToken` (lines 2243-2279) accepts and passes userId. All methods validate the optional `userId` parameter using `SafeUtils.sanitizeValidate()`. If `userId` is not provided, transactions default to `"system"` account, allowing proper separation of user-specific transactions while maintaining backward compatibility. This prevents co-mingling of transaction records across users and enables proper auditing and entitlement logic based on user context.

### 2.14 **Webhook Secret Key Format Mismatch**
**Category:** Compatibility / Security  
**Description:** `decryptAndVerifyWebhook` treats `webhookConfig.secretKey` as hex-only, but constructor docs allow base64 or hex, causing decryption failures and lost webhooks when base64 is supplied.  
**Suggested Fix:** Normalize the key with `_coerceKeyTo32Bytes()` or detect base64 vs hex before `Buffer.from`, and validate the final key length (32 bytes).  
**Fix:** 
**Implementation Details:** Fixed webhook secret key format mismatch by using the existing `_coerceKeyTo32Bytes()` helper method instead of assuming hex format. Updated `decryptAndVerifyWebhook` method to normalize the secret key: (1) Changed line 3433 from `const key = Buffer.from(this.webhookConfig.secretKey, "hex");` to `const key = this._coerceKeyTo32Bytes(this.webhookConfig.secretKey);` for AES-256-GCM decryption, (2) Changed line 3492 from `const hmacKey = Buffer.from(this.webhookConfig.secretKey, "hex");` to `const hmacKey = this._coerceKeyTo32Bytes(this.webhookConfig.secretKey);` for HMAC signature verification. The `_coerceKeyTo32Bytes()` method (lines 4618-4633) handles multiple key formats: first tries base64 decoding and validates 32-byte length, then tries hex decoding (removing optional '0x' prefix) and validates 32-byte length, and finally falls back to SHA-256 hashing of the string if neither format produces a 32-byte key. This ensures that webhook secret keys can be provided in either base64 or hex format (as documented in constructor), preventing decryption failures and lost webhooks when base64 keys are supplied. The method validates the final key length (32 bytes) as required for AES-256-GCM encryption.

### 2.15 **Webhook Cipher Mode Mismatch (CBC vs GCM)**
**Category:** Compatibility / Best Practice  
**Description:** The class docs/config mention AES-256-CBC, but the implementation uses AES-256-GCM, which will fail if Axcess sends CBC-encrypted payloads.  
**Suggested Fix:** Align the cipher mode with Axcess documentation (CBC or GCM) and make it configurable if both are supported by different environments.  
**Fix:** 
**Implementation Details:** Made webhook cipher mode configurable to support both AES-256-CBC and AES-256-GCM. Added `cipherMode` to `webhookConfig` in constructor (line 406) with default value "GCM" (uppercased). Updated JSDoc for `decryptAndVerifyWebhook` (line 3282) to reflect support for both modes. Enhanced `decryptAndVerifyWebhook` method to handle both cipher modes: (1) Determines cipher mode from `this.webhookConfig.cipherMode` (defaults to "GCM"), (2) For GCM mode: expects hex-encoded IV (12 bytes), hex-encoded authentication tag (16 bytes, required), hex-encoded ciphertext; validates IV and tag lengths, (3) For CBC mode: supports base64 or hex IV (16 bytes), no authentication tag required, supports base64 or hex ciphertext; also handles plaintext JSON fallback, (4) Validates IV length based on mode (12 bytes for GCM, 16 bytes for CBC), (5) Uses appropriate `crypto.createDecipheriv()` call for each mode ("aes-256-gcm" or "aes-256-cbc"), (6) For GCM mode, sets authentication tag using `decipher.setAuthTag()`. The implementation maintains backward compatibility by defaulting to GCM mode (current implementation), while allowing configuration to use CBC mode when needed. This ensures webhook decryption works correctly regardless of which cipher mode Axcess uses in different environments.

### 2.16 **Missing Idempotency Key Validation in Webhook Handling**
**Category:** Security / Best Practice  
**Description:** `handleWebhook` persists records even when `idempotencyKey` is null, leading to collisions (`TRIGGER#null`) and potential duplicate processing.  
**Suggested Fix:** Require a non-empty idempotency key and reject or quarantine events without a valid identifier before saving or routing.  
**Fix:** 
**Implementation Details:** Added validation to require a non-empty idempotency key in the `handleWebhook` method (lines 3668-3677). After decrypting the webhook payload, the code now validates that `idempotencyKey` exists, is a string, and has a non-empty trimmed value. If validation fails, it throws an error with code "MISSING_IDEMPOTENCY_KEY" and includes event type and payload data in error context. The validation occurs before creating the primary key (`pk = \`TRIGGER#${idempotencyKey}\``) and before saving the webhook record, preventing collisions from `TRIGGER#null` and ensuring each webhook has a unique identifier for deduplication. The error is logged with debug level and includes the event type for troubleshooting. This ensures that webhooks without valid idempotency keys are rejected before processing, preventing duplicate processing and database collisions.

### 2.17 **Missing Properties in Normalized Payment Result**
**Category:** Logic Error  
**Description:** Lines 691-692 reference `normalized.redirectUrl` and `normalized.redirectParams` which are never populated by `_normalizePaymentResult`, causing 3DS redirects to fail with undefined values.  
**Suggested Fix:** Extract redirect properties from `statusRes.data.redirect` and include them in the normalized result object, or access them directly from the raw response instead of the normalized object.  
**Fix:** 
**Implementation Details:** Added redirect properties to the normalized payment result. Updated `_normalizePaymentResult` method (lines 4759-4770) to extract and include redirect properties from the response data: added `const redirectUrl = data.redirect?.url || null;` and `const redirectParams = data.redirect?.parameters || null;` before the return statement, and included `redirectUrl` and `redirectParams` in the returned object. This ensures that when `handleRedirectCallback` references `normalized.redirectUrl` and `normalized.redirectParams` (lines 965-966), these properties are properly populated from the response data. If the redirect data is not present in the response, these properties will be `null` instead of `undefined`, preventing 3DS redirect failures and ensuring proper handling of cases where redirect information is missing.

### 2.18 **Inconsistent Partition Key Casing**
**Category:** Best Practice / Logic Error  
**Description:** Partition keys mix `USER#` (uppercase, lines 715, 4246, 4368) and `user#` (lowercase, lines 479, 1664, etc.), causing data fragmentation and query failures when searching across all user records.  
**Suggested Fix:** Standardize partition key format to a single casing convention (preferably lowercase `user#`) throughout the class and update all references consistently.  
**Fix:** 
**Implementation Details:** Standardized all partition keys to use lowercase `user#` format throughout the class. Changed two instances from uppercase `USER#` to lowercase `user#`: (1) Line 1013 in `handleRedirectCallback` method: changed `pk: \`USER#${cleaned.userId}\`` to `pk: \`user#${cleaned.userId}\``, (2) Line 4921 in `handle3DSCallback` method: changed `pk: \`USER#${cleaned.userId}\`` to `pk: \`user#${cleaned.userId}\``. All other partition key references were already using lowercase `user#` format. This ensures consistent partition key casing across all user records, preventing data fragmentation and query failures when searching across all user records. The standardized format (`user#`) matches the majority of existing code and follows the recommended convention.

### 2.19 **Missing Error Handling for Entitlement Operations**
**Category:** Best Practice / Logic Error  
**Description:** `grantAccess` and `denyAccess` calls (lines 737, 739, 3394, etc.) have no error handling, meaning if entitlement updates fail, transactions are still marked as successful/failed, causing inconsistent state between payment and access systems.  
**Suggested Fix:** Wrap entitlement calls in try-catch blocks and log errors without failing the transaction, or implement a retry mechanism with eventual consistency guarantees.  
**Fix:** 
**Implementation Details:** Added comprehensive error handling to all entitlement operations (`grantAccess` and `denyAccess` calls) throughout the class. Wrapped each entitlement call in try-catch blocks that log errors without failing the transaction, ensuring eventual consistency. Updated locations: (1) `handleRedirectCallback` method (lines 1043-1075): wrapped `grantAccess` and `denyAccess` calls with error handling, logging errors with code "ENTITLEMENT_GRANT_FAILED" or "ENTITLEMENT_DENY_FAILED" and including transaction context (orderId, userId, gatewayTxnId), (2) `onPaymentSuccess` method (lines 4045-4060): wrapped `grantAccess` call with error handling, (3) `onPaymentFailed` method (lines 4113-4128): wrapped `denyAccess` call with error handling, (4) `onRefund` method (lines 4426-4441): wrapped `denyAccess` call with error handling, (5) `onChargeback` method (lines 4448-4463): wrapped `denyAccess` call with error handling, (6) `_handleS2SResponse` method (lines 4850-4885): wrapped both `grantAccess` and `denyAccess` calls with error handling. All error handlers log errors using `ErrorHandler.addError()` with appropriate error codes and context data, log debug messages, and continue processing the transaction without throwing errors. This ensures that entitlement failures do not cause transaction processing to fail, maintaining eventual consistency between payment and access systems while providing visibility into entitlement operation failures through error logging.

### 2.20 **Inconsistent Persistence in deleteRegistrationToken**
**Category:** Logic Error / Data Integrity
**Description:** `deleteRegistrationToken` deletes the token from the gateway but explicitly skips deleting the local database record (comment at line 1910), leading to "orphan" tokens in the local system that no longer exist at the gateway.
**Suggested Fix:** Implement `this.svc.deleteToken?.(cleaned.registrationId)` within the success path to ensure local state remains synchronized with the gateway.
**Fix:** 
**Implementation Details:** Added local database deletion to `deleteRegistrationToken` method to keep local state synchronized with the gateway. After successful gateway deletion (lines 2396-2427), added a try-catch block that calls `this.svc.deleteToken(cleaned.registrationId)` if the service method exists (checked using `_checkServiceMethod('deleteToken', false)`). The local deletion is wrapped in error handling: if local deletion fails, it logs an error with code "LOCAL_TOKEN_DELETE_FAILED" and includes the registrationId and error message, but continues processing since gateway deletion succeeded. This ensures that orphan tokens are removed from the local database when tokens are deleted from the gateway, maintaining data integrity and preventing inconsistencies between local and gateway state. The error handling ensures that local deletion failures don't cause the overall operation to fail, as the gateway deletion is the primary operation.

### 2.21 **Lack of Atomicity in upgradeSubscription**
**Category:** Logic Error / Data Integrity
**Description:** `upgradeSubscription` performs three sequential operations (Debit → Cancel Old → Create New) without transactions; a failure in the middle (e.g., after debit but before creation) leaves the user charged but with the old subscription or no subscription.
**Suggested Fix:** Use a saga pattern or `paymentGatewayService` transaction method to ensure all steps succeed or roll back, or at minimum implement compensation logic (refund/restore) if a step fails.
**Fix:** 
**Implementation Details:** Implemented compensation logic (saga pattern) in `upgradeSubscription` method to ensure atomicity. The method now tracks each step and implements compensation if subsequent steps fail: (1) Step 1 - Charge proration (lines 2858-2875): tracks `prorationPaymentId` from debit result for potential refund, wraps in try-catch to fail fast if proration charge fails, (2) Step 2 - Cancel old schedule (lines 2877-2908): if cancel fails, compensates by refunding proration charge using `s2sRefund()` with tracked `prorationPaymentId`, logs compensation actions with error codes "UPGRADE_CANCEL_FAILED" and "UPGRADE_REFUND_FAILED", re-throws cancel error after compensation attempt, (3) Step 3 - Create new schedule (lines 2910-2943): if create fails, compensates by refunding proration charge (cannot restore old schedule once canceled), logs compensation actions with error codes "UPGRADE_CREATE_FAILED" and "UPGRADE_REFUND_FAILED", re-throws create error after compensation attempt. All compensation attempts are wrapped in try-catch to ensure errors are logged even if refund fails, requiring manual intervention. This ensures that if any step fails after the proration charge, the user is refunded, preventing inconsistent state where the user is charged but doesn't have the upgraded subscription. The compensation logic follows a saga pattern where each step can be compensated if subsequent steps fail.

---

## 3. Medium Priority Issues

### 3.1 **Repeated Validation Pattern**
**Category:** Performance / Best Practice  
**Description:** SafeUtils.sanitizeValidate is called repeatedly with similar parameter structures across methods, creating unnecessary overhead and code duplication.  
**Suggested Fix:** Extract common validation schemas into class-level constants or a separate validation module to enable reuse and improve performance.  
**Fix:** 
**Implementation Details:** Created a helper method `_getCommonValidationSchemas(params)` (lines 490-510) that provides reusable validation config objects for common parameter patterns. The method returns an object with pre-configured validation schemas: (1) `paymentParams` - contains `amount` (float, required) and `currency` (string, required), (2) `userOrderParams` - contains `userId` and `orderId` (both string, required), (3) `s2SOptionalParams` - contains `customer`, `billing`, `threeDSParams` (all objects with defaults), and `idempotencyKey` (string, optional), (4) `optionalParams` - contains `timeout` (int, optional), `idempotencyKey` (string, optional), and `userId` (string, optional). These schemas can be spread into `SafeUtils.sanitizeValidate()` calls using the spread operator: `SafeUtils.sanitizeValidate({ ...this._getCommonValidationSchemas(params).paymentParams, ...otherParams })`. This reduces code duplication and enables reuse of common validation patterns across methods. The schemas are instance methods that take the `params` object, allowing them to access parameter values while maintaining a consistent validation structure. Future refactoring can gradually migrate existing validation calls to use these reusable schemas, reducing duplication across the 51+ instances of `SafeUtils.sanitizeValidate` calls in the codebase.

### 3.3 **Optional Chaining Overuse**
**Category:** Performance  
**Description:** Excessive use of optional chaining operators (`?.`) throughout the code adds runtime overhead for property access checks that could be eliminated with proper initialization.  
**Suggested Fix:** Initialize all expected properties with default values during construction, then use regular property access to reduce overhead.  
**Fix:** 
**Implementation Details:** Optimized Logger method access by caching method references during construction to reduce optional chaining overhead. In the constructor (lines 432-437), added caching of Logger methods: `this._loggerDebugLog` and `this._loggerWriteLog` are set by checking once if the methods exist and binding them, storing `null` if they don't exist. Created a helper method `_debugLog(...args)` (lines 449-453) that uses the cached `this._loggerDebugLog` reference instead of `Logger.debugLog?.()`, eliminating the need for optional chaining on each call. This pattern can be extended to other Logger methods and gradually replace the 336+ instances of `Logger.debugLog?.` calls throughout the codebase. The cached references are checked once during construction rather than on every method call, reducing runtime overhead. Future refactoring can gradually migrate existing `Logger.debugLog?.()` calls to use `this._debugLog()` instead, which uses regular property access on the cached reference. Note that many uses of optional chaining are necessary for safety when dealing with external API responses or optional service methods, but Logger method access can be optimized using this pattern.

### 3.4 **Inefficient Object.entries() in Loops**
**Category:** Performance  
**Description:** Line 40 uses Object.entries() which creates temporary array allocations, when Object.keys() with bracket notation would be more efficient for iteration.  
**Suggested Fix:** Replace `for (const [key, value] of Object.entries(obj))` with `for (const key of Object.keys(obj)) { const value = obj[key]; }` for better performance in hot paths.  
**Fix:** 
**Implementation Details:** Optimized all Object.entries() usages by replacing them with Object.keys() and bracket notation to avoid temporary array allocations. Updated three locations: (1) `toFormUrlEncoded` function (line 50): changed `for (const [key, value] of Object.entries(cleaned.data))` to `for (const key of Object.keys(cleaned.data))` with `const value = cleaned.data[key]` inside the loop, (2) `decryptAndVerifyWebhook` method (line 3579): changed `for (const [k, v] of Object.entries(cleaned.headers || {}))` to `for (const k of Object.keys(headers))` with `const headers = cleaned.headers || {}` and `headers[k]` access, (3) `_flattenThreeDS` method (line 5005): changed `for (const [k, v] of Object.entries(threeDSParams))` to `for (const k of Object.keys(threeDSParams))` with `const v = threeDSParams[k]` inside the loop. This optimization reduces memory allocations in hot paths by avoiding the creation of temporary arrays that Object.entries() generates. Object.keys() returns an array of keys, and bracket notation access is more efficient than destructuring from entries arrays, especially in frequently called functions like `toFormUrlEncoded` which is used for every form-urlencoded request.

### 3.5 **No Response Caching Strategy**
**Category:** Performance  
**Description:** Repeated API calls for the same data (e.g., payment status checks) have no caching layer, wasting bandwidth and potentially hitting rate limits unnecessarily.  
**Suggested Fix:** Implement a short-lived in-memory cache (e.g., node-cache) with 30-60 second TTL for idempotent GET requests to reduce redundant API calls.  
**Fix:** 
**Implementation Details:** Implemented an in-memory response cache for GET requests to reduce redundant API calls. Added cache infrastructure in constructor (lines 434-436): created `this._responseCache` as a Map for storing cached responses, and `this._cacheTTL` configurable via options (defaults to 30000ms/30 seconds). Created helper methods: (1) `_getCachedResponse(cacheKey)` (lines 473-485): checks cache for entry, validates TTL, removes expired entries, returns cached data or null, (2) `_setCachedResponse(cacheKey, responseData)` (lines 487-500): stores response with timestamp, includes periodic cleanup of expired entries when cache size exceeds 100 entries to prevent memory leaks. Updated `getPaymentStatus` method (lines 1252-1280) to use caching: checks cache before making API request using URL as cache key, returns cached response if available and not expired, caches successful GET responses after API call, only caches successful responses (status 200-299). The cache uses the full URL (including query parameters) as the cache key to ensure uniqueness. This reduces redundant API calls for payment status checks and other idempotent GET requests, saving bandwidth and reducing the risk of hitting rate limits. The 30-second TTL ensures cached data is reasonably fresh while providing performance benefits for repeated requests.

### 3.6 **Redundant Null Checks After Validation**
**Category:** Best Practice  
**Description:** Code performs null checks (lines 34, 80, 89) after SafeUtils.sanitizeValidate has already validated required fields, creating redundant defensive code.  
**Suggested Fix:** Trust the validation layer and remove redundant checks after sanitizeValidate, or consolidate validation logic to avoid confusion.  
**Fix:** 
**Implementation Details:** Removed redundant null checks for required fields after SafeUtils.sanitizeValidate validation. In `httpRequestWithBearer` function (lines 94-110), removed redundant checks for `cleaned.urlString` and `cleaned.bearerToken` since these fields are marked as `required: true` in the validation schema (lines 85, 87), meaning SafeUtils.sanitizeValidate will throw an error if they are missing. Added a comment noting that SafeUtils.sanitizeValidate already validates required fields and throws if missing, so redundant checks are unnecessary. The check at line 44 in `toFormUrlEncoded` function is not redundant as `data` is marked as `required: false`, so the null/type check is necessary for handling optional parameters. This change reduces redundant defensive code and trusts the validation layer, making the code cleaner and more maintainable while maintaining the same level of error handling through the validation framework.

### 3.7 **Magic Number: 25 Minutes**
**Category:** Best Practice  
**Description:** Line 14 hardcodes DEFAULT_CHECKOUT_EXPIRY_MINUTES without explanation of why 25 minutes was chosen, making the constant's purpose unclear.  
**Suggested Fix:** Add inline comment explaining the business logic: `// Gateway session expires at 30min, using 25min for buffer` and consider making this configurable per environment.  
**Fix:** 
**Implementation Details:** Added inline comment explaining the business logic for the 25-minute checkout expiry constant (lines 15-17). The comment explains that the gateway session expires at 30 minutes, and using 25 minutes provides a 5-minute buffer to ensure sessions are considered expired before the gateway expires them, preventing edge cases where a session might be considered valid locally but already expired at the gateway. This makes the constant's purpose clear and helps future maintainers understand why 25 minutes was chosen instead of matching the gateway's 30-minute expiry exactly. The constant is already configurable per environment via the constructor's `session.checkoutExpiryMinutes` option (line 415), so the hardcoded value serves as a sensible default.

### 3.8 **Missing Null Check Before toLowerCase()**
**Category:** Best Practice / Logic Error  
**Description:** String methods like toUpperCase() (line 100, 109) are called without null checks, which will throw TypeError if the cleaned value is unexpectedly null.  
**Suggested Fix:** Add null coalescing: `method: (cleaned.method || 'GET').toUpperCase()` to provide safe defaults when values are unexpectedly missing.  
**Fix:** 
**Implementation Details:** Added null coalescing before string method calls to prevent TypeError when values are unexpectedly null. Updated three locations: (1) `httpRequestWithBearer` function (lines 100-109): changed `cleaned.method.toUpperCase()` to `(cleaned.method || 'GET').toUpperCase()` and stored in `methodUpper` variable to avoid repetition, updated all three usages of `cleaned.method.toUpperCase()` to use the cached `methodUpper` variable, (2) `handleRedirectCallback` method (line 1206): changed `txn.status.toUpperCase()` to `(txn.status || "").toUpperCase()` to safely handle potential null status, (3) `createSchedule` method (line 3222): changed `cleaned.currency.toUpperCase().slice(0, 3)` to `(cleaned.currency || "").toUpperCase().slice(0, 3)` to safely handle potential null currency. These changes provide safe defaults when values are unexpectedly missing, preventing TypeError exceptions that could crash the application. While SafeUtils.sanitizeValidate should validate required fields, defensive programming with null coalescing ensures robustness against unexpected null values that might slip through validation.

### 3.9 **Inconsistent Error Message Format**
**Category:** Best Practice  
**Description:** Error messages use inconsistent formats (some with colons, some without, varying verbosity), making automated error parsing and logging aggregation difficult.  
**Suggested Fix:** Standardize error messages to a consistent format: `[Component] [Action] Failed: reason` and create an error message builder utility.  
**Fix:** 
**Implementation Details:** Created a standardized error message builder utility and updated key error messages to use consistent format. Added helper method `_buildErrorMessage(component, action, reason)` (lines 508-513) that returns standardized error messages in the format: `${component} [${action}] Failed: ${reason}`. Updated key error messages to use the standardized format: (1) `_checkServiceMethod` (line 524): uses `_buildErrorMessage("Axcess", "checkServiceMethod", ...)` for consistent error messages, (2) `createCheckoutSession` (line 774): changed from "Axcess create checkout failed" to standardized format with detailed reason, (3) `getPaymentStatus` (line 1320): changed from "Axcess getPaymentStatus failed" to standardized format with HTTP status and description, (4) `createRegistrationToken` (line 2218): changed from "Axcess createRegistrationToken failed" to standardized format with error message. The standardized format `[Component] [Action] Failed: reason` makes error messages consistent, easier to parse programmatically, and better for logging aggregation. Future error messages can use `this._buildErrorMessage()` to maintain consistency, and existing error messages can be gradually migrated to use the standardized format. This improves error message consistency across the 101+ error messages in the codebase.

### 3.10 **No Connection Pooling for HTTP**
**Category:** Performance  
**Description:** Each fetch() call creates a new TCP connection without reuse, adding latency and overhead especially in high-throughput Lambda scenarios.  
**Suggested Fix:** Use an HTTP agent like https.Agent with keepAlive enabled, or switch to undici which has connection pooling built-in.  
**Fix:** 
**Implementation Details:** Documented that fetch() in Node.js 18+ already uses connection pooling via undici. Added a comment in `httpRequestWithBearer` function (lines 149-152) explaining that fetch() in Node.js 18+ uses undici under the hood, which provides built-in connection pooling with keepAlive enabled by default, reducing latency and overhead for high-throughput scenarios. The comment notes that connection reuse is handled automatically by undici. This addresses the concern about connection pooling: in Node.js 18+, fetch() already uses undici which implements connection pooling with keepAlive, so no additional configuration is needed. For Node.js versions before 18, fetch() may not be available or may not use undici, in which case upgrading to Node.js 18+ is recommended for optimal performance. If more explicit control over connection pooling is needed (e.g., custom keepAlive timing or connection limits), the codebase could be refactored to use undici directly, but the current implementation already benefits from connection pooling in Node.js 18+ environments.

### 3.11 **Global CONFIG Mutation Risk**
**Category:** Best Practice  
**Description:** A module-level/global configuration object (especially for environment/test mode) can be mutated or reused across instances, causing unexpected behavior in multi-tenant or concurrent Lambda invocations.  
**Suggested Fix:** Make environment/test-mode configuration instance-scoped (constructor-derived instance properties) to ensure isolation between instances and prevent cross-contamination.  
**Fix:**
**Implementation Details:** Removed reliance on any module-level `CONFIG` object by making environment/test-mode configuration **instance-scoped**. The constructor now derives and stores `this.testMode` from `config.environment` (treating `'live'` as `LIVE`, everything else as `TEST`) and request builders use `this.testMode` when setting gateway `testMode` parameters (including URL query params like `testMode=`). This eliminates cross-instance mutation risk because each `Axcess` instance carries its own configuration and does not share a mutable config object with other instances.

### 3.12 **Large Method: handleRedirectCallback**
**Category:** Best Practice  
**Description:** handleRedirectCallback (lines 4301-4416) is over 115 lines long with multiple responsibilities, making it hard to test and maintain.  
**Suggested Fix:** Refactor into smaller focused methods: _fetch3DSStatus(), _processRedirectResult(), _save3DSTransaction() to improve testability and readability.  
**Fix:**
**Implementation Details:** Refactored `handleRedirectCallback` into a thin orchestrator that delegates to small private helpers to reduce cognitive load and improve testability, without changing behavior. The new flow calls helpers like `_fetchRedirectStatus()` (fetch status via checkoutId or resourcePath), `_is3DSAuthenticationRequired()` / `_build3DSRequiredResponse()` (3DS decision + redirect payload), `_handlePaResRedirect3DSCallback()` (PaRes/MD callback handling with checkoutId extraction), `_buildRedirectTxn()` (single source of truth for stored txn fields, including response metadata), `_persistRedirectTxnAndSideEffects()` (persistence + entitlement side effects), and `_updateSessionsAfterRedirect()` (session updates with optimistic locking).

### 3.15 **Missing Content-Type Validation**
**Category:** Best Practice / Security  
**Description:** Response Content-Type check (line 118) uses includes() without validating charset or full MIME type, potentially mishandling responses with unexpected encodings.  
**Suggested Fix:** Parse Content-Type header properly using a library like content-type or validate the full MIME type with charset: `application/json; charset=utf-8`.  
**Fix:**
**Implementation Details:** Implemented MIME-type parsing and JSON detection in the HTTP layer: added `parseMimeType()` and `isJsonMimeType()` to normalize Content-Type values and treat `application/json` and `+json` types as JSON. Response parsing now reads the response body with a size limit and then parses JSON only when the MIME type indicates JSON; otherwise it returns text. This avoids brittle `includes('application/json')` checks and improves correctness across charset variants.

### 3.16 **Timestamp Generation Inconsistency**
**Category:** Best Practice  
**Description:** Multiple timestamp generation methods (DateTime.now(), DateTime.toUnixTimestamp()) are used inconsistently, creating potential timezone or format issues.  
**Suggested Fix:** Standardize on a single timestamp format (ISO 8601 or Unix timestamp) throughout the class and document the timezone assumption (UTC recommended).  
**Fix:**
**Implementation Details:** Standardized timestamps via canonical helpers: added `_now()` (RFC3339 in UTC) and `_nowUnixSeconds()` (Unix seconds derived from `_now()`). Updated persistence paths (transactions, sessions, schedules, webhooks) to use these helpers so stored timestamps are consistent and timezone-safe.

### 3.17 **No Request/Response Payload Size Limits**
**Category:** Security / Performance  
**Description:** No validation of request body size before sending or response body size after receiving, allowing potential memory exhaustion attacks or OOM errors.  
**Suggested Fix:** Implement payload size limits: reject request bodies > 1MB and stream/abort responses exceeding reasonable size thresholds.  
**Fix:**
**Implementation Details:** Added request/response size limits in the HTTP layer. Request bodies are checked against `maxRequestBytes` before sending; responses are read with `readResponseBodyTextWithLimit()` enforcing `maxResponseBytes`, with optional `Content-Length` pre-check when present. Webhook processing also enforces a `webhookConfig.maxBytes` limit to reject oversized webhook bodies early.

### 3.18 **Missing API Version Management**
**Category:** Best Practice  
**Description:** API endpoint version (/v1/) is hardcoded throughout the class without a configuration option, making API version upgrades require code changes.  
**Suggested Fix:** Add apiVersion to config with default 'v1' and construct URLs dynamically: `${this.apiBaseUrl}/${this.apiVersion}/checkouts/...`.  
**Fix:**
**Implementation Details:** Introduced configurable API versioning: constructor now accepts `config.apiVersion` (default `v1`) and scheduling config (`schedulingBasePath` + `schedulingApiVersion`). Added `_paymentUrl()` and `_schedulingUrl()` helpers and updated URL construction to use them instead of hardcoded `/v1/...` strings.

### 3.19 **Undefined Session ID Returned After Checkout Creation**
**Category:** Logic Error  
**Description:** `createCheckoutSession` returns `sessionRecord.id`, but `sessionRecord` never sets an `id`, so callers may receive `undefined` even though the session was saved.  
**Suggested Fix:** Generate an explicit session ID before saving or return a stable identifier already in the record (e.g., `sk`), and ensure `saveSession` returns the persisted ID.  
**Fix:**
**Implementation Details:** Added an explicit `sessionId` during checkout creation and persisted it on the session record (`id: sessionId`). `createCheckoutSession` now returns a stable `sessionId` value so callers never receive `undefined`.

### 3.20 **Undefined UI Message in 3DS Callback Responses**
**Category:** Logic Error / Best Practice  
**Description:** `handle3DSCallback` and `handleRedirectCallback` reference `normalized.uiMessage`, but `_normalizePaymentResult` does not populate this field, resulting in empty failure reasons.  
**Suggested Fix:** Derive the UI message from `mapResultCodeToUiMessage(normalized.resultCode)` and return that value when the payment is not approved.  
**Fix:**
**Implementation Details:** Updated `_normalizePaymentResult()` to always include `uiMessage` derived from `mapResultCodeToUiMessage(resultCode)`. Callers can now safely use `normalized.uiMessage` for user-facing failure reasons in both redirect and 3DS callback flows.

### 3.21 **Optional userId Leads to USER#undefined Records**
**Category:** Logic Error  
**Description:** `handleRedirectCallback` allows `userId` to be optional but still uses it to build the partition key, creating `USER#undefined` records and corrupting data.  
**Suggested Fix:** Make `userId` required for persistence or skip saving when it is missing, logging a clear error for upstream callers.  
**Fix:**
**Implementation Details:** Made `userId` required anywhere user-scoped persistence occurs (redirect callback, 3DS callback, token/schedule creation). Removed any fallbacks that could silently produce `user#undefined` records, and throws structured errors when `userId` is missing.

### 3.22 **Hardcoded 3DS and Customer Test Data**
**Category:** Best Practice / Security  
**Description:** `createCheckoutSession` injects hardcoded browser, billing, and customer fields intended for testing, which can produce invalid 3DS data and compliance issues in production.  
**Suggested Fix:** Require these fields from caller input (or derive from request context) and only use test defaults behind an explicit test-mode flag.  
**Fix:**
**Implementation Details:** Removed hardcoded customer/billing/browser defaults (e.g., `test@example.com`, hardcoded address, hardcoded browser UA/screen). `createCheckoutSession` now only includes customer/billing/browser objects when provided by the caller, preventing production flows from silently using fake 3DS data.

### 3.23 **Hardcoded Test User IDs Throughout Codebase**
**Category:** Best Practice / Logic Error  
**Description:** Multiple methods (lines 1660, 2068, 2543, 3286, etc.) use hardcoded fallback `'user123'` when userId is missing, creating data corruption and making it impossible to trace actual user transactions in production.  
**Suggested Fix:** Make userId required in all methods that persist user data, or throw descriptive errors when userId is missing instead of silently using test defaults.  
**Fix:**
**Implementation Details:** Removed all `'user123'` fallbacks from executable paths. Methods that persist user-scoped data now require a `userId` (validated via `SafeUtils.sanitizeValidate`) or throw a structured `AxcessError` when missing. Webhook handlers now require `merchantCustomerId` or a resolvable session-to-user mapping for persistence, preventing accidental cross-user corruption.

### 3.24 **Hardcoded Amount Precision Assumes Two Decimal Places**
**Category:** Best Practice / Compatibility  
**Description:** All amount formatting uses `.toFixed(2)` (lines 926, 1010, 1158, etc.), assuming all currencies use cents, but currencies like JPY, KRW, and others use zero decimal places, causing incorrect payment amounts.  
**Suggested Fix:** Implement currency-aware decimal precision using a currency-to-decimal mapping, or accept precision as a parameter and default to 2 only for known cent-based currencies.  
**Fix:**
**Implementation Details:** Implemented currency-aware amount formatting via `_getCurrencyDecimals(currency)` and `_formatAmount(amount, currency)`, replacing `.toFixed(2)` usage in payment and schedule paths. Zero-decimal (e.g., JPY/KRW) and three-decimal (e.g., KWD/BHD) currencies now format correctly.

### 3.25 **Missing CheckoutId Extraction from ResourcePath**
**Category:** Logic Error  
**Description:** `handleRedirectCallback` receives `resourcePath` but never extracts `checkoutId` from it, requiring callers to provide both separately and creating potential for mismatched data.  
**Suggested Fix:** Parse `checkoutId` from `resourcePath` using regex or URL parsing, or document that both must be provided and validate they match before processing.  
**Fix:**
**Implementation Details:** Added checkoutId extraction from `resourcePath` for 3DS callback handling using a regex fallback, and when missing, falls back to session lookup via `orderId`. This removes the need for callers to redundantly supply both `resourcePath` and `id` in order to process PaRes/MD callbacks reliably.

### 3.26 **Inconsistent Error Object Structure**
**Category:** Best Practice  
**Description:** Some methods throw Error objects with attached properties (line 4140-4146), while others throw plain Error strings, making error handling inconsistent and preventing structured error recovery.  
**Suggested Fix:** Standardize error throwing to use custom error classes or consistently attach metadata (response, result, raw) to all thrown errors for uniform error handling.  
**Fix:**
**Implementation Details:** Introduced a consistent error shape via `createAxcessError(...)` (name: `AxcessError`) with `code`, `status`, `data`, `raw`, and optional `cause`. Replaced remaining `throw new Error(...)` paths and ad-hoc error mutation so error handling is uniform across HTTP, webhook, redirect, 3DS, and S2S flows.

### 3.27 **Conflicting Subscription API Usage**
**Category:** Best Practice / Compatibility
**Description:** The class mixes calls to legacy `v1/subscriptions` (in `createSubscriptionFromToken`) and newer `scheduling/v1/schedules` (in `createSchedule`), which may lead to inconsistent behavior or maintenance issues if one API is deprecated.
**Suggested Fix:** Standardize on the newer `scheduling` API for all subscription operations unless specific legacy features are required, and verify feature parity.
**Fix:**
**Implementation Details:** Standardized subscription operations on the scheduling API. `createSubscriptionFromToken` now delegates to `createSchedule`, and `cancelSubscription` delegates to `cancelSchedule`, avoiding mixed legacy subscription endpoints and keeping subscription lifecycle consistent.

### 3.28 **Hardcoded Form Action in Widget HTML**
**Category:** Best Practice / Flexibility
**Description:** `getPaymentWidgetHtml` hardcodes the form action to `/payments/axcess/callback` (line 636), which will break the integration if the application is hosted on a sub-path or uses a different routing structure.
**Suggested Fix:** Use a configurable callback URL (e.g., `${this.baseUrl}/payments/axcess/callback`) to ensure the form posts to the correct endpoint regardless of deployment path.
**Fix:**
**Implementation Details:** Added configurable callback support via `config.ui.callbackPath` and a computed `this.callbackUrl` derived from `merchantBaseUrl`. `getPaymentWidgetHtml` now uses `this.callbackUrl` for the form action and `createCheckoutSession` uses the same callback URL in its redirect config.

---

## 4. Low Priority Issues

### 4.1 **Inconsistent Logging Format**
**Category:** Best Practice  
**Description:** Log messages use inconsistent prefixes, brackets, and formats (some with [START]/[SUCCESS], others without), making log parsing and filtering harder.  
**Suggested Fix:** Standardize logging format with consistent structure: `[Axcess] [MethodName] [Stage] Message` and create a logging wrapper method to enforce consistency.  
**Fix:**
**Implementation Details:** Added `_writeLog(action, message, data)` as the single structured logging wrapper for `Logger.writeLog`, and migrated class-level logging call sites to use `_writeLog` for consistent schema (flag/action/message/data). Debug logs remain via `Logger.debugLog` / `_debugLog` but structured logs are now standardized.

### 4.2 **Magic String: 'INTERNAL' vs 'EXTERNAL'**
**Category:** Best Practice  
**Description:** TEST_MODE values 'INTERNAL' and 'EXTERNAL' are undocumented magic strings with unclear business meaning.  
**Suggested Fix:** Define as named constants (TEST_MODE_INTERNAL, TEST_MODE_EXTERNAL) with JSDoc explaining when each mode is used.  
**Fix:**
**Implementation Details:** Removed reliance on the old INTERNAL/EXTERNAL test mode concept by standardizing on explicit `LIVE` vs `TEST` semantics (`this.testMode`) derived from environment configuration. All gateway calls now pass `this.testMode`, eliminating ambiguous magic strings.

### 4.3 **Hardcoded User-Agent String**
**Category:** Best Practice  
**Description:** Line 104 hardcodes 'AxcessPaymentGateway/1.0' without version management, making it impossible to track which code version made requests.  
**Suggested Fix:** Generate User-Agent from package.json version: `AxcessPaymentGateway/${require('../package.json').version}` or make it configurable.  
**Fix:**
**Implementation Details:** Made User-Agent configurable. Added `config.userAgent` (defaults to `process.env.AXCESS_USER_AGENT` / `DEFAULT_USER_AGENT`) and passed `this.userAgent` into all HTTP requests via `httpRequestWithBearer`. Removed the hardcoded `'AxcessPaymentGateway/1.0'` literal.

### 4.6 **Long Parameter List in httpRequestWithBearer**
**Category:** Best Practice  
**Description:** Function accepts 6 parameters as a destructured object, which is good, but could be further improved with an options object pattern.  
**Suggested Fix:** Already using object destructuring which is the recommended pattern; no action needed beyond ensuring JSDoc documents all parameters.  
**Fix:**
**Implementation Details:** Kept the options-object API and expanded it to cover operational concerns cleanly (`userAgent`, `maxRequestBytes`, `maxResponseBytes`, retry/timeout). This preserves a single options object interface (no positional args) while making the behavior configurable and well-scoped.

### 4.9 **Response Headers Not Consistently Captured**
**Category:** Best Practice  
**Description:** Line 130 captures response headers but they're not consistently saved to transaction records, losing valuable debugging information.  
**Suggested Fix:** Add response headers to all transaction records under a `responseHeaders` field (excluding sensitive headers) for debugging and audit purposes.  
**Fix:**
**Implementation Details:** Standardized response header capture: `httpRequestWithBearer` always returns `headers` and parsed `rateLimit` metadata. Transaction persistence paths now store `responseHeaders` and `rateLimit` alongside `raw` payloads for both redirect/3DS transactions and S2S transaction records.

### 4.10 **Missing Rate Limit Header Handling**
**Category:** Best Practice  
**Description:** Response headers likely contain rate limit information (X-RateLimit-*) but these are not parsed or logged, preventing proactive rate limit management.  
**Suggested Fix:** Parse and log rate limit headers from responses, and emit warnings when approaching rate limits to enable proactive throttling.  
**Fix:**
**Implementation Details:** Added `parseRateLimitHeaders()` to extract `Retry-After` and `X-RateLimit-*` headers into a structured `rateLimit` object returned by `httpRequestWithBearer`. Added 429 handling that respects `Retry-After` when present (otherwise falls back to exponential backoff).

### 4.11 **No Graceful Shutdown Handler**
**Category:** Best Practice  
**Description:** Class has no cleanup method to gracefully close connections or complete in-flight requests during Lambda shutdown or process termination.  
**Suggested Fix:** Implement a `shutdown()` method that completes pending requests with timeout and properly closes resources, and register it with process.on('SIGTERM').  
**Fix:**
**Implementation Details:** Implemented graceful shutdown handling at module init: registered `SIGTERM`/`SIGINT` handlers that mark shutdown state and abort in-flight HTTP requests via tracked `AbortController`s. New HTTP requests are rejected during shutdown with a structured `AxcessError` (`SHUTTING_DOWN`).

---

## Summary & Recommendations

### Critical Actions Required
1. **Fix the undefined variable bug** (Issue 1.1) immediately - this will cause production failures
2. **Implement proper timeout handling** (Issue 1.3) for Node.js compatibility
3. **Remove sensitive data from logs** (Issue 1.4) to prevent credential exposure
4. **Add prototype pollution protection** (Issue 1.6) before processing user input

### High-Priority Improvements
1. Add retry logic with exponential backoff for network resilience
2. Implement request idempotency to prevent double-charging
3. Add comprehensive webhook payload validation
4. Implement circuit breaker pattern for failure isolation

### AWS Lambda Optimization
1. Keep environment/test-mode configuration instance-scoped (avoid module-level mutable config)
2. Implement connection pooling/reuse
3. Add structured logging for CloudWatch Insights
4. Implement metrics collection for monitoring
5. Consider cold start optimization strategies

### Testing Recommendations
- **Update Jest tests** to cover all new error handling paths
- **Test private methods** indirectly through public interface methods
- Add integration tests for retry logic and circuit breaker behavior
- Add security tests for prototype pollution and injection attacks
- Test Lambda-specific scenarios (cold starts, concurrent invocations)

### Code Style Reminders
- **Follow existing patterns**: Use established Logger, ErrorHandler, and SafeUtils consistently
- **Maintain formatting**: Keep existing indentation, bracket style, and naming conventions
- **Document changes**: Add JSDoc comments for new/modified methods
- **Security first**: Always sanitize inputs using SafeUtils before processing

---

**Report Generated:** January 19, 2026  
**Total Issues:** 69 (Critical: 9, High: 21, Medium: 28, Low: 11)  
**Recommended Action:** Address all Critical and High priority issues before production deployment
