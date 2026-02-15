import { Bot, InlineKeyboard, Keyboard, Context, NextFunction, InputFile } from 'grammy';
import { config } from './config';
import { s3Service } from './services/s3';
import { dbService } from './services/db';
import { statsService } from './services/stats';
import { parseBuffer } from 'music-metadata';
import { Logger } from './utils/logger';
import path from 'path';

export const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

// Track intervals for cleanup
const intervals: NodeJS.Timeout[] = [];

// State management types
interface BotState {
    fileKey?: string;
    tempText?: string;
    originalText?: string;
    action?: string;
    [key: string]: any;
}

function isValidState(data: any): data is BotState {
    return data && typeof data === 'object';
}

// --- KEYBOARD DEFINITIONS ---

// Main menu keyboard
const mainMenuKeyboard = new Keyboard()
    .text("🎧 STT Tekshirish")
    .text("📝 Transkripsiya")
    .row()
    .text("📋 Anotatsiya qoidalari")
    .resized();

// STT Submenu keyboard
const sttSubmenuKeyboard = new Keyboard()
    .text("📚 Adabiy gaplar")
    .text("🌍 Xorazm viloyati")
    .row()
    .text("⬅️ Asosiy menyu")
    .resized();

// File check action keyboard (shown when user is checking a file)
const fileCheckKeyboard = new Keyboard()
    .text("✅ To'g'ri")
    .text("❌ Xato")
    .row()
    .text("✏️ Tahrirlash")
    .text("⏭️ O'tkazish")
    .row()
    .text("⬅️ Asosiy menyu")
    .resized();

// Transcription action keyboard (for skip and menu only)
const transcriptionKeyboard = new Keyboard()
    .text("⏭️ O'tkazish")
    .text("⬅️ Asosiy menyu")
    .resized();

// NOTE: Gender and confirmation buttons now use InlineKeyboard (callback queries)
// This is more reliable than Reply Keyboard as it doesn't conflict with text handler

// --- MIDDLEWARE: AUTH CHECK ---
async function authMiddleware(ctx: Context, next: NextFunction) {
    if (!ctx.from) return;

    // Auto-update user info/activity if they exist
    const user = await dbService.getUser(ctx.from.id);
    if (user && user.is_active) {
        // Continue
    } else {
        // If it's your first time, check if you are in config ADMIN_IDS
        // If so, add yourself
        if (config.ADMIN_IDS.includes(ctx.from.id)) {
            await dbService.addUser(ctx.from.id, ctx.from.first_name, 1);
        } else {
            // Not authorized
            await ctx.reply("⛔️ <b>Sizga botdan foydalanishga ruxsat berilmagan.</b>\nIltimos administratorga murojaat qiling.", {
                parse_mode: "HTML"
            });
            return;
        }
    }
    await next();
}

bot.use(authMiddleware);

// --- COMMANDS ---

bot.command('start', async (ctx) => {
    await showMainMenu(ctx);
});

bot.command('menu', async (ctx) => {
    await showMainMenu(ctx);
});

// Helper function to show main menu
async function showMainMenu(ctx: any) {
    if (!ctx.from) return;

    // Clear any existing state when going to main menu
    await dbService.deleteState(ctx.from.id);

    const user = await dbService.getUser(ctx.from.id);
    const stats = await dbService.getUserStats(ctx.from.id);
    const transStats = await dbService.getUserTranscriptionStats(ctx.from.id);
    const checksToday = await dbService.get24hCheckCount(ctx.from.id);
    const transToday = await dbService.get24hTranscriptionCount(ctx.from.id);
    const freeLeft = Math.max(0, config.FREE_CHECKS_LIMIT - checksToday);

    let text = `🏠 <b>Asosiy Menyu</b>\n\n`;
    text += `Salom, <b>${ctx.from?.first_name}</b>! 👋\n\n`;

    // STT Stats
    text += `<b>🎧 STT Tekshiruv:</b>\n`;
    text += `<code>┌─────────────────────────┐</code>\n`;
    text += `<code>│</code> ✅ Qabul:    <code>${String(stats.accepted).padStart(6)}</code>  <code>│</code>\n`;
    text += `<code>│</code> ❌ Rad:      <code>${String(stats.rejected).padStart(6)}</code>  <code>│</code>\n`;
    text += `<code>│</code> 📅 Bugun:    <code>${String(checksToday).padStart(6)}</code>  <code>│</code>\n`;
    if (user?.balance) {
        text += `<code>├─────────────────────────┤</code>\n`;
        text += `<code>│</code> 💰 Balans: <code>${String(user.balance).padStart(6)}</code> so'm<code>│</code>\n`;
    }
    text += `<code>└─────────────────────────┘</code>\n`;
    text += `🎁 Bepul qoldi: <b>${freeLeft}</b>/${config.FREE_CHECKS_LIMIT}\n\n`;

    // Transcription Stats
    text += `<b>📝 Transkripsiya:</b>\n`;
    text += `<code>┌─────────────────────────┐</code>\n`;
    text += `<code>│</code> ✅ Bajarildi: <code>${String(transStats.accepted).padStart(5)}</code>  <code>│</code>\n`;
    text += `<code>│</code> 📅 Bugun:     <code>${String(transToday).padStart(5)}</code>  <code>│</code>\n`;
    text += `<code>└─────────────────────────┘</code>\n`;

    await ctx.reply(text, {
        parse_mode: "HTML",
        reply_markup: mainMenuKeyboard
    });
}

