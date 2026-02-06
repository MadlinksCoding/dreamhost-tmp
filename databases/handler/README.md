# Database Manager

## Description
What you get now

One .env file; per-table versioning.

Two full schema files: schema.v2.1.json and schema.v2.2.json (no mix).

Handler logs all critical details: env versions, plan targets, adds, items to manually remove, future items, and errors.

finalValidate() to verify everything exists for the active versions and loudly fail if not.

tests/testit.js to plan, apply, and validate against either v2.1 or v2.2 config.

## How to Run the Examples

1. Plan for 2.1
node tests/testit.js plan ./schema.v2.1.json

2. Apply 2.2
node tests/testit.js apply ./schema.v2.2.json

3. Final Validation for 2.2 (throws if mismatched)
node tests/testit.js validate ./schema.v2.2.json
