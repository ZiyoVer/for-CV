import { Pool, PoolClient } from 'pg';
import { config, pgConfig } from '../config';

const pool = new Pool(pgConfig);

const createUsersTable = `
    CREATE TABLE IF NOT EXISTS users (
        telegram_id BIGINT PRIMARY KEY,
        full_name TEXT,
        is_admin INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        joined_at TIMESTAMPTZ DEFAULT NOW(),
        balance INTEGER DEFAULT 0
    );
`;

const createFilesTable = `
    CREATE TABLE IF NOT EXISTS files (
        file_key TEXT PRIMARY KEY,
        status TEXT DEFAULT 'PENDING',
        assigned_to BIGINT,
        locked_at TIMESTAMPTZ,
        processed_at TIMESTAMPTZ,
        processing_duration_sec INTEGER,
        audio_duration_sec INTEGER,
        synced_at TIMESTAMPTZ,
        original_file_key TEXT,
        transcribed_text TEXT
    );
`;

const createTranscriptionFilesTable = `
    CREATE TABLE IF NOT EXISTS transcription_files (
        file_key TEXT PRIMARY KEY,
        status TEXT DEFAULT 'PENDING',
        assigned_to BIGINT,
        locked_at TIMESTAMPTZ,
        processed_at TIMESTAMPTZ,
        transcribed_text TEXT,
        audio_duration_sec INTEGER
    );
`;

const createXorazmFilesTable = `
    CREATE TABLE IF NOT EXISTS xorazm_files (
        id TEXT PRIMARY KEY,
        audio_path TEXT NOT NULL,
        original_text TEXT NOT NULL,
        edited_text TEXT,
        status TEXT DEFAULT 'PENDING',
        assigned_to BIGINT,
        locked_at TIMESTAMPTZ,
        processed_at TIMESTAMPTZ
    );
`;

const createBotStateTable = `
    CREATE TABLE IF NOT EXISTS bot_state (
        user_id BIGINT PRIMARY KEY,
        state_type TEXT NOT NULL,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );
`;

