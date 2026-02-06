# BlockService.listUserBlocks() - Problem Diagnosis

## Issue Summary
The `listUserBlocks()` method is returning 0 items even though the database contains over 400 rows. The tests show that blocks are being created successfully, but when querying with filters like `{ testing: true }`, no results are returned.

## Test Failures
Three tests are failing:
1. **"List User Blocks - Empty Database"** - Expected ≤5 items, got 8 (eventual consistency issue)
2. **"List User Blocks - Pagination Details"** - Expected ≥1 item, got 0
3. **"List User Blocks - Large Dataset Performance"** - Expected ≥15 items, got 1

## Root Cause Analysis

### Problem 1: Meta Fields Not Stripped from Filters

In `listUserBlocks()` at line 312, the code passes `validatedFilters` directly to `buildScanOptions()`:

```javascript
const scanOptions = buildScanOptions(validatedFilters);
```

However, `validatedFilters` may contain meta fields like:
- `show_deleted` 
- `show_total_count`

These meta fields should NOT be included in the database filter expression. 

**Compare with `listSystemBlocks()`** at line 795, which correctly strips these fields:

```javascript
const { show_total_count, ...scanFilters } = validatedFilters;
const options = buildScanOptions(scanFilters);
```

### Problem 2: Inconsistent Filter Handling

The `buildScanOptions()` function (lines 6-32) has a limitation:

```javascript
if (value !== undefined && value !== null && value !== "" && 
    (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
  // Process filter
}
```

This means:
- Boolean `false` values are processed ✓
- Boolean `true` values are processed ✓  
- But if `show_deleted: false` is in the filters, it WILL be processed by `buildScanOptions()` and create a filter expression!

### Problem 3: Duplicate Filter Logic

When `show_deleted` is `false` or `undefined`, the code at lines 318-324 adds:

```javascript
scanOptions.FilterExpression += ' AND attribute_not_exists(deleted_at)';
```

BUT if `show_deleted: false` was already processed by `buildScanOptions()`, you now have:
- `#attr0 = :val0` (from buildScanOptions for show_deleted)
- ` AND attribute_not_exists(deleted_at)` (from the manual addition)

This creates a conflicting filter expression!

### Problem 4: Index Usage vs Table Scan

The scan operation is NOT using any indexes efficiently. Looking at the schema, `user_blocks` likely has:
- PK: `blocker_id`
- SK: `sk_scope` 

When filtering by `testing: true` without a `blocker_id`, the code performs a **full table scan** with a filter expression. This is:
1. Slow
2. Subject to DynamoDB/ScyllaDB scan limits
3. May not return all results due to scan pagination limits

## The Fix

### Fix 1: Strip Meta Fields (CRITICAL)

```javascript
// Line 310-312, replace:
else {
  // No blocker_id filter, use scan with filters
  const scanOptions = buildScanOptions(validatedFilters);
```

With:

```javascript
else {
  // No blocker_id filter, use scan with filters
  const { show_deleted, show_total_count, ...scanFilters } = validatedFilters;
  const scanOptions = buildScanOptions(scanFilters);
```

### Fix 2: Update Deleted Filter Logic

```javascript
// Line 317-324, update to use the extracted show_deleted:
if (show_deleted === false || show_deleted === undefined) {
  if (!scanOptions.FilterExpression) {
    scanOptions.FilterExpression = 'attribute_not_exists(deleted_at)';
  } else {
    scanOptions.FilterExpression += ' AND attribute_not_exists(deleted_at)';
  }
}
```

### Fix 3: Update Count Logic

```javascript
// Line 329, update to use scanFilters:
const countOptions = buildScanOptions(scanFilters);
```

And update the deleted filter check at line 335:

```javascript
if (show_deleted === false || show_deleted === undefined) {
  // ...
}
```

## Why This Causes 0 Results

When `show_deleted: false` is passed in filters:

1. `buildScanOptions({ testing: true, show_deleted: false })` creates:
   - `FilterExpression`: `"#attr0 = :val0 AND #attr1 = :val1"`
   - `ExpressionAttributeNames`: `{ "#attr0": "testing", "#attr1": "show_deleted" }`
   - `ExpressionAttributeValues`: `{ ":val0": true, ":val1": false }`

2. Then the code adds: ` AND attribute_not_exists(deleted_at)`

3. The final filter becomes:
   ```
   testing = true AND show_deleted = false AND attribute_not_exists(deleted_at)
   ```

4. **The database items don't have a `show_deleted` field!** So the filter `show_deleted = false` matches ZERO items!

## Summary

The `show_deleted` and `show_total_count` fields are **control parameters** for the query logic, NOT database fields to filter on. By including them in the filter expression, the query tries to match them against database columns that don't exist, resulting in 0 results.

The fix is to strip these meta fields before building the scan options, exactly like `listSystemBlocks()` does.