bot.command('admin', async (ctx) => {
    const user = await dbService.getUser(ctx.from?.id!);
    if (!user?.is_admin) return ctx.reply("Siz admin emassiz.");

    await ctx.reply("Admin Paneli:", {
        reply_markup: new InlineKeyboard()
            .text("📈 Umumiy Statistika", "admin_stats")
            .row()
            .text("🔄 STT Sync", "admin_sync")
            .text("📝 Trans. Sync", "admin_transcription_sync")
            .row()
            .text("🗑 Tozalash + Sync", "admin_clear_and_sync")
            .row()
            .text("🧹 Xorazmni tozalash", "admin_clear_xorazm")
    });
});

// Clear all Xorazm files and reload from S3
bot.callbackQuery("admin_clear_xorazm", async (ctx) => {
    const user = await dbService.getUser(ctx.from.id);
    if (!user?.is_admin) return;

    await ctx.answerCallbackQuery("Xorazm tozalanmoqda...");

    try {
        const cleared = await dbService.clearAllXorazmFiles();
        await ctx.reply(`🗑 Xorazm bazasi tozalandi: ${cleared} yozuv o'chirildi`);

        await ctx.reply("🔄 Xorazm metadata S3 dan yuklanmoqda...");
        const added = await s3Service.loadXorazmMetadata();
        
        await ctx.reply(`✅ Xorazm yangilandi!\n📁 Yangi fayllar: ${added}`);
    } catch (err: any) {
        console.error("Clear xorazm error:", err);
        await ctx.reply(`⚠️ Xatolik: ${err.message}`);
    }
});

// --- HELPER FUNCTIONS ---

async function sendNextFile(ctx: any) {
    if (!ctx.from) return;
    const userId = ctx.from.id;
    let fileKey: string | null = null;

    try {
        fileKey = await dbService.lockNextFile(userId);

        if (!fileKey) {
            const pending = await dbService.getPendingCount();
            if (pending === 0) {
                const user = await dbService.getUser(userId);
                let msg = "Hozircha vazifalar yo'q.";
                if (user?.is_admin) {
                    msg += " (Admin panel orqali 'S3 Sync' qiling).";
                }
                await ctx.reply(msg, { reply_markup: sttSubmenuKeyboard });
            } else {
                await ctx.reply("Hozircha barcha fayllar band. Birozdan so'ng urinib ko'ring.", { reply_markup: sttSubmenuKeyboard });
            }
            return;
        }

        // Clear existing states and set new checking state
        await dbService.saveState(userId, 'checking', { fileKey });

        const json = await s3Service.getJsonContent(fileKey);
        const audioBuffer = await s3Service.getFileBuffer(fileKey);

        if (!audioBuffer) {
            await ctx.reply("❌ Audio fayl serverda topilmadi (S3 error). U o'tkazib yuborildi.", { reply_markup: sttSubmenuKeyboard });

            // Mark as REJECTED so it doesn't block the user
            await dbService.updateFileStatus(userId, fileKey, 'REJECTED');
            await dbService.deleteState(userId);

            return;
        }

        if (audioBuffer.length > 20 * 1024 * 1024) {
            await ctx.reply('⚠️ Fayl juda katta, yuklanishi biroz vaqt oladi...');
        }

        let text = json.text || 'Noma\'lum';
        if (text.length > 800) text = text.substring(0, 800) + "...";

        const caption = `🆔 <code>${json.utt_id || fileKey}</code>\n\n📝 ${text}`;

        await ctx.replyWithAudio(new InputFile(audioBuffer), {
            caption: caption,
            parse_mode: "HTML"
        });

        await ctx.reply("Faylni tekshiring:", { reply_markup: fileCheckKeyboard });

    } catch (e: any) {
        console.error("Error in sendNextFile:", e);
        let msg = "Faylni olishda xatolik.";
        if (e.message) msg += `\n(${e.message})`;
        await ctx.reply(msg, { reply_markup: sttSubmenuKeyboard });
    }
}

