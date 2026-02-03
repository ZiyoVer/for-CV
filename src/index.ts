import { launchBot } from './bot';
import { startServer } from './server';

async function main() {
    console.log('🚀 Starting STT Bot and Web Server...');

    // Start web server (non-blocking)
    startServer();

    // Start telegram bot (this will run the polling loop)
    await launchBot();
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
// Forced redeploy: Tue Feb  3 20:18:17 +05 2026
