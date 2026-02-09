# Running with Docker and ScyllaDB

Each module is independently deployable with its own Docker setup. Modules use **ScyllaDB** (Alternator/DynamoDB API) for data storage.

## Module Architecture

Each module has its own:
- `docker-compose.yml` - Module-specific Docker configuration
- `scripts/init-tables.js` - Database table initialization
- `scripts/seed-*.js` - Data seeding scripts
- Server implementation (module-specific)

## Module-Specific Docker Setup

### Payment Gateway Module

```bash
cd modules/payment
docker compose up -d
```

The payment module runs on port **3001** and includes:
- ScyllaDB service (port 9042, 8000)
- Database initialization
- Application server

### Token Registry Module

```bash
cd modules/tokenRegistry
docker compose up -d
```

The token registry module runs on port **3002** and includes:
- ScyllaDB service (port 9043, 8001)
- Database initialization
- Application server

## Module Documentation

For module-specific documentation, see:
- **Payment Gateway**: `modules/payment/README.md` and `modules/payment/docs/`
- **Token Registry**: `modules/tokenRegistry/README.md` and `modules/tokenRegistry/docs/`

## Testing

Each module has its own test suite. Run tests from the module directory:

```bash
# Payment Gateway tests
cd modules/payment
npm test

# Token Registry tests
cd modules/tokenRegistry
npm test
```
