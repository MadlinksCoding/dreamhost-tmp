# Sanity To-Do List

This file contains reminders for cleaning up redundant handlers and updating usage after integrating utilities into the Users class.

## Pending Removals and Updates

- [ ] Review and remove any redundant error-handling code or custom error functions replaced by ErrorHandler.
- [ ] Review and remove any redundant sanitization, validation, or parsing logic replaced by SafeUtils.
- [ ] Review and remove any redundant date/time logic replaced by DateTime.
- [ ] Review and remove any console.log statements or custom logging replaced by Logger.debugLog and Logger.writeLog.
- [ ] Review and remove any direct config file loads replaced by ConfigFileLoader.
- [ ] Update any legacy or outdated uses of utilities to match current APIs.
- [ ] Ensure all constants are checked for truthy existence before use, no fallbacks.
- [ ] Remove snake_case naming where not critically required, use camelCase.
- [ ] Always throw errors in catch blocks, no silent catching.

## Method Audit Progress

- [ ] getCriticalUserData - Audit and integrate utilities.
- [ ] getCriticalUsersData - Audit and integrate utilities.
- [ ] getOnlineStatus - Audit and integrate utilities.
- [ ] getBatchOnlineStatus - Audit and integrate utilities.
- [ ] updatePresenceFromSocket - Audit and integrate utilities.
- [ ] setPresenceOverride - Audit and integrate utilities.
- [ ] isUsernameTaken - Audit and integrate utilities.
- [ ] setUsername - Audit and integrate utilities.
- [ ] getUserField - Audit and integrate utilities.
- [ ] updateUserField - Audit and integrate utilities.
- [ ] buildUserData - Audit and integrate utilities.
- [ ] buildUserSettings - Audit and integrate utilities.
- [ ] buildUserProfile - Audit and integrate utilities.
- [ ] createUser - Audit and integrate utilities.
- [ ] getUsersList - Audit and integrate utilities.
- [ ] updateUserSettings - Audit and integrate utilities.
- [ ] updateUserProfile - Audit and integrate utilities.
- [ ] updateUser - Audit and integrate utilities.
- [ ] deleteUser - Audit and integrate utilities.

## Notes

- Start from the top method (getCriticalUserData) and work down one by one.
- For each method, ensure all five utilities (ErrorHandler, Logger, SafeUtils, ConfigFileLoader, DateTime) are integrated correctly.
- Add specific notes here when removing redundant code during audits.
