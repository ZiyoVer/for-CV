import { Pool, PoolClient } from 'pg';
import { config, pgConfig } from '../config';

const pool = new Pool(pgConfig);

const initTablesQuery = `
    CREATE TABLE IF NOT EXISTS users (
        telegram_id BIGINT PRIMARY KEY,
        full_name TEXT,
        is_admin INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        joined_at TIMESTAMPTZ DEFAULT NOW(),
        balance INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS files (
        file_key TEXT PRIMARY KEY,
        status TEXT DEFAULT 'PENDING',
        assigned_to BIGINT,
        locked_at TIMESTAMPTZ,
        processed_at TIMESTAMPTZ,
        processing_duration_sec INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
    CREATE INDEX IF NOT EXISTS idx_files_assigned ON files(assigned_to) WHERE assigned_to IS NOT NULL;

    CREATE TABLE IF NOT EXISTS transcription_files (
        file_key TEXT PRIMARY KEY,
        status TEXT DEFAULT 'PENDING',
        assigned_to BIGINT,
        locked_at TIMESTAMPTZ,
        processed_at TIMESTAMPTZ,
        transcribed_text TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_transcription_status ON transcription_files(status);
    CREATE INDEX IF NOT EXISTS idx_transcription_assigned ON transcription_files(assigned_to) WHERE assigned_to IS NOT NULL;
`;

const withTransaction = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

