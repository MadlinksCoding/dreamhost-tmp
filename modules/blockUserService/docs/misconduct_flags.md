# Misconduct Flags & Suspension Reasons

The `BlockUserService` uses a standardized set of flags to handle user misconduct. Each flag maps to a specific user-facing message, a call-to-action, and a redirection slug.

## Configuration Table

| Flag Key | Suspension Text | Action Text | Redirect Slug |
| :--- | :--- | :--- | :--- |
| `fraud` | Your Account is suspended due to potential fraudulent activities | Contact Support | `support` |
| `abuse` | Your Account will be suspended due to reported abusive behavior | Contact Support | `support` |
| `violence` | Your Account is suspended due to violence | Contact Support | `support` |
| `unacceptable_behavior` | Your Account is suspended due to unacceptable behavior | Contact Support | `support` |
| `exploitation` | Your Account is suspended due to exploitation - non-consensual media | Contact Support | `support` |
| `hate` | Your Account is suspended due to hateful activities | Contact Support | `support` |
| `harassment` | Your Account will be suspended due to harassment and criticism | Contact Support | `support` |
| `child_safety` | Your Account is suspended due to child safety | Contact Support | `support` |
| `self_injury` | Your Account is suspended due to self-injury or harmful behavior | Contact Support | `support` |
| `graphic_violence` | Your Account is suspended due to graphic violence or threats | Contact Support | `support` |
| `dangerous_activities` | Your Account is suspended due to dangerous activities | Contact Support | `support` |
| `impersonation` | Your Account will be suspended due to impersonation | Contact Support | `support` |
| `security` | Your Account is suspended due to site security and access | Contact Support | `support` |
| `spam` | Your Account will be suspended due to spam detection | Contact Support | `support` |

## Implementation Details

These rules are encapsulated in `BlockService.js` via the static method `_getMisconductRules()`.

### Helper Method
To retrieve details for a specific flag programmatically:

```javascript
const details = BlockService.getMisconductDetails('fraud');
// Returns:
// {
//   text: "Your Account is suspended due to potential fraudulent activities",
//   action: "Contact Support",
//   slug: "support"
// }
```

### Usage in Suspensions
When `getSuspensionDetails(userId)` is called for a suspended user, the response is enriched with these details if a valid flag was stored.

```json
{
  "reason": "Your Account is suspended due to potential fraudulent activities",
  "flag": "fraud",
  "created_at": 1767465933919,
  "admin_id": "admin_123",
  "text": "Your Account is suspended due to potential fraudulent activities",
  "action": "Contact Support",
  "slug": "support"
}
```
