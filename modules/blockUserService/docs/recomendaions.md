## Recommendations to Improve BlockService

1. **Add Sort Key Support**  
Implement sort key usage (e.g., `created_at` or `sk_ts`) in all relevant queries and scans to enable efficient sorting and filtering, especially for listing and pagination.

2. **Consistent Sorting**  
Always return lists (blocks, actions, etc.) sorted by `created_at` descending (newest first) for predictable and user-friendly results.

3. **Index Optimization**  
Review and optimize ScyllaDB table indexes and primary keys to support common query patterns, especially for filtering by user, type, and date.

4. **Error Handling Standardization**  
Centralize and standardize error handling and logging to ensure all errors are captured and reported in a consistent, developer-friendly way.

5. **Input Validation Improvements**  
Enhance input validation with stricter type checks, length limits, and clear error messages to prevent invalid data from entering the system.

6. **Expiry and Cleanup Automation**  
Implement scheduled jobs or triggers to automatically clean up expired or soft-deleted block records, keeping tables lean and queries fast.

7. **Add Block Reason Codes**  
Standardize block reasons using enumerated codes (not just free text) to simplify analytics, reporting, and UI display.

8. **API Documentation**  
Document all public methods with clear descriptions, expected parameters, and example responses to help new developers onboard quickly.

9. **Modularize Utility Functions**  
Extract helpers (like `buildScanOptions`) and notification logic into dedicated utility modules for easier testing and reuse.

10. **Test Coverage**  
Expand automated test coverage, especially for edge cases (e.g., expired blocks, overlapping scopes, invalid input), to ensure reliability as the codebase evolves.
