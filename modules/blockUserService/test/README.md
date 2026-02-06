# BlockService Integration Tests

This directory contains integration tests for the BlockService API endpoints using Supertest and Mocha.

## Setup

Install dependencies:
```bash
npm install --save-dev supertest chai mocha
```

## Running Tests

### Integration Tests
```bash
npm run test:integration
```

### Manual Tests
```bash
npm run test:manual
```

## Test Coverage

The integration tests cover the following scenarios:

### GET /block-users/listUserBlocks

#### Parameter Validation & Filtering
- ✅ **blocker_id parameter filtering** - Ensures `?blocker_id=value` properly filters results
- ✅ **from parameter backward compatibility** - Ensures `?from=value` still works
- ✅ **Non-existent blocker_id** - Returns empty results for invalid blocker_ids
- ✅ **Scope filtering** - Tests `?scope=private_chat` filtering
- ✅ **Testing flag filtering** - Tests `?testing=true` filtering

#### Pagination & Limits
- ✅ **Pagination handling** - Tests limit and nextToken parameters
- ✅ **Limit validation** - Tests invalid limit values (-1, non-numbers)
- ✅ **Limit enforcement** - Ensures results respect the limit parameter

#### Response Structure
- ✅ **Response format validation** - Ensures proper JSON structure
- ✅ **Item structure validation** - Validates required fields in response items
- ✅ **Count/totalCount accuracy** - Verifies count matches items array length

#### Multiple Filters
- ✅ **Combined filtering** - Tests multiple parameters together (blocker_id + scope + testing)

## Key Test Cases

### Blocker ID Filtering (Primary Fix)
```javascript
// This test ensures the blocker_id parameter bug we fixed doesn't regress
it('should filter by blocker_id using blocker_id parameter', async () => {
  const response = await request(app)
    .get('/block-users/listUserBlocks')
    .query({ blocker_id: 'test_blocker', show_total_count: 1, limit: 10 })
    .expect(200);

  // All returned items must have the correct blocker_id
  response.body.items.forEach(item => {
    expect(item.blocker_id).to.equal('test_blocker');
  });
});
```

### Backward Compatibility
```javascript
// Ensures existing API consumers using 'from' parameter still work
it('should filter by blocker_id using from parameter', async () => {
  // Same test but with 'from' parameter instead of 'blocker_id'
});
```

## Preventing Regressions

These tests specifically prevent the issue documented in `API_FILTERING_BUG_ANALYSIS.md` where:
- Query parameter `blocker_id` was ignored by the controller
- API fell back to scanning all records instead of filtering
- Results contained mixed blocker_ids instead of filtering by the requested blocker_id

## Test Data

Tests use existing database data. For consistent testing, ensure the database contains test records with known blocker_ids and testing=true flags.

## Continuous Integration

Add this to your CI pipeline:
```yaml
- name: Run Integration Tests
  run: npm run test:integration
  working-directory: modules/blockUserService
```