const createIndexes = `
    CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
    CREATE INDEX IF NOT EXISTS idx_files_assigned ON files(assigned_to) WHERE assigned_to IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_files_processed_at ON files(processed_at) WHERE processed_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_files_status_created ON files(status, locked_at);
    CREATE INDEX IF NOT EXISTS idx_files_locked_by ON files(assigned_to) WHERE assigned_to IS NOT NULL AND status = 'LOCKED';
    CREATE INDEX IF NOT EXISTS idx_files_synced ON files(synced_at) WHERE synced_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_transcription_status ON transcription_files(status);
    CREATE INDEX IF NOT EXISTS idx_transcription_assigned ON transcription_files(assigned_to) WHERE assigned_to IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_transcription_processed_at ON transcription_files(processed_at) WHERE processed_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_transcription_status_created ON transcription_files(status, locked_at);
    CREATE INDEX IF NOT EXISTS idx_transcription_locked_by ON transcription_files(assigned_to) WHERE assigned_to IS NOT NULL AND status = 'LOCKED';
    CREATE INDEX IF NOT EXISTS idx_xorazm_status ON xorazm_files(status);
    CREATE INDEX IF NOT EXISTS idx_xorazm_assigned ON xorazm_files(assigned_to) WHERE assigned_to IS NOT NULL;
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
        // Create tables one by one
        const tables = [
            { name: 'users', query: createUsersTable },
            { name: 'files', query: createFilesTable },
            { name: 'transcription_files', query: createTranscriptionFilesTable },
            { name: 'xorazm_files', query: createXorazmFilesTable },
            { name: 'bot_state', query: createBotStateTable }
        ];

        for (const table of tables) {
            try {
                await pool.query(table.query);
                console.log(`Table ${table.name} created or already exists`);
            } catch (e: any) {
                console.error(`Error creating table ${table.name}:`, e.message);
                throw e;
            }
        }

        // Create indexes
        try {
            await pool.query(createIndexes);
            console.log('Indexes created');
        } catch (e: any) {
            console.error('Error creating indexes:', e.message);
        }

        // Migration: Add columns if they don't exist (one at a time for safety)
        const migrations = [
            { table: 'users', column: 'balance', type: 'INTEGER DEFAULT 0' },
            { table: 'files', column: 'audio_duration_sec', type: 'INTEGER' },
            { table: 'transcription_files', column: 'audio_duration_sec', type: 'INTEGER' },
            { table: 'files', column: 'synced_at', type: 'TIMESTAMPTZ' },
            { table: 'files', column: 'original_file_key', type: 'TEXT' },
            { table: 'files', column: 'transcribed_text', type: 'TEXT' }
        ];

        for (const migration of migrations) {
            try {
                await pool.query(`
                    ALTER TABLE ${migration.table} 
                    ADD COLUMN IF NOT EXISTS ${migration.column} ${migration.type}
                `);
                console.log(`Column ${migration.column} added to ${migration.table}`);
            } catch (e: any) {
                console.log(`Migration note for ${migration.table}.${migration.column}: ${e.message}`);
            }
        }

        // Insert default admins
        for (const adminId of config.ADMIN_IDS) {
            try {
                await pool.query(
                    'INSERT INTO users (telegram_id, full_name, is_admin) VALUES ($1, $2, 1) ON CONFLICT (telegram_id) DO NOTHING',
                    [adminId, 'Admin']
                );
                console.log(`Admin ${adminId} added`);
            } catch (e) {
                console.log(`Admin insert note for ${adminId}`);
            }
        }
    },

    // --- USER MANAGEMENT ---
    getUser: async (telegram_id: number) => {
        const { rows } = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegram_id]);
        return rows[0];
    },

    addUser: async (telegram_id: number, full_name: string, is_admin = 0) => {
        console.log('DB addUser called:', { telegram_id, full_name, is_admin });
        const result = await pool.query(
            `INSERT INTO users (telegram_id, full_name, is_admin) 
             VALUES ($1, $2, $3) 
             ON CONFLICT (telegram_id) DO UPDATE 
             SET full_name = EXCLUDED.full_name, 
                 is_admin = EXCLUDED.is_admin
             RETURNING *`,
            [telegram_id, full_name, is_admin]
        );
        console.log('DB addUser result:', result.rows[0]);
        return result.rows[0];
    },

    listAdmins: async () => {
        const { rows } = await pool.query('SELECT telegram_id FROM users WHERE is_admin = 1');
        return rows as { telegram_id: number }[];
    },

    listUsers: async () => {
        const { rows } = await pool.query('SELECT * FROM users ORDER BY full_name');
        return rows;
    },

    // Check if file exists in files table
    checkFileExists: async (fileKey: string): Promise<boolean> => {
        const { rows } = await pool.query(
            'SELECT file_key FROM files WHERE file_key = $1 LIMIT 1',
            [fileKey]
        );
        return rows.length > 0;
    },

    // Check if file exists in transcription_files table
    checkTranscriptionFileExists: async (fileKey: string): Promise<boolean> => {
        const { rows } = await pool.query(
            'SELECT file_key FROM transcription_files WHERE file_key = $1 LIMIT 1',
            [fileKey]
        );
        return rows.length > 0;
    },

    // Optimized Dashboard Query (N+1 Fix)
    getDashboardUsers: async () => {
        const { rows } = await pool.query(`
            SELECT 
                u.telegram_id,
                u.full_name,
                u.is_admin,
                u.balance,
                u.joined_at,
                (
                    SELECT COUNT(*)::int 
                    FROM files f2
                    WHERE f2.assigned_to = u.telegram_id 
                      AND f2.status IN ('ACCEPTED', 'REJECTED')
                      AND f2.processed_at > NOW() - INTERVAL '24 hours'
                ) as checks_today,
                COUNT(f.file_key) FILTER (WHERE f.status = 'ACCEPTED')::int as total_accepted,
                COUNT(f.file_key) FILTER (WHERE f.status = 'REJECTED')::int as total_rejected
            FROM users u
            LEFT JOIN files f ON u.telegram_id = f.assigned_to AND f.status IN ('ACCEPTED', 'REJECTED')
            GROUP BY u.telegram_id
            ORDER BY u.full_name
        `);
        return rows;
    },

    updateUser: async (oldTelegramId: number, newTelegramId: number, fullName: string, isAdmin: number) => {
        // If telegram_id is changing, we need to update related files too
        if (oldTelegramId !== newTelegramId) {
            await pool.query(
                'UPDATE files SET assigned_to = $1 WHERE assigned_to = $2',
                [newTelegramId, oldTelegramId]
            );
            await pool.query(
                'UPDATE transcription_files SET assigned_to = $1 WHERE assigned_to = $2',
                [newTelegramId, oldTelegramId]
            );
            await pool.query(
                'UPDATE xorazm_files SET assigned_to = $1 WHERE assigned_to = $2',
                [newTelegramId, oldTelegramId]
            );
        }
        await pool.query(
            'UPDATE users SET telegram_id = $1, full_name = $2, is_admin = $3 WHERE telegram_id = $4',
            [newTelegramId, fullName, isAdmin, oldTelegramId]
        );
    },

    deleteUser: async (telegramId: number): Promise<void> => {
        return withTransaction<void>(async (client) => {
            // Only release LOCKED files back to PENDING (not ACCEPTED/REJECTED - those are done)
            await client.query(
                `UPDATE files
                 SET status = 'PENDING', assigned_to = NULL, locked_at = NULL
                 WHERE assigned_to = $1 AND status = 'LOCKED'`,
                [telegramId]
            );

            // Same for transcription_files - only release LOCKED
            await client.query(
                `UPDATE transcription_files
                 SET status = 'PENDING', assigned_to = NULL, locked_at = NULL
                 WHERE assigned_to = $1 AND status = 'LOCKED'`,
                [telegramId]
            );

            // Same for xorazm_files - only release LOCKED
            await client.query(
                `UPDATE xorazm_files
                 SET status = 'PENDING', assigned_to = NULL, locked_at = NULL
                 WHERE assigned_to = $1 AND status = 'LOCKED'`,
                [telegramId]
            );

            // Delete user
            await client.query('DELETE FROM users WHERE telegram_id = $1', [telegramId]);
        });
    },

    // --- FINANCIAL / STATS LOGIC ---
    incrementBalance: async (user_id: number, amount: number) => {
        await pool.query('UPDATE users SET balance = balance + $1 WHERE telegram_id = $2', [amount, user_id]);
    },

    resetBalance: async (user_id: number) => {
        await pool.query('UPDATE users SET balance = 0 WHERE telegram_id = $1', [user_id]);
    },

    reduceBalanceByPercent: async (user_id: number, percent: number) => {
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

    updateFileStatus: async (user_id: number, file_key: string, status: 'ACCEPTED' | 'REJECTED', transcribedText?: string) => {
        await pool.query(
            `UPDATE files
             SET status = $1,
                 processed_at = NOW(),
                 processing_duration_sec = EXTRACT(EPOCH FROM (NOW() - locked_at))::int,
                 transcribed_text = COALESCE($4, transcribed_text)
             WHERE file_key = $2 AND assigned_to = $3`,
            [status, file_key, user_id, transcribedText || null]
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

    // Mark file as synced from S3
    markFileSynced: async (file_key: string) => {
        await pool.query(
            'UPDATE files SET synced_at = NOW() WHERE file_key = $1',
            [file_key]
        );
    },

    // Update file copy information
    updateFileCopyInfo: async (originalKey: string, copiedToKey: string, transcribedText?: string) => {
        await pool.query(
            `UPDATE files 
             SET original_file_key = $2,
                 transcribed_text = COALESCE($3, transcribed_text),
                 processed_at = COALESCE(processed_at, NOW())
             WHERE file_key = $1`,
            [originalKey, copiedToKey, transcribedText || null]
        );
    },

    // Add file with sync tracking
    addFile: async (key: string, duration?: number) => {
        await pool.query(
            `INSERT INTO files (file_key, audio_duration_sec, synced_at) 
             VALUES ($1, $2, NOW()) 
             ON CONFLICT (file_key) DO UPDATE 
             SET synced_at = COALESCE(files.synced_at, NOW()),
                 audio_duration_sec = COALESCE(files.audio_duration_sec, EXCLUDED.audio_duration_sec)`,
            [key, duration || null]
        );
    },

    getPendingCount: async () => {
        const { rows } = await pool.query('SELECT COUNT(*)::int as count FROM files WHERE status = $1', ['PENDING']);
        return rows[0]?.count || 0;
    },

    // Clear all PENDING files from database (for fresh start)
    clearAllPendingFiles: async () => {
        const result = await pool.query('DELETE FROM files WHERE status = $1', ['PENDING']);
        return result.rowCount || 0;
    },

    // Clear all PENDING transcription files from database
    clearAllPendingTranscriptionFiles: async () => {
        const result = await pool.query('DELETE FROM transcription_files WHERE status = $1', ['PENDING']);
        return result.rowCount || 0;
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
    addTranscriptionFile: async (key: string, duration?: number) => {
        await pool.query(
            'INSERT INTO transcription_files (file_key, audio_duration_sec) VALUES ($1, $2) ON CONFLICT (file_key) DO UPDATE SET audio_duration_sec = COALESCE(transcription_files.audio_duration_sec, EXCLUDED.audio_duration_sec)',
            [key, duration || null]
        );
    },

    getTranscriptionPendingCount: async () => {
        const { rows } = await pool.query('SELECT COUNT(*)::int as count FROM transcription_files WHERE status = $1', ['PENDING']);
        return rows[0]?.count || 0;
    },

    lockNextTranscriptionFile: async (user_id: number): Promise<string | null> => {
        return withTransaction<string | null>(async (client) => {
            const existing = await client.query(
                'SELECT file_key FROM transcription_files WHERE status = $1 AND assigned_to = $2 LIMIT 1 FOR UPDATE',
                ['LOCKED', user_id]
            );
            if (existing.rowCount) return existing.rows[0].file_key;

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
    },

    // Get hourly statistics for the last 24 hours grouped by user
    get24hHourlyStats: async () => {
        const { rows } = await pool.query(
            `SELECT 
                u.full_name,
                u.telegram_id,
                DATE_TRUNC('hour', f.processed_at) as hour,
                COUNT(*)::int as count
             FROM files f
             JOIN users u ON f.assigned_to = u.telegram_id
             WHERE f.status IN ('ACCEPTED', 'REJECTED')
               AND f.processed_at > NOW() - INTERVAL '24 hours'
               GROUP BY u.full_name, u.telegram_id, DATE_TRUNC('hour', f.processed_at)
               ORDER BY hour ASC`
        );
        return rows;
    },

    getDurationStats: async () => {
        const { rows } = await pool.query(
            `SELECT 
                status,
                SUM(COALESCE(audio_duration_sec, 0))::bigint as total_seconds
             FROM files
             GROUP BY status`
        );
        return rows;
    },

    getLifetimeDailyStats: async () => {
        const { rows } = await pool.query(
            `SELECT 
                DATE_TRUNC('day', processed_at) as day,
                COUNT(*) FILTER (WHERE status = 'ACCEPTED')::int as accepted,
                COUNT(*) FILTER (WHERE status = 'REJECTED')::int as rejected
             FROM files
             WHERE status IN ('ACCEPTED', 'REJECTED')
               AND processed_at > NOW() - INTERVAL '30 days'
             GROUP BY DATE_TRUNC('day', processed_at)
             ORDER BY day ASC`
        );
        return rows;
    },

    // --- BOT STATE PERSISTENCE ---
    saveState: async (user_id: number, state_type: string, data: any) => {
        await pool.query(
            `INSERT INTO bot_state (user_id, state_type, data, updated_at) 
             VALUES ($1, $2, $3, NOW()) 
             ON CONFLICT (user_id) 
             DO UPDATE SET state_type = $2, data = $3, updated_at = NOW()`,
            [user_id, state_type, JSON.stringify(data)]
        );
    },

    getState: async (user_id: number) => {
        const { rows } = await pool.query('SELECT * FROM bot_state WHERE user_id = $1', [user_id]);
        return rows[0];
    },

    deleteState: async (user_id: number) => {
        await pool.query('DELETE FROM bot_state WHERE user_id = $1', [user_id]);
    },

    // --- XORAZM DIALECT FUNCTIONS ---

    initXorazmFiles: async (entries: Array<{ id: string, audio: string, text: string }>) => {
        let added = 0;
        for (const entry of entries) {
            try {
                const result = await pool.query(
                    `INSERT INTO xorazm_files (id, audio_path, original_text) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
                    [entry.id, entry.audio, entry.text]
                );
                if (result.rowCount && result.rowCount > 0) added++;
            } catch (e) {
                // skip duplicates
            }
        }
        return added;
    },

    getXorazmPendingCount: async () => {
        const { rows } = await pool.query(`SELECT COUNT(*)::int as count FROM xorazm_files WHERE status = 'PENDING'`);
        return rows[0]?.count || 0;
    },

    lockNextXorazmFile: async (user_id: number) => {
        return withTransaction(async (client) => {
            // First release any timed-out locks for this user
            await client.query(
                `UPDATE xorazm_files SET status = 'PENDING', assigned_to = NULL, locked_at = NULL WHERE assigned_to = $1 AND status = 'LOCKED'`,
                [user_id]
            );

            // Lock next available file
            const { rows } = await client.query(
                `UPDATE xorazm_files SET status = 'LOCKED', assigned_to = $1, locked_at = NOW()
                 WHERE id = (
                     SELECT id FROM xorazm_files
                     WHERE status = 'PENDING'
                     ORDER BY id ASC
                     LIMIT 1
                     FOR UPDATE SKIP LOCKED
                 )
                 RETURNING *`,
                [user_id]
            );
            return rows[0] || null;
        });
    },

    updateXorazmFileStatus: async (user_id: number, id: string, status: 'ACCEPTED' | 'REJECTED', editedText?: string) => {
        await pool.query(
            `UPDATE xorazm_files SET status = $3, processed_at = NOW(), edited_text = COALESCE($4, edited_text)
             WHERE id = $2 AND assigned_to = $1`,
            [user_id, id, status, editedText || null]
        );
    },

    updateXorazmText: async (id: string, editedText: string) => {
        await pool.query(
            `UPDATE xorazm_files SET edited_text = $2 WHERE id = $1`,
            [id, editedText]
        );
    },

    releaseXorazmFile: async (user_id: number, id: string) => {
        await pool.query(
            `UPDATE xorazm_files SET status = 'PENDING', assigned_to = NULL, locked_at = NULL
             WHERE id = $2 AND assigned_to = $1 AND status = 'LOCKED'`,
            [user_id, id]
        );
    },

    getUserXorazmStats: async (user_id: number) => {
        const { rows } = await pool.query(
            `SELECT 
                COUNT(*) FILTER (WHERE status = 'ACCEPTED')::int AS accepted,
                COUNT(*) FILTER (WHERE status = 'REJECTED')::int AS rejected
             FROM xorazm_files WHERE assigned_to = $1 AND status IN ('ACCEPTED', 'REJECTED')`,
            [user_id]
        );
        return rows[0] || { accepted: 0, rejected: 0 };
    },

    getAllXorazmStats: async () => {
        const { rows } = await pool.query(
            `SELECT 
                u.telegram_id,
                u.full_name,
                COUNT(xf.id)::int as total_processed,
                COALESCE(SUM(CASE WHEN xf.status = 'ACCEPTED' THEN 1 ELSE 0 END), 0)::int as accepted_count,
                COALESCE(SUM(CASE WHEN xf.status = 'REJECTED' THEN 1 ELSE 0 END), 0)::int as rejected_count
             FROM users u
             LEFT JOIN xorazm_files xf ON u.telegram_id = xf.assigned_to AND xf.status IN ('ACCEPTED', 'REJECTED')
             GROUP BY u.telegram_id, u.full_name
             ORDER BY accepted_count DESC`
        );
        return rows;
    },

    releaseTimedOutXorazmFiles: async (timeoutMs: number) => {
        const cutoff = new Date(Date.now() - timeoutMs);
        const result = await pool.query(
            `UPDATE xorazm_files 
             SET status = 'PENDING', assigned_to = NULL, locked_at = NULL 
             WHERE status = 'LOCKED' AND locked_at < $1`,
            [cutoff]
        );
        return result.rowCount;
    },

    // --- CLEANUP ---
    close: async () => {
        await pool.end();
        console.log('Database pool closed');
    }
};
