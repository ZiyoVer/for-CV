import express from 'express';
import session from 'express-session';
import bodyParser from 'body-parser';
import multer from 'multer';
import path from 'path';
import { config } from './config';
import { dbService } from './services/db';
import { s3Service } from './services/s3';

// Configure multer for memory storage (for S3 upload)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
    fileFilter: (req, file, cb) => {
        // Only allow audio files
        if (file.mimetype.startsWith('audio/')) {
            cb(null, true);
        } else {
            cb(new Error('Faqat audio fayllar qabul qilinadi'));
        }
    }
});

const app = express();

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(session({
    secret: config.ADMIN_PASSWORD,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Auth middleware
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
    if ((req.session as any).isAdmin) {
        return next();
    }
    res.redirect('/login');
}

// Routes
app.get('/', (req, res) => res.redirect('/login'));

app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

app.post('/login', (req, res) => {
    const { password } = req.body;
    if (password === config.ADMIN_PASSWORD) {
        (req.session as any).isAdmin = true;
        res.redirect('/dashboard');
    } else {
        res.render('login', { error: 'Parol noto\'g\'ri' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

app.get('/dashboard', requireAuth, async (req, res) => {
    try {
        const users = await dbService.listUsers();

        // Get 24h stats for each user
        const usersWithStats = await Promise.all(users.map(async (user: any) => {
            const checksToday = await dbService.get24hCheckCount(user.telegram_id);
            const stats = await dbService.getUserStats(user.telegram_id);
            return {
                ...user,
                checks_today: checksToday,
                total_accepted: stats.accepted,
                total_rejected: stats.rejected
            };
        }));

        // Get total stats
        const pendingCount = await dbService.getPendingCount();
        const transcriptionPendingCount = await dbService.getTranscriptionPendingCount();
        const allStats = await dbService.getAllUserStats();
        const totalAccepted = allStats.reduce((sum: number, s: any) => sum + (s.accepted_count || 0), 0);
        const totalRejected = allStats.reduce((sum: number, s: any) => sum + (s.rejected_count || 0), 0);

        res.render('dashboard', {
            users: usersWithStats,
            stats: {
                pending: pendingCount,
                transcriptionPending: transcriptionPendingCount,
                totalAccepted,
                totalRejected,
                totalChecked: totalAccepted + totalRejected
            }
        });
    } catch (err) {
        console.error('Dashboard error:', err);
        res.status(500).send('Server xatosi');
    }
});

app.post('/users/add', requireAuth, async (req, res) => {
    const { telegram_id, full_name, is_admin } = req.body;
    try {
        await dbService.addUser(Number(telegram_id), full_name, is_admin ? 1 : 0);
        res.redirect('/dashboard');
    } catch (err) {
        console.error('Add user error:', err);
        res.redirect('/dashboard?error=add_failed');
    }
});

app.post('/users/payout/:id', requireAuth, async (req, res) => {
    const userId = Number(req.params.id);
    try {
        await dbService.resetBalance(userId);
        res.redirect('/dashboard');
    } catch (err) {
        console.error('Payout error:', err);
        res.redirect('/dashboard?error=payout_failed');
    }
});

// Add balance manually (for missed payments)
app.post('/users/add-balance/:id', requireAuth, async (req, res) => {
    const userId = Number(req.params.id);
    const amount = Number(req.body.amount) || 0;
    try {
        await dbService.incrementBalance(userId, amount);
        res.redirect('/dashboard');
    } catch (err) {
        console.error('Add balance error:', err);
        res.redirect('/dashboard?error=add_balance_failed');
    }
});

// Update user (change telegram_id, name, admin status)
app.post('/users/update/:id', requireAuth, async (req, res) => {
    const oldId = Number(req.params.id);
    const { telegram_id, full_name, is_admin } = req.body;
    try {
        await dbService.updateUser(
            oldId,
            Number(telegram_id),
            full_name,
            is_admin ? 1 : 0
        );
        res.redirect('/dashboard');
    } catch (err) {
        console.error('Update user error:', err);
        res.redirect('/dashboard?error=update_failed');
    }
});

// Delete user
app.post('/users/delete/:id', requireAuth, async (req, res) => {
    const userId = Number(req.params.id);
    try {
        await dbService.deleteUser(userId);
        res.redirect('/dashboard');
    } catch (err) {
        console.error('Delete user error:', err);
        res.redirect('/dashboard?error=delete_failed');
    }
});

app.get('/review/:id', requireAuth, async (req, res) => {
    const userId = Number(req.params.id);
    try {
        const user = await dbService.getUser(userId);
        const files = await dbService.getRandomReviewFiles(userId, 5);

        // Get JSON content and audio URL for each file
        const filesWithContent = await Promise.all(files.map(async (file: any) => {
            try {
                const json = await s3Service.getJsonContent(file.file_key);
                const audioUrl = await s3Service.getAudioUrl(file.file_key);
                return { ...file, text: json.text || 'Noma\'lum', audioUrl };
            } catch {
                return { ...file, text: 'Yuklab bo\'lmadi', audioUrl: null };
            }
        }));

        res.render('review', { user, files: filesWithContent });
    } catch (err) {
        console.error('Review error:', err);
        res.status(500).send('Server xatosi');
    }
});

app.post('/review/penalty/:id', requireAuth, async (req, res) => {
    const userId = Number(req.params.id);
    try {
        await dbService.reduceBalanceByPercent(userId, 50);
        res.redirect('/dashboard');
    } catch (err) {
        console.error('Penalty error:', err);
        res.redirect('/dashboard?error=penalty_failed');
    }
});

// ========== TRANSCRIPTION AUDIO UPLOAD ==========

// Upload transcription audio files
app.post('/transcription/upload', requireAuth, upload.array('audioFiles', 100), async (req, res) => {
    try {
        const files = req.files as Express.Multer.File[];
        if (!files || files.length === 0) {
            return res.redirect('/dashboard?error=no_files');
        }

        let uploadedCount = 0;
        for (const file of files) {
            // Generate unique filename
            const timestamp = Date.now();
            const cleanName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
            const filename = `${timestamp}_${cleanName}`;

            await s3Service.uploadTranscriptionAudio(file.buffer, filename);
            uploadedCount++;
        }

        console.log(`Uploaded ${uploadedCount} transcription audio files`);
        res.redirect(`/dashboard?success=uploaded_${uploadedCount}`);
    } catch (err) {
        console.error('Transcription upload error:', err);
        res.redirect('/dashboard?error=upload_failed');
    }
});

// API: Get transcription stats
app.get('/api/transcription-stats', requireAuth, async (req, res) => {
    try {
        const pendingCount = await dbService.getTranscriptionPendingCount();
        const allStats = await dbService.getAllTranscriptionStats();
        const totalAccepted = allStats.reduce((sum: number, s: any) => sum + (s.accepted_count || 0), 0);

        res.json({
            success: true,
            pending: pendingCount,
            totalAccepted,
            stats: allStats
        });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// ========== PUBLIC LEADERBOARD (For Team Members) ==========

// Public leaderboard page - no login required
app.get('/leaderboard', async (req, res) => {
    try {
        const allStats = await dbService.getAllUserStats();

        // Sort by accepted count (highest first)
        const leaderboard = allStats
            .filter((s: any) => s.accepted_count > 0 || s.rejected_count > 0)
            .sort((a: any, b: any) => (b.accepted_count || 0) - (a.accepted_count || 0))
            .map((s: any, index: number) => ({
                rank: index + 1,
                name: s.full_name || 'Noma\'lum',
                accepted: s.accepted_count || 0,
                rejected: s.rejected_count || 0,
                total: (s.accepted_count || 0) + (s.rejected_count || 0),
                balance: s.balance || 0
            }));

        res.render('leaderboard', { leaderboard });
    } catch (err) {
        console.error('Leaderboard error:', err);
        res.status(500).send('Server xatosi');
    }
});

// JSON API for live updates (polling every 5 seconds)
app.get('/api/leaderboard', async (req, res) => {
    try {
        const allStats = await dbService.getAllUserStats();

        const leaderboard = allStats
            .filter((s: any) => s.accepted_count > 0 || s.rejected_count > 0)
            .sort((a: any, b: any) => (b.accepted_count || 0) - (a.accepted_count || 0))
            .map((s: any, index: number) => ({
                rank: index + 1,
                name: s.full_name || 'Noma\'lum',
                accepted: s.accepted_count || 0,
                rejected: s.rejected_count || 0,
                total: (s.accepted_count || 0) + (s.rejected_count || 0),
                balance: s.balance || 0
            }));

        res.json({
            success: true,
            leaderboard,
            updatedAt: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

export function startServer() {
    const port = config.PORT;
    app.listen(port, () => {
        console.log(`Web server ishga tushdi: http://localhost:${port}`);
    });
}