async function sendNextTranscriptionFile(ctx: any) {
    if (!ctx.from) return;
    const userId = ctx.from.id;
    let fileKey: string | null = null;

    try {
        fileKey = await dbService.lockNextTranscriptionFile(userId);

        if (!fileKey) {
            const pending = await dbService.getTranscriptionPendingCount();
            if (pending === 0) {
                const user = await dbService.getUser(userId);
                let msg = "Hozircha transkripsiya vazifalari yo'q.";
                if (user?.is_admin) {
                    msg += " (Admin panel orqali 'Transkripsiya Sync' qiling).";
                }
                await ctx.reply(msg, { reply_markup: mainMenuKeyboard });
            } else {
                await ctx.reply("Hozircha barcha transkripsiya fayllar band. Birozdan so'ng urinib ko'ring.", { reply_markup: mainMenuKeyboard });
            }
            return;
        }

        // Get audio
        const audioBuffer = await s3Service.getTranscriptionAudioBuffer(fileKey);

        if (!audioBuffer) {
            await ctx.reply("❌ Audio fayl serverda topilmadi (S3 error). U o'tkazib yuborildi.", { reply_markup: mainMenuKeyboard });

            // Mark as REJECTED so it doesn't block the user
            await dbService.updateTranscriptionFileStatus(userId, fileKey, 'REJECTED');
            await dbService.deleteState(userId);

            return;
        }

        // Store state for text input
        await dbService.saveState(userId, 'transcription', { fileKey });

        const fileName = fileKey.split('/').pop()?.replace('.wav', '') || fileKey;
        const caption = `📝 <b>TRANSKRIPSIYA</b>\n\n🆔 <code>${fileName}</code>\n\n<i>⬇️ Audioni tinglang va matnni yozing:</i>`;

        await ctx.replyWithAudio(new InputFile(audioBuffer), {
            caption: caption,
            parse_mode: "HTML"
        });

        await ctx.reply("Matnni yozib yuboring:", { reply_markup: transcriptionKeyboard });

    } catch (e: any) {
        console.error("Error in sendNextTranscriptionFile:", e);
        let msg = "Faylni olishda xatolik.";
        if (e.message) msg += `\n(${e.message})`;
        await ctx.reply(msg, { reply_markup: mainMenuKeyboard });
    }
}

async function sendNextXorazmFile(ctx: any) {
    if (!ctx.from) return;
    const userId = ctx.from.id;

    try {
        // First ensure metadata is loaded
        const pending = await dbService.getXorazmPendingCount();
        if (pending === 0) {
            const added = await s3Service.loadXorazmMetadata();
            if (added === 0) {
                await ctx.reply("Hozircha Xorazm vazifalari yo'q.", { reply_markup: sttSubmenuKeyboard });
                return;
            }
        }

        const xorazmFile = await dbService.lockNextXorazmFile(userId);

        if (!xorazmFile) {
            await ctx.reply("Hozircha barcha Xorazm fayllar band yoki tugagan. Birozdan so'ng urinib ko'ring.", { reply_markup: sttSubmenuKeyboard });
            return;
        }

        // Get audio from S3
        const audioBuffer = await s3Service.getXorazmAudioBuffer(xorazmFile.audio_path);

        if (!audioBuffer) {
            await ctx.reply("❌ Audio fayl serverda topilmadi (S3 error). U o'tkazib yuborildi.", { reply_markup: sttSubmenuKeyboard });
            await dbService.updateXorazmFileStatus(userId, xorazmFile.id, 'REJECTED');
            await dbService.deleteState(userId);
            return;
        }

        // Get Gemini transcription
        let geminiText: string | null = null;
        if (config.GEMINI_API_KEY) {
            await ctx.reply("🤖 Gemini transkripsiya qilinmoqda... (bu biroz vaqt olishi mumkin)");
            try {
                geminiText = await s3Service.transcribeXorazmWithGemini(xorazmFile.audio_path);
                if (geminiText) {
                    await dbService.updateXorazmGeminiText(xorazmFile.id, geminiText);
                }
            } catch (e) {
                console.warn('Gemini transcription failed for xorazm file:', xorazmFile.id, e);
            }
        }

        // Save state
        await dbService.saveState(userId, 'xorazm', {
            xorazmId: xorazmFile.id,
            audioPath: xorazmFile.audio_path,
            originalText: xorazmFile.original_text,
            geminiText: geminiText,
            editedText: null
        });

        // Send audio with text
        let caption = `🌍 <b>XORAZM SHEVA</b>\n\n`;
        caption += `🆔 <code>${xorazmFile.id}</code>\n\n`;

        // Show original text
        const origText = xorazmFile.original_text;
        if (origText.length > 400) {
            caption += `<b>📝 Asl matn:</b>\n<code>${origText.substring(0, 400)}...</code>\n\n`;
        } else {
            caption += `<b>📝 Asl matn:</b>\n<code>${origText}</code>\n\n`;
        }

        // Show Gemini text if available
        if (geminiText) {
            if (geminiText.length > 400) {
                caption += `<b>🤖 Gemini:</b>\n<code>${geminiText.substring(0, 400)}...</code>\n\n`;
            } else {
                caption += `<b>🤖 Gemini:</b>\n<code>${geminiText}</code>\n\n`;
            }
        }

        caption += `<i>Pastdagi tugmalardan birini tanlang:</i>`;

        await ctx.replyWithAudio(new InputFile(audioBuffer), {
            caption: caption,
            parse_mode: "HTML"
        });

        // Show InlineKeyboard for actions
        await ctx.reply("Faylni tekshiring:", {
            reply_markup: new InlineKeyboard()
                .text("✅ To'g'ri", "xrz_accept")
                .text("❌ Xato", "xrz_deny")
                .row()
                .text("✏️ Tahrirlash", "xrz_edit")
                .text("⏭️ O'tkazish", "xrz_skip")
        });

    } catch (e: any) {
        console.error("Error in sendNextXorazmFile:", e);
        let msg = "Faylni olishda xatolik.";
        if (e.message) msg += `\n(${e.message})`;
        await ctx.reply(msg, { reply_markup: sttSubmenuKeyboard });
    }
}

