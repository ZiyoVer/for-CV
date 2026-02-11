import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import csrf from 'csurf';
import crypto from 'crypto';
import path from 'path';
import connectPgSimple from 'connect-pg-simple';
import { Pool } from 'pg';
import { config, pgConfig } from './config';
import { dbService } from './services/db';
import { s3Service } from './services/s3';

// PostgreSQL session store
const PgSession = connectPgSimple(session);
const sessionPool = new Pool(pgConfig);

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

// Trust proxy (required for secure cookies behind Railway/Nginx load balancer)
app.set('trust proxy', 1);

// Security Middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://unpkg.com"],
            scriptSrcAttr: ["'unsafe-inline'"], // Allow inline onclick handlers
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "https://*"],
            mediaSrc: ["'self'", "https://*"], // Allow audio from S3
            connectSrc: ["'self'", "https://cdn.jsdelivr.net"], // Allow Chart.js source map
        },
    },
}));

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(cookieParser()); // Required for CSRF with cookies
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    store: new PgSession({
        pool: sessionPool,
        tableName: 'user_sessions',
        createTableIfMissing: true,
        pruneSessionInterval: 60 * 15, // Prune expired sessions every 15 min
    }),
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 60 * 60 * 1000, // 1 hour
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax'
    },
    rolling: true
}));

// CSRF Protection (must come after session and body parser)
const csrfProtection = csrf({
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production'
    }
});

// Apply CSRF protection globally to all routes that need it
app.use(csrfProtection);

// Make CSRF token available to all views
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.locals.csrfToken = req.csrfToken();
    next();
});

// Rate limiting for login
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // Limit each IP to 10 login attempts per window
    message: 'Juda ko\'p urinish. 15 daqiqadan keyin qayta urinib ko\'ring.',
    standardHeaders: true,
    legacyHeaders: false,
});

// General API rate limiter
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per window
    standardHeaders: true,
    legacyHeaders: false,
});

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

