# Static Analysis Report: Users.js

**Generated:** January 20, 2026  
**Total Issues Found:** 60

---

## 1. Critical Issues

### 1.1 **SQL Injection Vulnerability in Dynamic Query Construction**
**Category:** Security  
**Description:** Lines 532, 591 use unsanitized table and field names in SQL queries via template literals, allowing SQL injection attacks through `getUserField` and `updateUserField` methods.  
**Suggested Fix:** Implement a strict whitelist for table names and column names, validate against the whitelist before query construction, and use a safer query builder pattern or parameterized identifiers.  
**Fix:**

### 1.2 **Race Condition in Upsert Operations**
**Category:** Security, Logic  
**Description:** Lines 1035-1045 and 1110-1119 perform separate SELECT then INSERT/UPDATE operations without transaction isolation, creating a race condition where concurrent requests could fail or cause duplicate key errors.  
**Suggested Fix:** Wrap the check-and-insert logic in a database transaction with appropriate isolation level, or use PostgreSQL's `INSERT ... ON CONFLICT` clause for atomic upsert operations.  
**Fix:**

### 1.3 **Inconsistent Error Return Types**
**Category:** Best Practice, Logic  
**Description:** Methods like `getCriticalUserData` (lines 97-101, 139-143) return error objects with `{status, data, error}` structure while others return `null` or `{success, error}`, causing unpredictable error handling for consumers.  
**Suggested Fix:** Standardize all error responses to a consistent format (e.g., always throw errors or always return `{success, data, error}` objects) throughout the class.  
**Fix:**

### 1.4 **Unhandled Promise Rejection in Batch Operations**
**Category:** Node.js Pitfalls  
**Description:** Lines 185-187 use a for-loop with `await` but if `getCriticalUserData` rejects (instead of returning error object), the entire batch operation fails without proper error handling for individual users.  
**Suggested Fix:** Wrap each user fetch in try-catch or use `Promise.allSettled` to handle individual failures gracefully and continue processing remaining users.  
**Fix:**

### 1.5 **Missing Input Validation for Profile Field Types**
**Category:** Security, Best Practice  
**Description:** Lines 1089-1104 and similar profile update sections accept `backgroundImages`, `socialUrls`, `additionalUrls` without validating they are arrays or sanitizing their contents, risking SQL errors or XSS if improperly formatted.  
**Suggested Fix:** Add explicit validation for array fields (type checking, max length, item validation) and sanitize URL fields to prevent injection attacks before database insertion.  
**Fix:**

### 1.6 **Undefined Variable Reference in createUser**
**Category:** Logic, Node.js Pitfalls  
**Description:** Line 886 references `username` variable which doesn't exist in scope (should be `rawUsername` or `usernameLower`), causing a ReferenceError at runtime when `displayName` is falsy.  
**Suggested Fix:** Replace `displayName || username` with `displayName || rawUsername` or `displayName || usernameLower` to use the correct variable that exists in the method scope.  
**Fix:**

### 1.7 **Incorrect Error Object Handling in buildUserData**
**Category:** Logic  
**Description:** Lines 645-648 call `getCriticalUserData` which can return error objects `{status: false, data: null, error: string}`, but the code checks `if (!cud)` which is truthy for error objects, causing error objects to be treated as valid data and potentially causing runtime errors when accessing properties.  
**Suggested Fix:** Check for error object structure explicitly (`if (!cud || cud.status === false)`) or standardize `getCriticalUserData` to return `null` on error instead of error objects, ensuring consistent error handling.  
**Fix:**

---

## 2. High Priority Issues

### 2.1 **Inefficient N+1 Query Pattern in Batch Operations**
**Category:** Performance  
**Description:** Lines 179-198 fetch critical user data sequentially in a loop instead of using a single batched query, causing O(n) database round trips which severely impacts performance for large user lists.  
**Suggested Fix:** Refactor to use a single SQL query with `WHERE uid IN (...)` or `WHERE uid = ANY($1)` to fetch all users in one database call, then map results in memory.  
**Fix:**