export const dbService = {
    init: async () => {
        await pool.query(initTablesQuery);

        // Migration: Add balance column if it doesn't exist (for existing databases)
        try {
            await pool.query(`
                ALTER TABLE users ADD COLUMN IF NOT EXISTS balance INTEGER DEFAULT 0;
            `);
        } catch (e) {
            // Column might already exist, ignore error
            console.log('Migration note: balance column check completed');
        }

        for (const adminId of config.ADMIN_IDS) {
            await pool.query(
                'INSERT INTO users (telegram_id, full_name, is_admin) VALUES ($1, $2, 1) ON CONFLICT (telegram_id) DO NOTHING',
                [adminId, 'Admin']
            );
        }
    },

    // --- USER MANAGEMENT ---
    getUser: async (telegram_id: number) => {
        const { rows } = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegram_id]);
        return rows[0];
    },

    addUser: async (telegram_id: number, full_name: string, is_admin = 0) => {
        await pool.query(
            'INSERT INTO users (telegram_id, full_name, is_admin) VALUES ($1, $2, $3) ON CONFLICT (telegram_id) DO NOTHING',
            [telegram_id, full_name, is_admin]
        );
    },

    listAdmins: async () => {
        const { rows } = await pool.query('SELECT telegram_id FROM users WHERE is_admin = 1');
        return rows as { telegram_id: number }[];
    },

    listUsers: async () => {
        const { rows } = await pool.query('SELECT * FROM users ORDER BY full_name');
        return rows;
    },

    updateUser: async (oldTelegramId: number, newTelegramId: number, fullName: string, isAdmin: number) => {
        // If telegram_id is changing, we need to update related files too
        if (oldTelegramId !== newTelegramId) {
            await pool.query(
                'UPDATE files SET assigned_to = $1 WHERE assigned_to = $2',
                [newTelegramId, oldTelegramId]
            );
        }
        await pool.query(
            'UPDATE users SET telegram_id = $1, full_name = $2, is_admin = $3 WHERE telegram_id = $4',
            [newTelegramId, fullName, isAdmin, oldTelegramId]
        );
    },

    deleteUser: async (telegramId: number) => {
        // First release any locked files
        await pool.query(
            'UPDATE files SET status = $1, assigned_to = NULL, locked_at = NULL WHERE assigned_to = $2 AND status = $3',
            ['PENDING', telegramId, 'LOCKED']
        );
        // Then delete user
        await pool.query('DELETE FROM users WHERE telegram_id = $1', [telegramId]);
    },

    // --- FINANCIAL / STATS LOGIC ---
    incrementBalance: async (user_id: number, amount: number) => {
        await pool.query('UPDATE users SET balance = balance + $1 WHERE telegram_id = $2', [amount, user_id]);
    },

    resetBalance: async (user_id: number) => {
        await pool.query('UPDATE users SET balance = 0 WHERE telegram_id = $1', [user_id]);
    },

    reduceBalanceByPercent: async (user_id: number, percent: number) => {
        // e.g. percent=50 -> balance = balance * 0.5
        // Use integer math carefully or cast. We'll verify it's integer result via floor logic if needed.
        // Or simply: balance = floor(balance * (100 - percent) / 100)
        const factor = (100 - percent) / 100;
        await pool.query('UPDATE users SET balance = FLOOR(balance * $1) WHERE telegram_id = $2', [factor, user_id]);
    },

    get24hCheckCount: async (user_id: number) => {
        const { rows } = await pool.query(
            `SELECT COUNT(*)::int as count 
             FROM files 
             WHERE assigned_to = $1 
               AND status IN ('ACCEPTED', 'REJECTED')
               AND processed_at > NOW() - INTERVAL '24 hours'`,
            [user_id]
        );
        return rows[0]?.count || 0;
    },

    getRandomReviewFiles: async (user_id: number, limit = 5) => {
        const { rows } = await pool.query(
            `SELECT * FROM files 
             WHERE assigned_to = $1 
               AND status = 'ACCEPTED' 
             ORDER BY RANDOM() 
             LIMIT $2`,
            [user_id, limit]
        );
        return rows;
    },

    // --- FILE LOCKING LOGIC ---
    lockNextFile: async (user_id: number): Promise<string | null> => {
        return withTransaction<string | null>(async (client) => {
            const existing = await client.query(
                'SELECT file_key FROM files WHERE status = $1 AND assigned_to = $2 LIMIT 1 FOR UPDATE',
                ['LOCKED', user_id]
            );
            if (existing.rowCount) return existing.rows[0].file_key;

            const pending = await client.query(
                'SELECT file_key FROM files WHERE status = $1 ORDER BY file_key LIMIT 1 FOR UPDATE SKIP LOCKED',
                ['PENDING']
            );
            if (!pending.rowCount) return null;

            const fileKey = pending.rows[0].file_key as string;
            await client.query(
                'UPDATE files SET status = $1, assigned_to = $2, locked_at = NOW() WHERE file_key = $3',
                ['LOCKED', user_id, fileKey]
            );
            return fileKey;
        });
    },

    updateFileStatus: async (user_id: number, file_key: string, status: 'ACCEPTED' | 'REJECTED') => {
        await pool.query(
            `UPDATE files
             SET status = $1,
                 processed_at = NOW(),
                 processing_duration_sec = EXTRACT(EPOCH FROM (NOW() - locked_at))::int
             WHERE file_key = $2 AND assigned_to = $3`,
            [status, file_key, user_id]
        );
    },

    // Release a file back to PENDING (for skip functionality)
    releaseFile: async (user_id: number, file_key: string) => {
        await pool.query(
            `UPDATE files
             SET status = 'PENDING', assigned_to = NULL, locked_at = NULL
             WHERE file_key = $1 AND assigned_to = $2`,
            [file_key, user_id]
        );
    },

    addFile: async (key: string) => {
        await pool.query('INSERT INTO files (file_key) VALUES ($1) ON CONFLICT (file_key) DO NOTHING', [key]);
    },

    getPendingCount: async () => {
        const { rows } = await pool.query('SELECT COUNT(*)::int as count FROM files WHERE status = $1', ['PENDING']);
        return rows[0]?.count || 0;
    },

    // --- STATISTICS ---
    getUserStats: async (user_id: number) => {
        const { rows } = await pool.query(
            `SELECT 
                COUNT(*) FILTER (WHERE status = 'ACCEPTED')::int AS accepted,
                COUNT(*) FILTER (WHERE status = 'REJECTED')::int AS rejected
             FROM files WHERE assigned_to = $1 AND status IN ('ACCEPTED', 'REJECTED')`,
            [user_id]
        );
        return rows[0] || { accepted: 0, rejected: 0 };
    },

    getAllUserStats: async () => {
        const { rows } = await pool.query(
            `SELECT 
                u.telegram_id,
                u.full_name,
                u.balance,
                COUNT(f.file_key)::int as total_processed,
                COALESCE(SUM(CASE WHEN f.status = 'ACCEPTED' THEN 1 ELSE 0 END), 0)::int as accepted_count,
                COALESCE(SUM(CASE WHEN f.status = 'REJECTED' THEN 1 ELSE 0 END), 0)::int as rejected_count
             FROM users u
             LEFT JOIN files f ON u.telegram_id = f.assigned_to AND f.status IN ('ACCEPTED', 'REJECTED')
             GROUP BY u.telegram_id, u.full_name, u.balance
             ORDER BY accepted_count DESC`
        );
        return rows;
    },

    releaseTimedOutFiles: async (timeoutMs: number) => {
        const cutoff = new Date(Date.now() - timeoutMs);
        const result = await pool.query(
            `UPDATE files 
             SET status = 'PENDING', assigned_to = NULL, locked_at = NULL 
             WHERE status = 'LOCKED' AND locked_at < $1`,
            [cutoff]
        );
        return result.rowCount;
    },

    // --- TRANSCRIPTION FUNCTIONS ---
    addTranscriptionFile: async (key: string) => {
        await pool.query('INSERT INTO transcription_files (file_key) VALUES ($1) ON CONFLICT (file_key) DO NOTHING', [key]);
    },

    getTranscriptionPendingCount: async () => {
        const { rows } = await pool.query('SELECT COUNT(*)::int as count FROM transcription_files WHERE status = $1', ['PENDING']);
        return rows[0]?.count || 0;
    },

    lockNextTranscriptionFile: async (user_id: number): Promise<string | null> => {
        return withTransaction<string | null>(async (client) => {
            // Check if user already has a locked file
            const existing = await client.query(
                'SELECT file_key FROM transcription_files WHERE status = $1 AND assigned_to = $2 LIMIT 1 FOR UPDATE',
                ['LOCKED', user_id]
            );
            if (existing.rowCount) return existing.rows[0].file_key;

            // Get next pending file
            const pending = await client.query(
                'SELECT file_key FROM transcription_files WHERE status = $1 ORDER BY file_key LIMIT 1 FOR UPDATE SKIP LOCKED',
                ['PENDING']
            );
            if (!pending.rowCount) return null;

            const fileKey = pending.rows[0].file_key as string;
            await client.query(
                'UPDATE transcription_files SET status = $1, assigned_to = $2, locked_at = NOW() WHERE file_key = $3',
                ['LOCKED', user_id, fileKey]
            );
            return fileKey;
        });
    },

    updateTranscriptionFileStatus: async (user_id: number, file_key: string, status: 'ACCEPTED' | 'REJECTED', transcribedText?: string) => {
        await pool.query(
            `UPDATE transcription_files
             SET status = $1,
                 processed_at = NOW(),
                 transcribed_text = $4
             WHERE file_key = $2 AND assigned_to = $3`,
            [status, file_key, user_id, transcribedText || null]
        );
    },

    releaseTranscriptionFile: async (user_id: number, file_key: string) => {
        await pool.query(
            `UPDATE transcription_files
             SET status = 'PENDING', assigned_to = NULL, locked_at = NULL
             WHERE file_key = $1 AND assigned_to = $2`,
            [file_key, user_id]
        );
    },

    getUserTranscriptionStats: async (user_id: number) => {
        const { rows } = await pool.query(
            `SELECT 
                COUNT(*) FILTER (WHERE status = 'ACCEPTED')::int AS accepted,
                COUNT(*) FILTER (WHERE status = 'REJECTED')::int AS rejected
             FROM transcription_files WHERE assigned_to = $1 AND status IN ('ACCEPTED', 'REJECTED')`,
            [user_id]
        );
        return rows[0] || { accepted: 0, rejected: 0 };
    },

    get24hTranscriptionCount: async (user_id: number) => {
        const { rows } = await pool.query(
            `SELECT COUNT(*)::int as count 
             FROM transcription_files 
             WHERE assigned_to = $1 
               AND status IN ('ACCEPTED', 'REJECTED')
               AND processed_at > NOW() - INTERVAL '24 hours'`,
            [user_id]
        );
        return rows[0]?.count || 0;
    },

    getAllTranscriptionStats: async () => {
        const { rows } = await pool.query(
            `SELECT 
                u.telegram_id,
                u.full_name,
                COUNT(tf.file_key)::int as total_processed,
                COALESCE(SUM(CASE WHEN tf.status = 'ACCEPTED' THEN 1 ELSE 0 END), 0)::int as accepted_count,
                COALESCE(SUM(CASE WHEN tf.status = 'REJECTED' THEN 1 ELSE 0 END), 0)::int as rejected_count
             FROM users u
             LEFT JOIN transcription_files tf ON u.telegram_id = tf.assigned_to AND tf.status IN ('ACCEPTED', 'REJECTED')
             GROUP BY u.telegram_id, u.full_name
             ORDER BY accepted_count DESC`
        );
        return rows;
    },

    releaseTimedOutTranscriptionFiles: async (timeoutMs: number) => {
        const cutoff = new Date(Date.now() - timeoutMs);
        const result = await pool.query(
            `UPDATE transcription_files 
             SET status = 'PENDING', assigned_to = NULL, locked_at = NULL 
             WHERE status = 'LOCKED' AND locked_at < $1`,
            [cutoff]
        );
        return result.rowCount;
    }
};