app.post('/login', loginLimiter, (req, res) => {
    const { password } = req.body;
    // Timing-safe comparison to prevent timing attacks
    const inputBuf = Buffer.from(String(password || ''));
    const correctBuf = Buffer.from(String(config.ADMIN_PASSWORD || ''));
    const isValid = inputBuf.length === correctBuf.length &&
        crypto.timingSafeEqual(inputBuf, correctBuf);
    if (isValid) {
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

// API: Sync STT files from S3 (for dashboard sync button)
app.post('/api/sync', requireAuth, async (req, res) => {
    try {
        console.log('Manual STT sync triggered from dashboard...');
        await s3Service.syncFiles();
        const pendingCount = await dbService.getPendingCount();
        console.log(`Manual sync completed. Pending files: ${pendingCount}`);
        res.json({ success: true, pending: pendingCount });
    } catch (err: any) {
        console.error('Sync error:', err);
        res.json({ success: false, error: err.message });
    }
});

app.get('/dashboard', requireAuth, async (req, res) => {
    try {
        // OPTIMIZED: Get all user stats in one query
        const usersWithStats = await dbService.getDashboardUsers();

        // Get total counts
        const pendingCount = await dbService.getPendingCount();
        const transcriptionPendingCount = await dbService.getTranscriptionPendingCount();
        const allStats = await dbService.getAllUserStats();
        const totalAccepted = allStats.reduce((sum: number, s: any) => sum + (s.accepted_count || 0), 0);
        const totalRejected = allStats.reduce((sum: number, s: any) => sum + (s.rejected_count || 0), 0);

        // Get duration stats
        const durationStats = await dbService.getDurationStats();
        const durationByStatus: Record<string, number> = {};
        durationStats.forEach((s: any) => {
            durationByStatus[s.status] = Number(s.total_seconds) || 0;
        });

        const acceptedDuration = durationByStatus['ACCEPTED'] || 0;
        const rejectedDuration = durationByStatus['REJECTED'] || 0;
        const pendingDuration = durationByStatus['PENDING'] || 0;

        const formatDuration = (sec: number) => {
            const hours = Math.floor(sec / 3600);
            const minutes = Math.floor((sec % 3600) / 60);
            return `${hours}s ${minutes}m`;
        };

        // Get Chart Data (Simple aggregation for the main line chart)
        const hourlyStats = await dbService.get24hHourlyStats();
        // Aggregate by hour (ignore user breakdown for the main dashboard chart)
        const hourlyMap = new Map<string, number>();
        hourlyStats.forEach((s: any) => {
            const h = new Date(s.hour).toISOString();
            hourlyMap.set(h, (hourlyMap.get(h) || 0) + Number(s.count));
        });

        const chartData = Array.from(hourlyMap.entries())
            .map(([hour, count]) => ({ hour, count }))
            .sort((a, b) => a.hour.localeCompare(b.hour));

        // Get Lifetime Stats (Daily) for the new chart
        const lifetimeStats = await dbService.getLifetimeDailyStats();

        // Get Transcription Stats
        const transStats = await dbService.getAllTranscriptionStats();
        const transAccepted = transStats.reduce((sum: number, s: any) => sum + (s.accepted_count || 0), 0);
        const transRejected = transStats.reduce((sum: number, s: any) => sum + (s.rejected_count || 0), 0);

        // Xorazm stats
        const xorazmPending = await dbService.getXorazmPendingCount();
        const xorazmStats = await dbService.getAllXorazmStats();
        const xorazmAccepted = xorazmStats.reduce((sum: number, s: any) => sum + (s.accepted_count || 0), 0);
        const xorazmRejected = xorazmStats.reduce((sum: number, s: any) => sum + (s.rejected_count || 0), 0);

        // Parse query params for alerts
        const query: any = {};
        if (req.query.success) query.success = req.query.success;
        if (req.query.error) query.error = req.query.error;

        res.render('dashboard', {
            users: usersWithStats,
            chartData,
            lifetimeStats,
            transStats,
            xorazmStats,
            stats: {
                pending: pendingCount,
                transcriptionPending: transcriptionPendingCount,
                xorazmPending,
                totalAccepted,
                totalRejected,
                totalChecked: totalAccepted + totalRejected,
                acceptedDuration: formatDuration(acceptedDuration),
                rejectedDuration: formatDuration(rejectedDuration),
                pendingDuration: formatDuration(pendingDuration),
                transAccepted,
                transRejected,
                transTotal: transAccepted + transRejected,
                xorazmAccepted,
                xorazmRejected,
                xorazmTotal: xorazmAccepted + xorazmRejected
            },
            query
        });
    } catch (err: any) {
        console.error('Dashboard error:', err);
        res.status(500).send('Server xatosi yuz berdi.');
    }
});

// Redirect old dashboard-simple to dashboard
app.get('/dashboard-simple', requireAuth, (req, res) => {
    res.redirect('/dashboard');
});


app.post('/users/add', requireAuth, async (req, res) => {
    const { telegram_id, full_name, is_admin } = req.body;
    console.log('Add user request:', { telegram_id, full_name, is_admin });
    try {
        if (!telegram_id || !full_name) {
            throw new Error('Telegram ID va ism kiritilishi shart');
        }
        await dbService.addUser(Number(telegram_id), full_name, is_admin ? 1 : 0);
        console.log('User added successfully');
        res.redirect('/dashboard?success=user_added');
    } catch (err: any) {
        console.error('Add user error:', err);
        res.redirect(`/dashboard?error=add_failed&message=${encodeURIComponent(err.message)}`);
    }
});

app.post('/users/payout/:id', requireAuth, async (req, res) => {
    const userId = Number(req.params.id);
    try {
        await dbService.resetBalance(userId);
        res.redirect('/dashboard?success=payout_complete');
    } catch (err) {
        console.error('Payout error:', err);
        res.redirect('/dashboard?error=payout_failed');
    }
});

// Add balance manually (for missed payments)
app.post('/users/add-balance/:id', requireAuth, async (req, res) => {
    const userId = Number(req.params.id);
    const amount = Number(req.body.amount) || 0;
    if (amount <= 0) {
        return res.redirect('/dashboard?error=invalid_amount');
    }
    try {
        await dbService.incrementBalance(userId, amount);
        res.redirect('/dashboard?success=balance_added');
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
        res.redirect('/dashboard?success=user_updated');
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
        res.redirect('/dashboard?success=user_deleted');
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
        // Use original_file_key (destination after copy) if available, otherwise use file_key
        const filesWithContent = await Promise.all(files.map(async (file: any) => {
            try {
                // After acceptance, files are copied to saralangan/ and originals are deleted
                // original_file_key stores the destination path
                const audioKey = file.original_file_key || file.file_key;
                const json = await s3Service.getJsonContent(audioKey);
                const audioUrl = await s3Service.getAudioUrl(audioKey);
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
        res.redirect('/dashboard?success=penalty_applied');
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
app.get('/api/transcription-stats', requireAuth, apiLimiter, async (req, res) => {
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
                total: (s.accepted_count || 0) + (s.rejected_count || 0)
                // balance removed from public leaderboard for privacy
            }));

        res.render('leaderboard', { leaderboard });
    } catch (err) {
        console.error('Leaderboard error:', err);
        res.status(500).send('Server xatosi');
    }
});

// API: Get Lifetime Statistics (Last 30 days)
app.get('/api/lifetime-stats', requireAuth, apiLimiter, async (req, res) => {
    try {
        const stats = await dbService.getLifetimeDailyStats();
        res.json({
            success: true,
            stats
        });
    } catch (err) {
        console.error('Lifetime stats error:', err);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// API: Get 24-hour hourly statistics for chart
app.get('/api/hourly-stats', requireAuth, apiLimiter, async (req, res) => {
    try {
        const hourlyStats = await dbService.get24hHourlyStats();

        // Group data by user for multi-series chart
        const userMap = new Map<string, { hours: string[], counts: number[] }>();
        const allHours = new Set<string>();

        hourlyStats.forEach((stat: any) => {
            const hourStr = new Date(stat.hour).toISOString();
            allHours.add(hourStr);

            if (!userMap.has(stat.full_name)) {
                userMap.set(stat.full_name, { hours: [], counts: [] });
            }
            const userData = userMap.get(stat.full_name)!;
            userData.hours.push(hourStr);
            userData.counts.push(stat.count);
        });

        // Convert to chart.js format
        const datasets = Array.from(userMap.entries()).map(([name, data], index) => {
            const colors = ['#3b82f6', '#22c55e', '#ef4444', '#eab308', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
            return {
                label: name,
                data: data.counts,
                borderColor: colors[index % colors.length],
                backgroundColor: colors[index % colors.length] + '20',
                tension: 0.4,
                fill: true
            };
        });

        res.json({
            success: true,
            labels: Array.from(allHours).sort(),
            datasets,
            updatedAt: new Date().toISOString()
        });
    } catch (err) {
        console.error('Hourly stats error:', err);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// JSON API for live updates (polling every 5 seconds)
// Public API with rate limiting
app.get('/api/leaderboard', apiLimiter, async (req, res) => {
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
                total: (s.accepted_count || 0) + (s.rejected_count || 0)
                // balance removed from public API for privacy
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

// API: Combined Dashboard Data (for live auto-refresh)
app.get('/api/dashboard', requireAuth, apiLimiter, async (req, res) => {
    try {
        const usersWithStats = await dbService.getDashboardUsers();
        const pendingCount = await dbService.getPendingCount();
        const transcriptionPendingCount = await dbService.getTranscriptionPendingCount();
        const allStats = await dbService.getAllUserStats();
        const totalAccepted = allStats.reduce((sum: number, s: any) => sum + (s.accepted_count || 0), 0);
        const totalRejected = allStats.reduce((sum: number, s: any) => sum + (s.rejected_count || 0), 0);

        const durationStats = await dbService.getDurationStats();
        const durationByStatus: Record<string, number> = {};
        durationStats.forEach((s: any) => {
            durationByStatus[s.status] = Number(s.total_seconds) || 0;
        });
        const acceptedDuration = durationByStatus['ACCEPTED'] || 0;
        const rejectedDuration = durationByStatus['REJECTED'] || 0;
        const pendingDuration = durationByStatus['PENDING'] || 0;

        const formatDuration = (sec: number) => {
            const hours = Math.floor(sec / 3600);
            const minutes = Math.floor((sec % 3600) / 60);
            return `${hours}s ${minutes}m`;
        };

        const lifetimeStats = await dbService.getLifetimeDailyStats();
        const transStats = await dbService.getAllTranscriptionStats();
        const transAccepted = transStats.reduce((sum: number, s: any) => sum + (s.accepted_count || 0), 0);
        const transRejected = transStats.reduce((sum: number, s: any) => sum + (s.rejected_count || 0), 0);

        const xorazmPending = await dbService.getXorazmPendingCount();
        const xorazmStats = await dbService.getAllXorazmStats();
        const xorazmAccepted = xorazmStats.reduce((sum: number, s: any) => sum + (s.accepted_count || 0), 0);
        const xorazmRejected = xorazmStats.reduce((sum: number, s: any) => sum + (s.rejected_count || 0), 0);

        res.json({
            success: true,
            users: usersWithStats,
            lifetimeStats,
            transStats,
            stats: {
                pending: pendingCount,
                transcriptionPending: transcriptionPendingCount,
                xorazmPending,
                totalAccepted,
                totalRejected,
                totalChecked: totalAccepted + totalRejected,
                acceptedDuration: formatDuration(acceptedDuration),
                rejectedDuration: formatDuration(rejectedDuration),
                pendingDuration: formatDuration(pendingDuration),
                transAccepted,
                transRejected,
                xorazmAccepted,
                xorazmRejected
            },
            updatedAt: new Date().toISOString()
        });
    } catch (err) {
        console.error('Dashboard API error:', err);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// API: Get Overview Stats for Dashboard Charts
app.get('/api/stats/overview', requireAuth, apiLimiter, async (req, res) => {
    try {
        const allStats = await dbService.getAllUserStats();
        const pendingCount = await dbService.getPendingCount();
        const totalAccepted = allStats.reduce((sum: number, s: any) => sum + (s.accepted_count || 0), 0);
        const totalRejected = allStats.reduce((sum: number, s: any) => sum + (s.rejected_count || 0), 0);

        const durationStats = await dbService.getDurationStats();
        const durationByStatus: Record<string, number> = {};
        durationStats.forEach((s: any) => {
            durationByStatus[s.status] = Number(s.total_seconds) || 0;
        });

        const totalCheckedDuration = (durationByStatus['ACCEPTED'] || 0) + (durationByStatus['REJECTED'] || 0);
        const pendingDuration = durationByStatus['PENDING'] || 0;

        res.json({
            success: true,
            data: {
                totalChecked: totalAccepted + totalRejected,
                totalAccepted,
                totalRejected,
                pending: pendingCount,
                checkedDuration: totalCheckedDuration,
                pendingDuration
            }
        });
    } catch (err) {
        console.error('Overview stats error:', err);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// API: Get User Stats for User Activity Chart
app.get('/api/stats/by-user', requireAuth, apiLimiter, async (req, res) => {
    try {
        const allStats = await dbService.getAllUserStats();
        const userStats = allStats
            .filter((s: any) => s.accepted_count > 0 || s.rejected_count > 0)
            .map((s: any) => ({
                name: s.full_name || 'Noma\'lum',
                accepted_count: s.accepted_count || 0,
                rejected_count: s.rejected_count || 0,
                total: (s.accepted_count || 0) + (s.rejected_count || 0)
            }));

        res.json({
            success: true,
            data: userStats
        });
    } catch (err) {
        console.error('User stats error:', err);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// API: Get Timeline Stats for Last 30 Days Chart
app.get('/api/stats/timeline', requireAuth, apiLimiter, async (req, res) => {
    try {
        const stats = await dbService.getLifetimeDailyStats();
        const timelineData = stats.map((s: any) => ({
            date: s.day,  // Fixed: was s.date but query returns 'day'
            accepted: s.accepted || 0,
            rejected: s.rejected || 0
        }));

        res.json({
            success: true,
            data: timelineData
        });
    } catch (err) {
        console.error('Timeline stats error:', err);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// CSRF Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err.code === 'EBADCSRFTOKEN') {
        // CSRF token validation failed
        console.error('CSRF token validation failed');
        return res.status(403).send('Formani qayta yuklang va qayta urinib ko\'ring.');
    }
    next(err);
});

// Global Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('Server error:', err);
    res.status(500).send('Server xatoligi yuz berdi.');
});

export function startServer() {
    const port = config.PORT;
    app.listen(port, () => {
        console.log(`Web server ishga tushdi: http://localhost:${port}`);
    });
}