import dotenv from 'dotenv';
dotenv.config();

export const config = {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
    WASABI_ENDPOINT: process.env.WASABI_ENDPOINT || 'https://s3.eu-central-2.wasabisys.com',
    WASABI_REGION: process.env.WASABI_REGION || 'eu-central-2',
    WASABI_ACCESS_KEY: process.env.WASABI_ACCESS_KEY || '',
    WASABI_SECRET_KEY: process.env.WASABI_SECRET_KEY || '',
    WASABI_BUCKET: process.env.WASABI_BUCKET || '',

    // Admins who can add other users (comma separated)
    ADMIN_IDS: (process.env.ADMIN_IDS || '').split(',').map(id => Number(id.trim())).filter(id => !isNaN(id)),

    // PostgreSQL connection
    DATABASE_URL: process.env.DATABASE_URL,
    PGHOST: process.env.PGHOST || 'localhost',
    PGPORT: Number(process.env.PGPORT) || 5432,
    PGUSER: process.env.PGUSER || '',
    PGPASSWORD: process.env.PGPASSWORD || '',
    PGDATABASE: process.env.PGDATABASE || '',
    PGSSL: ['true', '1'].includes((process.env.PGSSL || '').toLowerCase()),

    // Timeout for locked files (e.g. 30 mins)
    LOCK_TIMEOUT_MS: 30 * 60 * 1000,

    // Web UI
    PORT: Number(process.env.PORT) || 3000,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin'
};

export const pgConfig = config.DATABASE_URL
    ? {
        connectionString: config.DATABASE_URL,
        ssl: config.PGSSL ? { rejectUnauthorized: false } : undefined
    }
    : {
        host: config.PGHOST,
        port: config.PGPORT,
        user: config.PGUSER,
        password: config.PGPASSWORD,
        database: config.PGDATABASE,
        ssl: config.PGSSL ? { rejectUnauthorized: false } : undefined
    };

if (!config.TELEGRAM_BOT_TOKEN) console.warn('Warning: TELEGRAM_BOT_TOKEN is missing');
if (!config.DATABASE_URL && (!config.PGUSER || !config.PGDATABASE)) console.warn('Warning: PostgreSQL connection details are missing');
