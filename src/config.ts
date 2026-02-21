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

    // Payment settings
    FREE_CHECKS_LIMIT: Number(process.env.FREE_CHECKS_LIMIT || '20'),
    CHECK_PRICE: Number(process.env.CHECK_PRICE || '30'), // so'm
    XORAZM_CHECK_PRICE: Number(process.env.XORAZM_CHECK_PRICE || '300'), // so'm

    // Timeouts and intervals
    LOCK_TIMEOUT_MS: Number(process.env.LOCK_TIMEOUT_MS || String(5 * 60 * 1000)), // 5 minutes
    SYNC_INTERVAL_MS: Number(process.env.SYNC_INTERVAL_MS || String(30 * 60 * 1000)), // 30 minutes

    // File upload limits
    MAX_UPLOAD_SIZE: Number(process.env.MAX_UPLOAD_SIZE || '52428800'), // 50MB
    MAX_FILES_PER_UPLOAD: Number(process.env.MAX_FILES_PER_UPLOAD || '100'),

    // Google Speech-to-Text API
    GOOGLE_SPEECH_API_KEY: process.env.GOOGLE_SPEECH_API_KEY || '',

    // Web UI
    PORT: Number(process.env.PORT) || 3000,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    SESSION_SECRET: process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'dev-secret-do-not-use-in-prod')
};

// Validate configuration
function validateConfig() {
    const isProduction = process.env.NODE_ENV === 'production';
    const errors: string[] = [];
    const warnings: string[] = [];

    // Critical checks - throw errors in production
    if (!config.TELEGRAM_BOT_TOKEN) {
        warnings.push('TELEGRAM_BOT_TOKEN is missing');
        if (isProduction) errors.push('TELEGRAM_BOT_TOKEN is required in production');
    }

    if (!config.WASABI_ACCESS_KEY || !config.WASABI_SECRET_KEY || !config.WASABI_BUCKET) {
        warnings.push('Wasabi S3 credentials are incomplete');
        if (isProduction) errors.push('Wasabi S3 credentials are required in production');
    }

    if (!config.DATABASE_URL && (!config.PGUSER || !config.PGDATABASE)) {
        warnings.push('PostgreSQL connection details are missing');
        if (isProduction) errors.push('PostgreSQL connection is required in production');
    }

    if (!config.ADMIN_PASSWORD) {
        if (isProduction) {
            errors.push('ADMIN_PASSWORD is required in production');
        } else {
            warnings.push('ADMIN_PASSWORD is missing. Using default "admin" for development');
            (config as any).ADMIN_PASSWORD = 'admin';
        }
    }

    if (!config.SESSION_SECRET || config.SESSION_SECRET === 'dev-secret-do-not-use-in-prod') {
        if (isProduction) {
            errors.push('SESSION_SECRET must be set in production (not default)');
        } else {
            warnings.push('SESSION_SECRET is using default value for development');
        }
    }

    // Log warnings
    warnings.forEach(msg => console.warn(`[CONFIG WARNING] ${msg}`));

    // Throw errors if any
    if (errors.length > 0) {
        throw new Error(`Configuration errors:\n${errors.map(e => `  - ${e}`).join('\n')}`);
    }
}

// Run validation
validateConfig();

// SSL configuration - only disable verification for custom CA or development
const getSslConfig = () => {
    if (!config.PGSSL) return undefined;

    // In production, prefer secure SSL
    if (process.env.NODE_ENV === 'production') {
        // Allow custom CA certificate if provided
        if (process.env.PGSSLROOTCERT) {
            return {
                rejectUnauthorized: true,
                ca: process.env.PGSSLROOTCERT
            };
        }
        // Use secure SSL by default in production
        return { rejectUnauthorized: true };
    }

    // In development, allow self-signed certificates
    return { rejectUnauthorized: false };
};

export const pgConfig = config.DATABASE_URL
    ? {
        connectionString: config.DATABASE_URL,
        ssl: getSslConfig()
    }
    : {
        host: config.PGHOST,
        port: config.PGPORT,
        user: config.PGUSER,
        password: config.PGPASSWORD,
        database: config.PGDATABASE,
        ssl: getSslConfig()
    };
