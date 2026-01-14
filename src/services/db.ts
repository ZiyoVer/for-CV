import Database from 'better-sqlite3';
import { config } from '../config';

const db = new Database(config.DB_PATH);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

// Initialize Tables
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        telegram_id INTEGER PRIMARY KEY,
        full_name TEXT,
        is_admin INTEGER DEFAULT 0, -- 0 or 1
        is_active INTEGER DEFAULT 1,
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS files (
        file_key TEXT PRIMARY KEY,
        status TEXT DEFAULT 'PENDING', -- PENDING, LOCKED, ACCEPTED, REJECTED
        assigned_to INTEGER, -- User ID
        locked_at DATETIME,
        processed_at DATETIME,
        processing_duration_sec INTEGER
    );
`);

export const dbService = {
    // --- USER MANAGEMENT ---
    getUser: (telegram_id: number) => {
        return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegram_id) as any;
    },

    addUser: (telegram_id: number, full_name: string, is_admin = 0) => {
        const stmt = db.prepare('INSERT OR IGNORE INTO users (telegram_id, full_name, is_admin) VALUES (?, ?, ?)');
        stmt.run(telegram_id, full_name, is_admin);
    },

    listAdmins: () => {
        return db.prepare('SELECT telegram_id FROM users WHERE is_admin = 1').all() as { telegram_id: number }[];
    },

    // --- FILE LOCKING LOGIC ---

    // Finds a PENDING file, locks it for the user
    lockNextFile: (user_id: number): string | null => {
        // First check if user already has a locked file
        const existing = db.prepare('SELECT file_key FROM files WHERE status = "LOCKED" AND assigned_to = ?').get(user_id) as { file_key: string } | undefined;
        if (existing) return existing.file_key;

        // Transaction to ensuring atomicity
        const lockParams = { user_id, now: new Date().toISOString() };

        let fileKey: string | null = null;

        const transaction = db.transaction(() => {
            const file = db.prepare('SELECT file_key FROM files WHERE status = "PENDING" LIMIT 1').get() as { file_key: string } | undefined;

            if (file) {
                db.prepare(`
                    UPDATE files 
                    SET status = 'LOCKED', assigned_to = @user_id, locked_at = @now 
                    WHERE file_key = '${file.file_key}'
                `).run(lockParams);
                fileKey = file.file_key;
            }
        });

        transaction();
        return fileKey;
    },

    // Updates status (Accepted/Rejected)
    updateFileStatus: (user_id: number, file_key: string, status: 'ACCEPTED' | 'REJECTED') => {
        const now = new Date().toISOString();
        db.prepare(`
            UPDATE files 
            SET status = ?, processed_at = ?, processing_duration_sec = (strftime('%s', ?) - strftime('%s', locked_at))
            WHERE file_key = ? AND assigned_to = ?
        `).run(status, now, now, file_key, user_id);
    },

    // Bulk insert files (for syncing from S3)
    addFile: (key: string) => {
        db.prepare('INSERT OR IGNORE INTO files (file_key) VALUES (?)').run(key);
    },

    getPendingCount: () => {
        return (db.prepare('SELECT COUNT(*) as count FROM files WHERE status = "PENDING"').get() as any).count;
    },

    // --- STATISTICS ---
    getUserStats: (user_id: number) => {
        return db.prepare(`
            SELECT 
                COUNT(*) filter (where status = 'ACCEPTED') as accepted,
                COUNT(*) filter (where status = 'REJECTED') as rejected
            FROM files WHERE assigned_to = ? AND status IN ('ACCEPTED', 'REJECTED')
        `).get(user_id) as any;
    },

    getAllUserStats: () => {
        return db.prepare(`
            SELECT 
                u.full_name,
                COUNT(f.file_key) as total_processed,
                SUM(CASE WHEN f.status = 'ACCEPTED' THEN 1 ELSE 0 END) as accepted_count,
                 SUM(CASE WHEN f.status = 'REJECTED' THEN 1 ELSE 0 END) as rejected_count
            FROM users u
            LEFT JOIN files f ON u.telegram_id = f.assigned_to
            WHERE f.status IN ('ACCEPTED', 'REJECTED')
            GROUP BY u.telegram_id
            ORDER BY accepted_count DESC
        `).all();
    },

    releaseTimedOutFiles: (timeoutMs: number) => {
        // Calculate cutoff time
        const cutoff = new Date(Date.now() - timeoutMs).toISOString();
        const result = db.prepare(`
            UPDATE files 
            SET status = 'PENDING', assigned_to = NULL, locked_at = NULL 
            WHERE status = 'LOCKED' AND locked_at < ?
        `).run(cutoff);
        return result.changes;
    }
};

// Bootstrap Admins from config
config.ADMIN_IDS.forEach(id => {
    dbService.addUser(id, "Admin", 1);
});
