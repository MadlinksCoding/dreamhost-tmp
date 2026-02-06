@echo off
echo ========================================
echo Database Schema Handler - Setup Script
echo ========================================
echo.

REM Check if .env exists
if not exist .env (
    echo Creating .env file from template...
    (
        echo # PostgreSQL Connection
        echo PGUSER=app_admin
        echo PGPASSWORD=app_admin_pw
        echo PGDATABASE=app_db
        echo PGPORT=5432
        echo PGHOST=127.0.0.1
        echo PG_SCHEMA=app
        echo DB_IS_DOCKER=1
    ) > .env
    echo .env file created!
    echo.
) else (
    echo .env file already exists, skipping...
    echo.
)

REM Check if Docker is running
docker ps >nul 2>&1
if errorlevel 1 (
    echo ERROR: Docker is not running!
    echo Please start Docker Desktop and try again.
    pause
    exit /b 1
)

echo Starting PostgreSQL container...
docker-compose up -d postgres

if errorlevel 1 (
    echo ERROR: Failed to start PostgreSQL container!
    pause
    exit /b 1
)

echo.
echo Waiting for PostgreSQL to be ready...
timeout /t 5 /nobreak >nul

REM Check if container is running
docker ps | findstr local-postgres >nul
if errorlevel 1 (
    echo ERROR: PostgreSQL container is not running!
    echo Check logs with: docker-compose logs postgres
    pause
    exit /b 1
)

echo PostgreSQL container is running!
echo.

REM Install dependencies
echo Installing dependencies...
echo.

if exist handler\package.json (
    echo Installing handler dependencies...
    cd handler
    call npm install
    cd ..
    echo.
)

if exist postgres\package.json (
    echo Installing PostgreSQL adapter dependencies...
    cd postgres
    call npm install
    cd ..
    echo.
)

echo ========================================
echo Setup Complete!
echo ========================================
echo.
echo Next steps:
echo 1. Verify database: docker exec -it local-postgres psql -U app_admin -d app_db -c "\dn"
echo 2. Plan changes: cd handler ^&^& node test.js plan ./schema.v2.2.json
echo 3. Apply changes: cd handler ^&^& node test.js apply ./schema.v2.2.json
echo.
echo See HOW_TO_RUN.md for detailed instructions.
echo.
pause










