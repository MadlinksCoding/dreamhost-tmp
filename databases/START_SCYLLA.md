# Start ScyllaDB in Docker

## Quick Start

### Option 1: Start All Databases (Recommended)

```bash
# Start PostgreSQL and ScyllaDB together
docker-compose up -d

# Check status
docker-compose ps

# View logs
docker-compose logs scylla
```

### Option 2: Start Only ScyllaDB

```bash
# Start ScyllaDB only
docker-compose up -d scylla

# Check status
docker-compose ps scylla

# View logs
docker-compose logs -f scylla
```

### Option 3: Use Scylla-Specific Compose File

```bash
# Navigate to scylla directory
cd scylla

# Start ScyllaDB
docker-compose up -d

# Check status
docker-compose ps
```

---

## Verify ScyllaDB is Running

### Check Container Status
```bash
docker ps | grep scylla
```

**Expected output**:
```
CONTAINER ID   IMAGE                    STATUS         PORTS
abc123def456   scylladb/scylla:latest  Up 2 minutes   0.0.0.0:8000->8000/tcp, 0.0.0.0:9042->9042/tcp
```

### Test Alternator Endpoint
```bash
# Test HTTP endpoint (should return error, but means it's running)
curl http://localhost:8000

# Or use PowerShell
Invoke-WebRequest -Uri http://localhost:8000
```

**Expected**: Error response (this is normal - means Scylla is running)

### Test with AWS CLI
```bash
aws dynamodb list-tables \
  --endpoint-url http://localhost:8000 \
  --region us-east-1 \
  --aws-access-key-id fakeAccessKey \
  --aws-secret-access-key fakeSecretKey
```

### Test with Node.js Script
```bash
node test-scylla-connection.js
```

---

## ScyllaDB Ports

| Port | Purpose |
|------|---------|
| **8000** | Alternator API (DynamoDB-compatible) |
| **9042** | CQL (Cassandra Query Language) |
| **9180** | Prometheus metrics |

---

## Common Commands

### Start
```bash
docker-compose up -d scylla
```

### Stop
```bash
docker-compose stop scylla
```

### Restart
```bash
docker-compose restart scylla
```

### View Logs
```bash
# Follow logs
docker-compose logs -f scylla

# Last 100 lines
docker-compose logs --tail=100 scylla
```

### Remove Container (keeps data)
```bash
docker-compose down scylla
```

### Remove Container and Data
```bash
docker-compose down -v scylla
```

---

## Troubleshooting

### Port Already in Use
```bash
# Check what's using port 8000
netstat -ano | findstr :8000

# Or on Linux/Mac
lsof -i :8000
```

**Solution**: Stop the process using port 8000, or change the port in docker-compose.yml

### Container Won't Start
```bash
# Check logs
docker-compose logs scylla

# Check container status
docker-compose ps

# Try removing and recreating
docker-compose down scylla
docker-compose up -d scylla
```

### Connection Refused
```bash
# Wait a bit - Scylla takes 30-60 seconds to start
# Check if it's ready
docker-compose logs scylla | grep "Scylla version"

# Test again after 30 seconds
curl http://localhost:8000
```

### Out of Memory
If you get memory errors, reduce memory in docker-compose.yml:
```yaml
command:
  - --memory=512M  # Reduce from 750M
```

---

## Configuration

Your `.env` file should have:
```env
SCYLLA_ALTERNATOR_ENDPOINT=http://localhost:8000
SCYLLA_ACCESS_REGION=us-east-1
SCYLLA_ACCESS_KEY=fakeAccessKey
SCYLLA_ACCESS_PASSWORD=fakeSecretKey
```

This matches the Docker setup! ✅

---

## Full Stack Start

To start all databases (PostgreSQL + ScyllaDB):

```bash
# Start everything
docker-compose up -d

# Check all services
docker-compose ps

# View all logs
docker-compose logs -f
```

**Services**:
- PostgreSQL: `localhost:5432`
- ScyllaDB: `localhost:8000` (Alternator API)

---

## Next Steps

1. ✅ Start ScyllaDB: `docker-compose up -d scylla`
2. ✅ Test connection: `node test-scylla-connection.js`
3. ✅ Connect with NoSQL Workbench (see SCYLLA_CONNECTION_GUIDE.md)
4. ✅ Run schema handler: `cd handler && node demo.js`

---

## Quick Reference

```bash
# Start
docker-compose up -d scylla

# Status
docker-compose ps scylla

# Logs
docker-compose logs -f scylla

# Stop
docker-compose stop scylla

# Remove
docker-compose down scylla
```

**That's it!** 🎉








