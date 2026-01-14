import { Pool, PoolClient } from 'pg';
import { config, pgConfig } from '../config';

const pool = new Pool(pgConfig);

const initTablesQuery = `
    CREATE TABLE IF NOT EXISTS users (
        telegram_id BIGINT PRIMARY KEY,
        full_name TEXT,
        is_admin INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        joined_at TIMESTAMPTZ DEFAULT NOW()
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
                u.full_name,
                COUNT(f.file_key)::int as total_processed,
                SUM(CASE WHEN f.status = 'ACCEPTED' THEN 1 ELSE 0 END)::int as accepted_count,
                SUM(CASE WHEN f.status = 'REJECTED' THEN 1 ELSE 0 END)::int as rejected_count
             FROM users u
             LEFT JOIN files f ON u.telegram_id = f.assigned_to
             WHERE f.status IN ('ACCEPTED', 'REJECTED')
             GROUP BY u.telegram_id
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
    }
};
