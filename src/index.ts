import { launchBot, cleanup as botCleanup } from './bot';
import { startServer } from './server';
import { dbService } from './services/db';

async function main() {
    console.log('🚀 Starting STT Bot and Web Server...');

    // Start web server (non-blocking)
    startServer();

    // Start telegram bot (this will run the polling loop)
    await launchBot();
}

// Graceful shutdown handler
async function shutdown(signal: string) {
    console.log(`\n${signal} received. Shutting down gracefully...`);

    try {
        // Stop bot and clear intervals
        botCleanup();

        // Close database connections
        await dbService.close();

        console.log('Graceful shutdown completed');
        process.exit(0);
    } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }
}

// Register shutdown handlers
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
// Forced redeploy: Tue Feb  3 20:18:17 +05 2026
