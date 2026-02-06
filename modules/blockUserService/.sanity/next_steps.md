# BlockUserService: Missing Features & Critical Issues

## 1. Schema Key Collisions (Data Loss Risk)
The current ScyllaDB schema configuration allows different types of blocks to overwrite each other because the Primary Keys (PK) are not specific enough.

- **`system_blocks`**
  - **Current**: PK is only `identifier`.
  - **Problem**: Blocking an IP (`1.2.3.4`) and then blocking an App User with ID `1.2.3.4` (if IDs overlap) or using the same identifier for different scopes will overwrite the previous entry.
  - **Fix Needed**: Add `type` (and possibly `scope`) to the Primary Key (e.g., PK: `identifier`, SK: `type`).

- **`user_blocks`**
  - **Current**: PK is `blocker_id`, SK is `blocked_id`.
  - **Problem**: If User A blocks User B in "chat", and then blocks them in "feed", the second block overwrites the first. You cannot have distinct blocks per scope.
  - **Fix Needed**: Add `scope` to the Sort Key (e.g., PK: `blocker_id`, SK: `blocked_id#scope`).

- **`manual_actions`**
  - **Current**: PK is `user_id`.
  - **Problem**: A user can only have one manual action at a time. A suspension will overwrite a warning history.
  - **Fix Needed**: Add `created_at` or `type` to the Sort Key to allow a history of actions.

## 2. Suspension Metadata Helper
- **Missing**: The logic to retrieve the specific "Action Text" and "Redirect slug" based on `MISCONDUCT_FLAGS` is not implemented.
- **Requirement**: Create a static function (e.g., `getSuspensionDetails(flag)`) that returns:
  - Text: e.g., "Your Account is suspended due to potential fraudulent activities"
  - Slug: e.g., "support"

## 3. "Suspect" Action Type
- **Missing**: The `todo.md` suggests adding a `type: "suspect"` for warnings that should be treated as "suspected" behavior (e.g., for fraud flags).
- **Requirement**: Implement logic to handle `type: "suspect"` in `warnUser` or a new method, and ensure it sets the appropriate Redis keys for middleware checks.

## 4. Implementation Steps

### Step 1: Fix Schema & Key Collisions
**Goal**: Prevent data overwrites by making Primary/Sort Keys unique, while keeping the JSON response clean.

1.  **Update `scylla-schema-config.json`**:
    *   We will introduce *new* Sort Key columns (`sk_scope`, `sk_type`, `sk_ts`) to handle uniqueness. The existing fields (`blocked_id`, `scope`, etc.) will remain as regular attributes for the JSON response.
    ```json
    "user_blocks": {
      "PK": "blocker_id",
      "SK": "sk_scope",  // New column for uniqueness: "blocked_id#scope"
      "Fields": [ ... ]
    },
    "system_blocks": {
      "PK": "identifier",
      "SK": "sk_type",   // New column for uniqueness: "type" (e.g., "ip", "email")
      "Fields": [ ... ]
    },
    "manual_actions": {
      "PK": "user_id",
      "SK": "sk_ts",     // New column for uniqueness: timestamp
      "Fields": [ ... ]
    }
    ```

2.  **Update `BlockService.js`**:
    *   **User Blocks**: When calling `putItem`, add the new `sk_scope` field.
        ```javascript
        const item = {
          blocker_id: from,
          blocked_id: to,
          scope,
          sk_scope: `${to}#${scope}`, // Composite key for uniqueness
          ...
        };
        ```
    *   **System Blocks**: Add `sk_type`.
        ```javascript
        const item = {
          identifier: ip, // or email hash, or userId
          type: "ip",
          sk_type: "ip", // Simple key for uniqueness (prevents IP vs App ID collision if IDs overlap)
          ...
        };
        ```
    *   **Manual Actions**: Add `sk_ts`.
        ```javascript
        const item = {
          user_id: userId,
          created_at: Date.now(),
          sk_ts: Date.now().toString(), // Timestamp for history
          ...
        };
        ```

3.  **Migration**:
    *   Run `npm run deleteTable` then `npm run createTable` to apply the new schema.

### Step 2: Implement Suspension Metadata Helper
1.  **Define Data Structure**:
    *   Create a static object `SUSPENSION_METADATA` inside `BlockService` (or outside as a const) mapping flags to `{ text, slug }`.
    *   Example: `fraud: { text: "Your Account is suspended due to potential fraudulent activities", slug: "support" }`.
2.  **Add Helper Method**:
    *   Implement `static getSuspensionDetails(flag)` in `BlockService`.
    *   It should return the metadata for the flag, or a default fallback.

### Step 3: Implement "Suspect" Logic
1.  **Add `suspectUser` Method**:
    *   Create `static async suspectUser(userId, reason, adminId, flag, note)` in `BlockService`.
    *   This should create a `manual_actions` entry with `type: "suspect"`.
    *   Set a Redis key `block:suspect:${userId}`.
2.  **Add `isUserSuspected` Method**:
    *   Create `static async isUserSuspected(userId)`.
    *   Check Redis key `block:suspect:${userId}` and DB for `type: "suspect"`.
3.  **Update `server.js`**:
    *   Add routes `POST /block/suspectUser` and `GET /block/isUserSuspected`.


