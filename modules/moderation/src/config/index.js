import dotenv from 'dotenv';

dotenv.config();

// Load environment variables from .env file
const config = {
    port: process.env.PORT || 3000,
    scylla: {
        host: process.env.SCYLLA_HOST || 'localhost',
        port: process.env.SCYLLA_PORT || 9042,
        keyspace: process.env.SCYLLA_KEYSPACE || 'default_keyspace',
        username: process.env.SCYLLA_USERNAME || '',
        password: process.env.SCYLLA_PASSWORD || '',
    },
    env: process.env.NODE_ENV || 'development',
};

export default config;