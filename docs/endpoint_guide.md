# Endpoint Naming Guide

This project follows a specific **Explicit Action-Based** URL naming convention. Unlike standard RESTful conventions where the HTTP method determines the action on a resource, we explicitly state the action in the URL path.

## Core Philosophy

*   **Clarity over Brevity:** The URL should clearly describe exactly what operation is being performed.
*   **Action + Resource:** Endpoint paths typically follow the pattern `verbResource`.
*   **CamelCase:** URL segments use camelCase.

## Naming Conventions

### 1. Standard CRUD Operations

| Operation | HTTP Method | Standard REST (Avoid) | **Project Standard (Use)** |
| :--- | :--- | :--- | :--- |
| **Create** | `POST` | `/resource` | `/resource/createResource` |
| **Read (List)** | `GET` | `/resource` | `/resource/fetchResources` |
| **Read (One)** | `GET` | `/resource/:id` | `/resource/fetchResourceById/:id` |
| **Update** | `PUT` | `/resource/:id` | `/resource/updateResource/:id` |
| **Delete** | `DELETE` | `/resource/:id` | `/resource/deleteResource/:id` |

### 2. Custom Actions

For specific business logic actions, use `POST` and describe the action clearly.

*   **Pattern:** `POST /resource/verbAction/:id`
*   **Example:** `POST /moderation/escalateModeration/:moderationId`

### 3. Counts and Aggregations

*   **Single Count:** `GET /resource/fetchResourceCount`
*   **Aggregate Counts:** `GET /resource/fetchAllResourceCounts`

## Examples (Moderation API)

Below is the reference implementation from the Moderation service:

```javascript
// Create
POST   /moderation/createModerationEntry

// Read
GET    /moderation/fetchModerations
GET    /moderation/fetchModerationById/:moderationId
GET    /moderation/fetchModerationContent/:moderationId
GET    /moderation/fetchModerationNotes/:moderationId

// Update
PUT    /moderation/updateModeration/:moderationId
POST   /moderation/updateModerationMeta/:moderationId

// Delete
DELETE /moderation/deleteModeration/:moderationId

// Actions
POST   /moderation/applyModerationAction/:moderationId
POST   /moderation/escalateModeration/:moderationId
POST   /moderation/addNote/:moderationId
POST   /moderation/notifyModeration/:moderationId

// Utilities
GET    /moderation/fetchModerationCount
GET    /moderation/fetchAllModerationCounts
POST   /moderation/cacheFlushTag/:tagId
POST   /moderation/cacheFlushGeneral
```

## Implementation Checklist

When creating a new endpoint:
1. [ ] Does the URL start with the resource name? (e.g., `/users`, `/moderation`)
2. [ ] Does the next segment describe the action? (e.g., `createUser`, `fetchUser`)
3. [ ] Is the action in camelCase?
4. [ ] If it targets a specific item, is the ID parameter clear? (e.g., `/:userId`)
