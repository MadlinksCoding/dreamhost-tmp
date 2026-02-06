# BlockUserService Schema

This document defines the data models and enumerations used in the BlockUserService.

## Enums

```prisma
enum MisconductFlag {
  fraud                 // "Potential Fraudulent Activities"
  abuse                 // "Reported Abusive Behavior"
  violence              // "Violence"
  unacceptable_behavior // "Unacceptable Behavior"
  exploitation          // "Exploitation - non-consensual media"
  hate                  // "Hateful Activities"
  harassment            // "Harassment and Criticism"
  child_safety          // "Child Safety"
  self_injury           // "Self-injury or Harmful Behavior"
  graphic_violence      // "Graphic Violence or Threats"
  dangerous_activities  // "Dangerous Activities"
  impersonation         // "Impersonation"
  security              // "Site Security and Access"
  spam                  // "Spam Detection"
}

enum BlockType {
  ip
  email
  app
}

enum ActionType {
  suspend
  warning
}
```

## Models

### UserBlock
Stores blocks between users.

```prisma
model UserBlock {
  blocker_id    String   @id // Partition Key
  blocked_id    String   @id // Sort Key
  scope         String
  reason        String?  @default("unspecified")
  flag          String?
  is_permanent  Boolean  @default(false)
  expires_at    BigInt?  // Timestamp in ms
  created_at    BigInt   // Timestamp in ms

  @@map("user_blocks")
}
```

### SystemBlock
Stores system-level blocks (IP, Email, App Access).

```prisma
model SystemBlock {
  identifier    String   @id // Partition Key (IP, Hashed Email, or UserID)
  type          BlockType
  scope         String   @default("auth")
  reason        String?  @default("unspecified")
  is_permanent  Boolean  @default(true)
  expires_at    BigInt?
  created_at    BigInt

  @@map("system_blocks")
}
```

### ManualAction
Stores administrative actions taken against users (Suspensions, Warnings).

```prisma
model ManualAction {
  user_id       String   @id // Partition Key
  type          ActionType
  reason        String
  flag          MisconductFlag?
  internal_note String?
  admin_id      String
  created_at    BigInt

  @@map("manual_actions")
}
```
