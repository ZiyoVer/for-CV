import express from 'express';
import session from 'express-session';
import bodyParser from 'body-parser';
import path from 'path';
import { config } from './config';
import { dbService } from './services/db';
import { s3Service } from './services/s3';

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
        const allStats = await dbService.getAllUserStats();
        const totalAccepted = allStats.reduce((sum: number, s: any) => sum + (s.accepted_count || 0), 0);
        const totalRejected = allStats.reduce((sum: number, s: any) => sum + (s.rejected_count || 0), 0);

        res.render('dashboard', {
            users: usersWithStats,
            stats: {
                pending: pendingCount,
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

export function startServer() {
    const port = config.PORT;
    app.listen(port, () => {
        console.log(`Web server ishga tushdi: http://localhost:${port}`);
    });
}
