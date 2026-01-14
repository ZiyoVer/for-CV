import dotenv from 'dotenv';
dotenv.config();

export const config = {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
    WASABI_ENDPOINT: 'https://s3.wasabisys.com',
    WASABI_REGION: 'us-east-1',
    WASABI_ACCESS_KEY: process.env.WASABI_ACCESS_KEY || '',
    WASABI_SECRET_KEY: process.env.WASABI_SECRET_KEY || '',
    WASABI_BUCKET: process.env.WASABI_BUCKET || '',

    // Admins who can add other users (comma separated)
    ADMIN_IDS: (process.env.ADMIN_IDS || '').split(',').map(id => Number(id.trim())).filter(id => !isNaN(id)),

    DB_PATH: process.env.DB_PATH || 'stt_bot.db',

    // Timeout for locked files (e.g. 30 mins)
    LOCK_TIMEOUT_MS: 30 * 60 * 1000
};

if (!config.TELEGRAM_BOT_TOKEN) console.warn('Warning: TELEGRAM_BOT_TOKEN is missing');