### 2.2 **Multiple Sequential Database Queries in buildUserProfile**
**Category:** Performance  
**Description:** Lines 757-778 make 4 separate database queries (getCriticalUserData, users, user_profiles, user_settings) when building a profile, causing unnecessary latency due to multiple round trips.  
**Suggested Fix:** Replace with a single JOIN query across all tables to fetch required data in one round trip, significantly reducing latency.  
**Fix:**

### 2.3 **Redundant Database Calls in Update Methods**
**Category:** Performance  
**Description:** Methods `updateUserSettings` (line 1015), `updateUserProfile` (line 1083), and `updateUser` (line 1157) all check user existence separately before updating, then call `buildUserProfile` which fetches data again.  
**Suggested Fix:** Remove redundant existence checks (UPDATE will affect 0 rows if user doesn't exist) or fetch required data once and reuse it throughout the method.  
**Fix:**

### 2.4 **Missing Cache for getCriticalUserData**
**Category:** Performance  
**Description:** `getCriticalUserData` is called frequently (lines 107, 186, 645, 758, 1235) but has no caching mechanism, causing repeated database queries for the same user data within short time periods.  
**Suggested Fix:** Implement an in-memory LRU cache (e.g., using `lru-cache` npm package) with short TTL (5-30 seconds) to cache critical user data and reduce database load.  
**Fix:**

### 2.5 **Unbounded Array Input Without Rate Limiting**
**Category:** Security, Performance  
**Description:** Lines 165-172 manually check array length after validation, but `SafeUtils.sanitizeValidate` already validates max:200, creating redundant code and potential inconsistency if limits differ.  
**Suggested Fix:** Remove the redundant manual check and rely solely on the validation framework's max constraint, or add application-level rate limiting for batch operations.  
**Fix:**

### 2.6 **Dangerous `randomBytes` Import Inside Method**
**Category:** Performance, Best Practice  
**Description:** Line 859 dynamically imports `crypto.randomBytes` inside the `createUser` method on every call, adding unnecessary overhead compared to a top-level import.  
**Suggested Fix:** Move `import { randomBytes } from 'crypto'` to the top of the file as a static import to avoid repeated dynamic import overhead.  
**Fix:**

### 2.7 **Incomplete Error Object Returns**
**Category:** Best Practice, Logic  
**Description:** Lines 416, 438, 461, 497 return error objects with `{success: false, error}` structure but methods are expected to return boolean or simple values per JSDoc annotations.  
**Suggested Fix:** Update all methods to consistently throw errors (to be caught by callers) or update JSDoc to document the actual return type including error objects.  
**Fix:**

### 2.8 **Missing Transaction for Multi-Table User Creation**
**Category:** Logic, Security  
**Description:** Lines 876-932 insert into three tables (users, user_profiles, user_settings) sequentially without a transaction, risking partial user creation if any insert fails.  
**Suggested Fix:** Wrap all three INSERT statements in a single database transaction using `BEGIN`, `COMMIT`, `ROLLBACK` to ensure atomicity.  
**Fix:**

### 2.9 **Username Collision Not Properly Handled**
**Category:** Logic  
**Description:** Lines 866-874 check for username existence and throw error, but this check is not atomic with the INSERT at line 892, allowing race conditions where two concurrent requests could pass the check and fail on INSERT.  
**Suggested Fix:** Use database-level UNIQUE constraint on `username_lower` and handle the constraint violation error gracefully, or use a transaction with SELECT FOR UPDATE.  
**Fix:**

### 2.10 **Role Parameter Trust Allows Privilege Escalation**
**Category:** Security  
**Description:** `createUser` (Users.js:837-932) and `updateUser` (Users.js:1141-1203) accept a caller-supplied `role` value and persist it directly to the `users` table, so any user who can invoke these endpoints can create or elevate themselves to privileged roles.  
**Suggested Fix:** Enforce a server-side allowlist or default for role assignments (e.g., always use `'user'` for public sign-up and reject role updates unless the caller is an admin), and validate/override any incoming `role` parameter before persisting.  
**Fix:**

### 2.11 **Missing Username Uniqueness Check in setUsername**
**Category:** Security, Logic  
**Description:** `setUsername` method (lines 451-499) validates format but doesn't check if the username is already taken by another user before updating, allowing username hijacking where one user can claim another user's username.  
**Suggested Fix:** Add a uniqueness check using `isUsernameTaken` or a database query before updating, and handle the case where username is already taken by a different user, ensuring atomicity with the UPDATE operation.  
**Fix:**

### 2.12 **Inconsistent Return Type in getBatchOnlineStatus**
**Category:** Logic, Best Practice  
**Description:** `getBatchOnlineStatus` method (lines 260-286) returns `{success: false, data: [], error: err.message}` on validation error (line 269) but returns a plain array on success (line 277), causing inconsistent return types that break JSDoc contract and make error handling unpredictable.  
**Suggested Fix:** Standardize return type to always return `{success: boolean, data: Array, error?: string}` or always return an array and throw errors, ensuring consistent error handling patterns throughout the method.  
**Fix:**

### 2.13 **Missing Transaction Wrapper in updateUser**
**Category:** Logic, Security  
**Description:** `updateUser` method (lines 1141-1212) calls `updateUserSettings` and `updateUserProfile` sequentially without transaction wrapping, so if one succeeds and the other fails, the user data becomes partially updated and inconsistent across tables.  
**Suggested Fix:** Wrap all update operations (users table, updateUserSettings, updateUserProfile) in a single database transaction to ensure atomicity, rolling back all changes if any operation fails.  
**Fix:**

### 2.14 **Missing Schema Validation for Create/Update Payloads**
**Category:** Security, Logic  
**Description:** `createUser` and `updateUser` destructure and use numerous properties (e.g., `age`, `bio`, `gender`) from the input object without validating their types or formats, which could lead to database errors or data integrity issues.  
**Suggested Fix:** Implement comprehensive schema validation using `SafeUtils` or a library like Joi/Zod for all incoming payload fields before processing.  
**Fix:**

---

## 3. Medium Priority Issues

### 3.3 **Unnecessary Optional Chaining Overhead**
**Category:** Performance  
**Description:** Excessive use of optional chaining (`?.`) throughout the code (lines 89, 106, 116, etc.) when values are guaranteed to exist after validation, adding unnecessary runtime checks.  
**Suggested Fix:** Remove optional chaining for values that are validated/guaranteed to exist, keeping it only for truly optional values like configuration or feature flags.  
**Fix:**

### 3.5 **Hardcoded Magic Values**
**Category:** Best Practice  
**Description:** Values like '60 seconds' (line 315), 200 user limit (lines 157, 265), and default locale 'en' (line 927) are hardcoded instead of being defined as class constants.  
**Suggested Fix:** Extract all magic numbers and strings to class-level constants (e.g., `PRESENCE_UPDATE_THROTTLE`, `MAX_BATCH_SIZE`, `DEFAULT_LOCALE`) for better maintainability.  
**Fix:**

### 3.6 **Inefficient String Concatenation in SQL Building**
**Category:** Performance  
**Description:** Lines 1095-1118 build dynamic SQL using array join which is fine, but the pattern is repeated across multiple methods without a shared utility function.  
**Suggested Fix:** Create a shared utility method `buildDynamicUpdateQuery(tableName, updates, whereClause)` to DRY up the dynamic SQL generation pattern used in multiple update methods.  
**Fix:**

### 3.7 **Missing Validation for Username Format**
**Category:** Logic  
**Description:** `setUsername` method (lines 451-499) validates format after normalization, but the regex at line 17 tests lowercase characters when policy allows uppercase.  
**Suggested Fix:** Update `USERNAME_POLICY.REGEX` to match the normalized (lowercase) username format consistently, or document that validation happens post-normalization.  
**Fix:**

### 3.8 **Potential Memory Leak with Map Usage**
**Category:** Performance  
**Description:** Line 201 creates a Map for order preservation but doesn't clear it after use, and for large batches this could temporarily hold significant memory.  
**Suggested Fix:** While JavaScript GC will handle this, consider using the map inline: `validatedUserIds.map(u => results.find(r => r.uid === u))` for small batches, or explicitly clear for large ones.  
**Fix:**

### 3.9 **Unused Variable in buildUserData**
**Category:** Best Practice  
**Description:** Line 657 contains a commented-out console.log suggesting debugging code left in production, and the pattern repeats throughout suggesting incomplete cleanup.  
**Suggested Fix:** Remove all commented-out console.log statements and debugging code, and establish a linting rule to prevent future occurrences.  
**Fix:**

### 3.10 **Missing Index Hints for Performance**
**Category:** Performance  
**Description:** Queries like line 428, 474, 867 query on `username_lower` which should be indexed, but there's no documentation or code comments about required database indexes.  
**Suggested Fix:** Add comments documenting required database indexes (username_lower, uid, etc.) or include a schema.sql file showing optimal index configuration.  
**Fix:**

### 3.12 **Redundant Error Logging**
**Category:** Best Practice  
**Description:** Most methods call `ErrorHandler.addError` both in catch blocks and before returning, potentially logging the same error twice (e.g., lines 96 and 134).  
**Suggested Fix:** Log errors once in the catch block or establish a pattern where validation errors are logged separately from execution errors, avoiding duplicate logging.  
**Fix:**

### 3.13 **Missing Field Validation in Update Operations**
**Category:** Security  
**Description:** Update methods accept any field name through destructuring (lines 1089, 1163) without validating field names against an allowlist, risking attempts to update protected fields.  
**Suggested Fix:** Create an allowlist of updatable fields for each table and validate incoming update keys against the allowlist before processing.  
**Fix:**

### 3.14 **Inconsistent NULL Handling**
**Category:** Logic  
**Description:** Line 577 rejects empty strings, null, and undefined for `updateUserField`, but other update methods (lines 1095-1104) accept undefined and treat it as "no update".  
**Suggested Fix:** Standardize null/undefined handling: either allow explicit null to clear fields across all methods, or consistently reject it.  
**Fix:**

### 3.16 **Misleading Pagination Count in getUsersList**
**Category:** Logic, Best Practice  
**Description:** `getUsersList` method (lines 954-991) returns `count: result.rows.length` which represents the current page size, not the total number of users available, misleading API consumers who expect total count for pagination calculations.  
**Suggested Fix:** Add a separate query to get total count (`SELECT COUNT(*) FROM users`) or use window functions, returning both `pageCount` and `totalCount` in the response object for proper pagination support.  
**Fix:**

### 3.17 **Redundant Database Queries in createUser**
**Category:** Performance
**Description:** `createUser` performs 3 INSERTs and then immediately calls `buildUserProfile` (which performs 4 SELECTs), resulting in 7+ database operations for a single action where the data is already known in memory.
**Suggested Fix:** Construct the return object directly from the input parameters and generated defaults to eliminate the redundant `buildUserProfile` database fetching.
**Fix:**

### 3.18 **Inefficient Insert-Then-Update Pattern**
**Category:** Performance
**Description:** `updateUserSettings` and `updateUserProfile` use a "check-then-insert-if-missing" followed by "update" pattern, which is less efficient and more race-prone than a single atomic upsert.
**Suggested Fix:** Use PostgreSQL's `INSERT ... ON CONFLICT (uid) DO UPDATE` syntax to handle upserts atomically in a single query.
**Fix:**

### 3.19 **Weak UID Generation Entropy**
**Category:** Security
**Description:** The UID generation uses `randomBytes(5)` (10 hex characters), providing only ~40 bits of entropy which makes collision probable (~10^6 users) and ID guessing feasible.
**Suggested Fix:** Increase UID length to at least 16 bytes (32 hex characters) or use UUID v4 standard to ensure global uniqueness and prevent collisions.
**Fix:**

---

## 4. Low Priority Issues

### 4.1 **Inconsistent Boolean Coercion**
**Category:** Best Practice  
**Description:** Line 667 uses `!!base.is_new_user` for boolean coercion while other places use implicit truthiness or explicit checks, creating style inconsistency.  
**Suggested Fix:** Establish a style guide for boolean coercion (prefer explicit `Boolean()` or `!!`) and apply consistently throughout the codebase.  
**Fix:**

### 4.2 **Unused LOGGER_FLAG_USERS Constant**
**Category:** Best Practice  
**Description:** `LOGGER_FLAG_USERS` is defined at line 20 but only used in 3 places (lines 167, 319, 480, 595), while most debug logs don't use any flag.  
**Suggested Fix:** Either use the flag consistently in all logging calls or remove it if the logging system doesn't benefit from it.  
**Fix:**

### 4.4 **Missing Error Code Constants**
**Category:** Best Practice  
**Description:** Error codes like "GET_CUD_FAILED", "UPDATE_USER_FAILED" (lines 135, 206, 247) are string literals instead of constants, risking typos and making error code discovery difficult.  
**Suggested Fix:** Create an ERROR_CODES constant object at the class level with all error codes defined, ensuring consistency and discoverability.  
**Fix:**

### 4.5 **Inefficient Array Filtering**
**Category:** Performance  
**Description:** Line 62 uses `filter(Boolean)` after split which works but creates an intermediate array; a direct `.filter(p => p)` or regex-based split is clearer.  
**Suggested Fix:** Use `.split(/\s+/).filter(p => p.length > 0)` or `.match(/\S+/g) || []` for clearer intent and potentially better performance.  
**Fix:**


### 4.8 **Missing Field Length Validation**
**Category:** Security  
**Description:** Fields like `displayName`, `bio`, `avatarUrl` are not validated for maximum length before database insertion, risking database errors or excessive storage usage.  
**Suggested Fix:** Add max length validation for all text fields (e.g., displayName max 100, bio max 500) either in SafeUtils validation or before database operations.  
**Fix:**

### 4.9 **Inconsistent Object Spread Usage**
**Category:** Best Practice  
**Description:** Line 190 uses spread with fallback object while line 658 doesn't spread, creating inconsistent patterns for default value handling.  
**Suggested Fix:** Standardize on either spread-with-fallback or explicit property assignment patterns throughout the class.  
**Fix:**

### 4.10 **No Database Connection Error Recovery**
**Category:** Logic  
**Description:** All database operations assume `db.query` succeeds or throws, but don't handle transient connection failures that might be recoverable with retry logic.  
**Suggested Fix:** Implement retry logic with exponential backoff for transient database errors (connection timeouts, deadlocks) at the db utility level.  
**Fix:**

### 4.12 **Missing Method to Clean Up Deleted User Data**
**Category:** Best Practice  
**Description:** `deleteUser` method (line 1219) relies on CASCADE to clean up related tables but doesn't mention cleanup of cached data, sessions, or other resources.  
**Suggested Fix:** Document or implement cleanup of all user-related resources (cache invalidation, session termination, file deletion) when a user is deleted.  
**Fix:**

### 4.14 **Inconsistent Method Naming**
**Category:** Best Practice  
**Description:** Methods mix verb patterns: `getCriticalUserData` (getter), `buildUserProfile` (builder), `isUsernameTaken` (predicate), without clear naming conventions.  
**Suggested Fix:** Establish naming conventions (get* for fetch, build* for compose, check*/is* for predicates, set*/update* for mutations) and apply consistently.  
**Fix:**

### 4.16 **Unused Variable in deleteUser Method**
**Category:** Best Practice, Performance  
**Description:** `deleteUser` method (lines 1233-1236) fetches critical user data and extracts username but never uses the `username` variable, performing an unnecessary database query that adds latency and wastes resources.  
**Suggested Fix:** Remove the unnecessary `getCriticalUserData` call and username extraction if cleanup doesn't require it, or document why the username is needed for future cleanup operations if it's planned but not yet implemented.  
**Fix:**

### 4.17 **Dead Code in getCriticalUsersData**
**Category:** Best Practice  
**Description:** Lines 179-182 in `getCriticalUsersData` push all userIds to a `misses` array without any cache check or filtering logic, suggesting incomplete implementation where cache lookup was intended but never implemented.  
**Suggested Fix:** Remove the dead code if no caching is planned, or implement the intended cache lookup logic before pushing to misses array, ensuring the code matches its intended behavior.  
**Fix:**

### 4.18 **Unused Database Result in createUser**
**Category:** Performance, Best Practice
**Description:** The usage of `RETURNING *` in the `users` table INSERT (Line 881) fetches data into `newUser` (Line 893) which is strictly unused, wasting bandwidth.
**Suggested Fix:** Remove `RETURNING *` or use the returned data to populate the response object instead of re-fetching it.
**Fix:**

### 4.19 **Insecure Exposure of isNewUser Flag**
**Category:** Logic, Security
**Description:** `createUser` and `updateUser` allow the caller to arbitrary set the `isNewUser` flag, potentially bypassing onboarding logic or system state management.
**Suggested Fix:** Manage `isNewUser` internally (default to true on create, update via specific actions) and ignore external input for this field in general update endpoints.
**Fix:**

### 4.20 **Ambiguous public_uid Generation**
**Category:** Logic
**Description:** `buildUserData` returns `public_uid` but `createUser` does not explicitly generate or insert it, relying on implicit database defaults which are not documented or visible in code.
**Suggested Fix:** Verify and document the generation strategy for `public_uid` (e.g. DB trigger or default) to ensure it is reliably populated.
**Fix:**

---

## Summary

This analysis identified **60 issues** across Critical (7), High (14), Medium (19), and Low (20) priority levels. Key recommendations:

### Immediate Actions (Critical)
1. Fix SQL injection vulnerability in dynamic query methods
2. Fix undefined variable reference in createUser (line 886)
3. Fix incorrect error object handling in buildUserData
4. Implement transactions for multi-step operations
5. Standardize error handling patterns
6. Add proper error handling for batch operations
7. Validate all input field types and formats

### Short Term (High Priority)
1. Add username uniqueness check in setUsername
2. Fix inconsistent return types in getBatchOnlineStatus
3. Add transaction wrapper in updateUser method
4. Optimize database queries (eliminate N+1, use JOINs)
5. Implement caching for frequently accessed data
6. Add proper transaction handling for multi-table operations
7. Move dynamic imports to top-level
8. Add rate limiting for critical operations
9. Verify and schema-validate all payload data (new)

### Medium Term
1. Fix misleading pagination count in getUsersList
2. Standardize logging patterns
3. Extract magic values to constants
4. Create shared utilities for repeated patterns
5. Improve documentation completeness
6. Add comprehensive input validation
7. Fix inefficient upsert patterns (new)
8. Improve UID generation entropy (new)

### Long Term
1. Remove unused variables and dead code
2. Add monitoring and metrics
3. Improve Lambda compatibility
4. Enhance error recovery mechanisms
5. Refactor for better testability
6. Implement connection pooling best practices
7. Clean up redundant fetches

---

## Testing Reminders

**IMPORTANT:** After implementing any fixes from this report:

1. **Update Jest Tests:** Ensure all Jest test suites are updated to reflect new or modified methods, including any changes to method signatures, return types, or error handling patterns.

2. **Test Private Methods Indirectly:** Private or helper methods (like `normalizeUsername`, `isUsernameFormatValid`, `initialsFromDisplayName`) should be tested indirectly through their public interfaces that call them.

3. **Follow Existing Code Style:** All code updates must adhere to the existing code style, including:
   - Use of the custom Logger utility for consistent logging
   - Use of ErrorHandler for error reporting
   - Use of SafeUtils for input validation and sanitization
   - Consistent use of async/await patterns
   - Proper JSDoc documentation

4. **Integration Testing:** Given the heavy database interaction, ensure integration tests cover:
   - Transaction rollback scenarios
   - Race condition handling
   - Batch operation error handling
   - Connection pool behavior under load

5. **Lambda-Specific Testing:** If deployed to AWS Lambda, test:
   - Cold start performance
   - Connection pool exhaustion handling
   - Timeout behavior
   - Concurrent execution limits