// Start
bot.catch((err) => console.error(err));

export async function launchBot() {
    await dbService.init();
    console.log("Bot ishga tushmoqda...");

    // Periodically release locks (every 5 mins)
    const lockReleaseInterval = setInterval(() => {
        dbService.releaseTimedOutFiles(config.LOCK_TIMEOUT_MS)
            .then((released) => {
                const count = released ?? 0;
                if (count > 0) console.log(`Released ${count} timed out STT files.`);
            })
            .catch((err) => Logger.error('Error releasing STT locks', err));

        dbService.releaseTimedOutTranscriptionFiles(config.LOCK_TIMEOUT_MS)
            .then((released) => {
                const count = released ?? 0;
                if (count > 0) console.log(`Released ${count} timed out transcription files.`);
            })
            .catch((err) => Logger.error('Error releasing transcription locks', err));

        dbService.releaseTimedOutXorazmFiles(config.LOCK_TIMEOUT_MS)
            .then((released) => {
                const count = released ?? 0;
                if (count > 0) console.log(`Released ${count} timed out xorazm files.`);
            })
            .catch((err) => Logger.error('Error releasing xorazm locks', err));
    }, config.LOCK_TIMEOUT_MS);
    intervals.push(lockReleaseInterval);

    // Initial sync on startup
    console.log("Running initial STT sync...");
    s3Service.syncFiles()
        .then(() => console.log("Initial STT sync completed."))
        .catch((err) => Logger.error("Initial STT sync error", err));

    console.log("Running initial Transcription sync...");
    s3Service.syncTranscriptionFiles()
        .then(() => console.log("Initial Transcription sync completed."))
        .catch((err) => Logger.error("Initial Transcription sync error", err));

    console.log("Loading Xorazm metadata...");
    s3Service.loadXorazmMetadata()
        .then(() => console.log("Xorazm metadata loaded."))
        .catch((err) => Logger.error("Xorazm metadata load error", err));

    // Periodic auto-sync
    const autoSyncInterval = setInterval(() => {
        console.log("Auto-syncing STT files from S3...");
        s3Service.syncFiles()
            .then(async () => {
                const pendingCount = await dbService.getPendingCount();
                console.log(`STT auto-sync completed. Pending files: ${pendingCount}`);
            })
            .catch((err) => Logger.error('STT auto-sync error', err));

        console.log("Auto-syncing Transcription files from S3...");
        s3Service.syncTranscriptionFiles()
            .then(async () => {
                const pendingCount = await dbService.getTranscriptionPendingCount();
                console.log(`Transcription auto-sync completed. Pending files: ${pendingCount}`);
            })
            .catch((err) => Logger.error('Transcription auto-sync error', err));
    }, config.SYNC_INTERVAL_MS);
    intervals.push(autoSyncInterval);

    console.log(`Auto-sync enabled: every ${config.SYNC_INTERVAL_MS / 60000} minutes`);

    bot.start({
        onStart: (botInfo) => {
            console.log(`Bot @${botInfo.username} started!`);
        }
    });
}

/**
 * Cleanup function to clear all intervals and stop the bot gracefully
 */
export function cleanup() {
    console.log('Cleaning up bot resources...');

    intervals.forEach(interval => clearInterval(interval));
    intervals.length = 0;

    bot.stop();

    console.log('Bot cleanup completed');
}
