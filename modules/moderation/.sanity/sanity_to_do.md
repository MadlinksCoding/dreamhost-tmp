# Sanity To-Do List

- Confirmed ErrorHandler is used for error handling in createModerationSchema. No legacy error handler found.
- No input validation, date/time logic, or config file loading required for this method.
- Logger is not used; consider adding Logger.debugLog for method entry if needed for debugging (not system-level).
- No legacy code to remove in this method.
- Refactored _getCurrentTimestamp to use Logger.debugLog for method entry and ErrorHandler for error handling. Removed outdated Logger.error usage.
- Refactored _validateTimestamp to use Logger.debugLog for method entry, ErrorHandler for error handling, and SafeUtils for validation. Ensured DateTime is used for time logic. Removed legacy error throwing.
- Refactored _validateModerationData to use Logger.debugLog for method entry and success, ErrorHandler for error handling, and SafeUtils for validation. Removed legacy error throwing.
- Refactored _createMetaField to use Logger.debugLog for method entry and success, and DateTime for timestamp generation. No error handling needed.
- Refactored _updateMetaField to use Logger.debugLog for method entry and success, and DateTime for timestamp generation. No error handling needed.
- Refactored _buildPartitionKey to use Logger.debugLog for method entry and success, ErrorHandler for error handling, and SafeUtils for validation. Removed legacy error throwing.
- Refactored _decodeNextToken to use Logger.debugLog for method entry, info, success, and error; ErrorHandler for error handling; and SafeUtils for validation. Removed legacy Logger.error usage.
- Refactored _validateFieldLength to use Logger.debugLog for method entry and error, and ErrorHandler for error handling. Removed legacy error throwing.
- Refactored _retryOperation to use Logger.debugLog for method entry, success, and info; removed legacy Logger.warn usage.
- Refactored generateModerationId to use Logger.debugLog for method entry, success, and info; replaced Logger.error with ErrorHandler.addError.
- Refactored dayKeyFromTs to use Logger.debugLog for method entry and success; added ErrorHandler for invalid timestamp error.
- Refactored statusSubmittedAtKey to use Logger.debugLog for method entry and success; added ErrorHandler for invalid status/ts error.
- Refactored createModerationEntry to use Logger.debugLog for method entry and success; added ErrorHandler for invalid userId error; replaced Logger.log with Logger.writeLog.
- Refactored updateModerationEntry to use Logger.debugLog for method entry, info, and success; added ErrorHandler for all error cases; replaced Logger.log with Logger.writeLog.
- **addNote**: Refactored to add Logger.debugLog at method start and success. Replaced throw new Error with ErrorHandler.addError + throw for addedBy required, note text required, note text required after sanitization, moderation item not found. Replaced Logger.warn with Logger.debugLog for duplicate note detection. Replaced Logger.log with Logger.writeLog for note added event. No changes to existing ErrorHandler in catch block.
- **applyModerationAction**: Refactored to add Logger.debugLog at method start and success. Replaced throw new Error with ErrorHandler.addError + throw for invalid action and moderation item not found. Replaced Logger.log with Logger.writeLog for action applied event. No changes to existing ErrorHandler in catch block.
- **escalateModerationItem**: Refactored to add Logger.debugLog at method start and success. Replaced throw new Error with ErrorHandler.addError + throw for escalatedBy required and moderation item not found. Replaced Logger.log with Logger.writeLog for item escalated event. No changes to existing ErrorHandler in catch block.
- **getModerationItems**: Refactored to add Logger.debugLog at method start and success. Replaced throw new Error with ErrorHandler.addError + throw for invalid status, priority, type, dayKey format. No Logger.log to replace. No changes to existing ErrorHandler in catch block.
- **getModerationItemsByStatus**: Refactored to add Logger.debugLog at method start and success (for both scan and query paths). Replaced throw new Error with ErrorHandler.addError + throw for invalid status. No Logger.log to replace. No changes to existing ErrorHandler in catch block.
- **getAllByDate**: Refactored to add Logger.debugLog at method start and success. Replaced throw new Error with ErrorHandler.addError + throw for dayKey required and invalid dayKey format. No Logger.log to replace. No changes to existing ErrorHandler in catch block.
- **getUserModerationItemsByStatus**: Refactored to add Logger.debugLog at method start and success (for both all and specific status paths). Replaced throw new Error with ErrorHandler.addError + throw for userId required, status required, invalid status. No Logger.log to replace. No changes to existing ErrorHandler in catch block.
- **getModerationItemsByPriority**: Refactored to add Logger.debugLog at method start and success. Replaced throw new Error with ErrorHandler.addError + throw for priority required and invalid priority. No Logger.log to replace. No changes to existing ErrorHandler in catch block.
- **getModerationItemsByType**: Refactored to add Logger.debugLog at method start and success. Replaced throw new Error with ErrorHandler.addError + throw for type required and invalid type. No Logger.log to replace. No changes to existing ErrorHandler in catch block.
- **getModerationRecordById**: Refactored to add Logger.debugLog at method start and success. Replaced throw new Error with ErrorHandler.addError + throw for moderationId required. No Logger.log to replace. No changes to existing ErrorHandler in catch block.
- **updateModerationMeta**: Refactored to add Logger.debugLog at method start and success. Replaced throw new Error with ErrorHandler.addError + throw for moderationId required and moderation item not found. Replaced Logger.log with Logger.writeLog for meta updated event. No changes to existing ErrorHandler in catch block.
- **softDeleteModerationItem**: Refactored to add Logger.debugLog at method start and success. Replaced throw new Error with ErrorHandler.addError + throw for moderationId required, moderation item not found, already deleted. Replaced Logger.log with Logger.writeLog for item soft deleted event. No changes to existing ErrorHandler in catch block.
- **hardDeleteModerationItem**: Refactored to add Logger.debugLog at method start and success. Replaced throw new Error with ErrorHandler.addError + throw for moderationId required. Replaced Logger.log with Logger.writeLog for item hard deleted event. No changes to existing ErrorHandler in catch block.
- **countModerationItemsByStatus**: Refactored to add Logger.debugLog at method start and success. Replaced throw new Error with ErrorHandler.addError + throw for status required and invalid status. No Logger.log to replace. No changes to existing ErrorHandler in catch block.
- **getAllModerationCounts**: Refactored to add Logger.debugLog at method start and success. No throw new Error to replace. No Logger.log to replace. No changes to existing ErrorHandler in catch block.
- **_countPendingResubmission**: Refactored to add Logger.debugLog at method start and success. No throw new Error to replace. Replaced Logger.error with ErrorHandler.addError in catch block.



- **Remove getAllModerationCounts**:  we should have 1 count emthod and this increases complexity
