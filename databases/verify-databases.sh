#!/bin/bash

# Script to verify database changes after running schema handler
# Usage: ./verify-databases.sh

echo "=========================================="
echo "  Database Verification Script"
echo "=========================================="
echo ""

# PostgreSQL
if command -v psql &> /dev/null; then
    echo "📊 PostgreSQL:"
    echo "   Tables:"
    PGPASSWORD=${PGPASSWORD:-app_admin_pw} psql -U ${PGUSER:-app_admin} -d ${PGDATABASE:-app_db} -h ${PGHOST:-localhost} -c "\dt" 2>/dev/null || echo "   ⚠ Connection failed"
    echo ""
    echo "   Orders table structure:"
    PGPASSWORD=${PGPASSWORD:-app_admin_pw} psql -U ${PGUSER:-app_admin} -d ${PGDATABASE:-app_db} -h ${PGHOST:-localhost} -c "\d orders" 2>/dev/null || echo "   ⚠ Table not found or connection failed"
    echo ""
else
    echo "⚠ PostgreSQL client (psql) not found"
    echo ""
fi

# MySQL
if command -v mysql &> /dev/null; then
    echo "📊 MySQL:"
    echo "   Tables:"
    mysql -u ${DB_USER:-root} -p${DB_PASS:-} -h ${DB_HOST:-localhost} ${DB_NAME:-app_db} -e "SHOW TABLES;" 2>/dev/null || echo "   ⚠ Connection failed"
    echo ""
    echo "   Orders table structure:"
    mysql -u ${DB_USER:-root} -p${DB_PASS:-} -h ${DB_HOST:-localhost} ${DB_NAME:-app_db} -e "DESCRIBE orders;" 2>/dev/null || echo "   ⚠ Table not found or connection failed"
    echo ""
else
    echo "⚠ MySQL client not found"
    echo ""
fi

# Scylla (DynamoDB API)
if command -v aws &> /dev/null; then
    echo "📊 Scylla (DynamoDB API):"
    echo "   Tables:"
    aws dynamodb list-tables --endpoint-url ${SCYLLA_ENDPOINT:-http://localhost:8000} 2>/dev/null || echo "   ⚠ Connection failed"
    echo ""
    echo "   Orders table structure:"
    aws dynamodb describe-table --table-name Orders --endpoint-url ${SCYLLA_ENDPOINT:-http://localhost:8000} --query 'Table.{TableName:TableName,KeySchema:KeySchema,AttributeDefinitions:AttributeDefinitions}' 2>/dev/null || echo "   ⚠ Table not found or connection failed"
    echo ""
else
    echo "⚠ AWS CLI not found (needed for Scylla/DynamoDB)"
    echo ""
fi

echo "=========================================="
echo "  Verification Complete"
echo "=========================================="








