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
    // Clear any existing state when going to main menu
    if (ctx.from) {
        await dbService.deleteState(ctx.from.id);
    }

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
    });
});

// /add_user 12345 Name
bot.command('add_user', async (ctx) => {
    await ctx.reply("Bu funksiya endi Web panel orqali ishlaydi.");
});

// --- TEXT MESSAGE HANDLERS FOR MENU NAVIGATION ---

bot.hears("🎧 STT Tekshirish", async (ctx) => {
    if (!ctx.from) return;
    await ctx.reply("STT Tekshirish turini tanlang:", {
        reply_markup: sttSubmenuKeyboard
    });
});

bot.hears("📚 Adabiy gaplar", async (ctx) => {
    if (!ctx.from) return;
    await ctx.reply("Fayl yuklanmoqda...", { reply_markup: fileCheckKeyboard });
    await sendNextFile(ctx);
});

bot.hears("🌍 Xorazm viloyati", async (ctx) => {
    if (!ctx.from) return;
    await ctx.reply("📋 Datasetlar tez orada qo'shiladi", {
        reply_markup: sttSubmenuKeyboard
    });
});

bot.hears("📝 Transkripsiya", async (ctx) => {
    if (!ctx.from) return;
    await ctx.reply("Fayl yuklanmoqda...", { reply_markup: transcriptionKeyboard });
    await sendNextTranscriptionFile(ctx);
});

bot.hears("📋 Anotatsiya qoidalari", async (ctx) => {
    if (!ctx.from) return;
    try {
        // Use relative path for production compatibility
        const pdfPath = path.join(__dirname, '..', 'UzDataLab_STT_Anotations_2026.pdf');
        await ctx.replyWithDocument(new InputFile(pdfPath), {
            caption: "📋 Anotatsiya qoidalari"
        });
    } catch (e) {
        await ctx.reply("❌ PDF faylni yuborishda xatolik yuz berdi.");
    }
    // Return to main menu after sending PDF
    await showMainMenu(ctx);
});

bot.hears("⬅️ Asosiy menyu", async (ctx) => {
    await showMainMenu(ctx);
});

// --- FILE CHECK ACTION HANDLERS (Text-based) ---

bot.hears("✅ To'g'ri", async (ctx) => {
    if (!ctx.from) return;
    const userId = ctx.from.id;
    const stateRow = await dbService.getState(userId);

    if (!stateRow || !isValidState(stateRow.data) || !stateRow.data.fileKey) {
        await ctx.reply("❌ Faol fayl topilmadi. Iltimos, yangi fayl so'rang.");
        return;
    }

    const key = stateRow.data.fileKey;
    const editedText = stateRow.data.editedText; // Get edited text if available

    try {
        // 1. Copy S3 with edited text
        await s3Service.copyToSorted(key, editedText);
        // 2. DB Update with transcribed text
        await dbService.updateFileStatus(userId, key, 'ACCEPTED', editedText);
        // 3. Clear state
        await dbService.deleteState(userId);

        // PAYMENT LOGIC - Reward for work done beyond free limit
        const checksToday = await dbService.get24hCheckCount(userId);
        if (checksToday > config.FREE_CHECKS_LIMIT) {
            await dbService.incrementBalance(userId, config.CHECK_PRICE);
            await ctx.reply(`💰 ${config.CHECK_PRICE} so'm hisobingizga qo'shildi! (Bepul limit: ${config.FREE_CHECKS_LIMIT})`);
        }

        // 4. Ask to continue
        await ctx.reply("✅ Qabul qilindi! Davom etamizmi?", {
            reply_markup: new Keyboard()
                .text("📚 Adabiy gaplar")
                .text("⬅️ Asosiy menyu")
                .resized()
        });

    } catch (e) {
        Logger.error('Bot command error', e, { userId });
        await ctx.reply("❌ Xatolik yuz berdi.");
    }
});

bot.hears("❌ Xato", async (ctx) => {
    if (!ctx.from) return;
    const userId = ctx.from.id;
    const stateRow = await dbService.getState(userId);

    if (!stateRow || !isValidState(stateRow.data) || !stateRow.data.fileKey) {
        await ctx.reply("❌ Faol fayl topilmadi. Iltimos, yangi fayl so'rang.");
        return;
    }

    const key = stateRow.data.fileKey;

    try {
        await dbService.updateFileStatus(userId, key, 'REJECTED');
        await dbService.deleteState(userId);

        await ctx.reply("❌ Rad etildi! Davom etamizmi?", {
            reply_markup: new Keyboard()
                .text("📚 Adabiy gaplar")
                .text("⬅️ Asosiy menyu")
                .resized()
        });
    } catch (e) {
        Logger.error('Error rejecting file', e, { userId });
        await ctx.reply("❌ Xatolik yuz berdi.");
    }
});

bot.hears("✏️ Tahrirlash", async (ctx) => {
    if (!ctx.from) return;
    const userId = ctx.from.id;
    const stateRow = await dbService.getState(userId);

    if (!stateRow || !isValidState(stateRow.data) || !stateRow.data.fileKey) {
        await ctx.reply("❌ Faol fayl topilmadi. Iltimos, yangi fayl so'rang.");
        return;
    }

    const key = stateRow.data.fileKey;

    try {
        const json = await s3Service.getJsonContent(key);
        const originalText = json.text || '';

        // Store the edit state
        await dbService.saveState(userId, 'edit', { fileKey: key, originalText });

        await ctx.reply(
            `✏️ <b>Matnni tahrirlash</b>\n\n` +
            `<b>Hozirgi matn:</b>\n<code>${originalText}</code>\n\n` +
            `<i>To'g'ri matnni yozib yuboring:</i>\n\n` +
            `Yoki "❌ Bekor qilish" tugmasini bosing.`,
            {
                parse_mode: "HTML",
                reply_markup: new Keyboard()
                    .text("❌ Bekor qilish")
                    .text("⬅️ Asosiy menyu")
                    .resized()
            }
        );
    } catch (e) {
        Logger.error('Bot command error', e, { userId });
        await ctx.reply("❌ Xatolik yuz berdi.");
    }
});

bot.hears("❌ Bekor qilish", async (ctx) => {
    if (!ctx.from) return;
    const userId = ctx.from.id;
    const stateRow = await dbService.getState(userId);

    if (stateRow && stateRow.state_type === 'edit') {
        await dbService.deleteState(userId);

        // Restore the file check state if we have the fileKey
        if (isValidState(stateRow.data) && stateRow.data.fileKey) {
            await dbService.saveState(userId, 'checking', { fileKey: stateRow.data.fileKey });
            await ctx.reply("Tahrirlash bekor qilindi.", { reply_markup: fileCheckKeyboard });
        } else {
            await ctx.reply("Tahrirlash bekor qilindi.", { reply_markup: sttSubmenuKeyboard });
        }
    } else {
        await showMainMenu(ctx);
    }
});

bot.hears("⏭️ O'tkazish", async (ctx) => {
    if (!ctx.from) return;
    const userId = ctx.from.id;
    const stateRow = await dbService.getState(userId);

    if (!stateRow || !isValidState(stateRow.data) || !stateRow.data.fileKey) {
        await ctx.reply("❌ Faol fayl topilmadi.");
        return;
    }

    const key = stateRow.data.fileKey;

    try {
        // Release the file back to pending
        await dbService.releaseFile(userId, key);
        await dbService.deleteState(userId);

        await ctx.reply("⏭️ Fayl o'tkazildi. Davom etamizmi?", {
            reply_markup: new Keyboard()
                .text("📚 Adabiy gaplar")
                .text("⬅️ Asosiy menyu")
                .resized()
        });
    } catch (e) {
        Logger.error('Bot command error', e, { userId });
        await ctx.reply("❌ Xatolik yuz berdi.");
    }
});

// --- TEXT INPUT HANDLER FOR EDITING AND TRANSCRIPTION ---

// List of known button texts to ignore in the text handler (STT and navigation only)
const BUTTON_TEXTS = [
    "🎧 STT Tekshirish", "📝 Transkripsiya", "📋 Anotatsiya qoidalari", "⬅️ Asosiy menyu",
    "📚 Adabiy gaplar", "🌍 Xorazm viloyati",
    "✅ To'g'ri", "❌ Xato", "✏️ Tahrirlash", "⏭️ O'tkazish", "❌ Bekor qilish"
    // Note: Transcription buttons now use InlineKeyboard callbacks
];

bot.on("message:text", async (ctx) => {
    const userId = ctx.from.id;
    const messageText = ctx.message.text.trim();

    // Skip if it's a known button text (let bot.hears handle it)
    if (BUTTON_TEXTS.includes(messageText)) {
        return;
    }

    const stateRow = await dbService.getState(userId);

    // If no state, ignore (user is just navigating menus)
    if (!stateRow) {
        return;
    }

    const { state_type: type, data } = stateRow;
    const newText = messageText;

    // Handle TRANSCRIPTION text input
    if (type === 'transcription') {
        const { fileKey } = data;

        // Save temp text in state
        data.tempText = newText;
        await dbService.saveState(userId, 'transcription', data);

        // Fetch audio again to show with text
        const audioBuffer = await s3Service.getTranscriptionAudioBuffer(fileKey);

        if (!audioBuffer) {
            await ctx.reply("Matn qabul qilindi, lekin audio faylni qayta yuklab bo'lmadi.");
            return;
        }

        // Warn for large files
        if (audioBuffer.length > 20 * 1024 * 1024) {
            await ctx.reply('⚠️ Fayl juda katta, yuklanishi biroz vaqt oladi...');
        }

        const fileName = fileKey.split('/').pop()?.replace('.wav', '') || fileKey;
        const caption = `📝 <b>TRANSKRIPSIYA (Tekshirish)</b>\n\n🆔 <code>${fileName}</code>\n\n<b>Siz yozgan matn:</b>\n<code>${newText}</code>\n\n<i>⬇️ So'zlovchi jinsini tanlang:</i>`;

        await ctx.replyWithAudio(new InputFile(audioBuffer), {
            caption: caption,
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
                .text("👨 Erkak", "trans_gender_male")
                .text("👩 Ayol", "trans_gender_female")
                .row()
                .text("✏️ Matnni tahrirlash", "trans_edit_text")
        });

        return;
    }

    // Handle EDIT (STT) text input
    if (type === 'edit') {
        const { fileKey } = data;
        try {
            // Update JSON in S3
            const success = await s3Service.updateJsonText(fileKey, newText);

            if (success) {
                // Done editing, switch to checking state WITH the edited text
                await dbService.saveState(userId, 'checking', { fileKey, editedText: newText });

                // Fetch audio again
                const audioBuffer = await s3Service.getFileBuffer(fileKey);
                if (!audioBuffer) {
                    await ctx.reply("Matn saqlandi, lekin audio faylni qayta yuklab bo'lmadi.");
                    return;
                }

                const caption = `🆔 <code>${fileKey.split('/').pop()?.replace('.json', '') || fileKey}</code>\n\n📝 ${newText}\n\n<i>(Tahrirlangan)</i>`;

                await ctx.replyWithAudio(new InputFile(audioBuffer), {
                    caption: caption,
                    parse_mode: "HTML"
                });

                await ctx.reply("Fayl tahrirlandi. Tekshiring:", { reply_markup: fileCheckKeyboard });
            } else {
                await ctx.reply("❌ Matnni saqlashda xatolik. Qaytadan urinib ko'ring.");
            }
        } catch (e) {
            console.error(e);
            await ctx.reply("❌ Xatolik yuz berdi.");
        }
        return;
    }
});

// --- TRANSCRIPTION CALLBACK HANDLERS (InlineKeyboard) ---

// Gender selection callbacks
bot.callbackQuery("trans_gender_male", async (ctx) => {
    await handleTranscriptionGender(ctx, 'male');
});

bot.callbackQuery("trans_gender_female", async (ctx) => {
    await handleTranscriptionGender(ctx, 'female');
});

async function handleTranscriptionGender(ctx: any, gender: 'male' | 'female') {
    await ctx.answerCallbackQuery();

    const userId = ctx.from.id;
    const stateRow = await dbService.getState(userId);

    if (!stateRow || stateRow.state_type !== 'transcription' || !isValidState(stateRow.data) || !stateRow.data.tempText) {
        await ctx.reply("❌ Vazifa muddati tugagan yoki topilmadi.");
        return;
    }

    const { fileKey, tempText } = stateRow.data;

    // Save gender to state
    stateRow.data.gender = gender;
    await dbService.saveState(userId, 'transcription_confirm', stateRow.data);

    // Show confirmation screen
    const fileName = fileKey.split('/').pop()?.replace('.wav', '') || fileKey;

    await ctx.reply(
        `📝 <b>TRANSKRIPSIYA - TASDIQLASH</b>\n\n` +
        `🆔 <code>${fileName}</code>\n\n` +
        `<b>Matn:</b>\n<code>${tempText}</code>\n\n` +
        `<b>Jins:</b> ${gender === 'male' ? '👨 Erkak' : '👩 Ayol'}\n\n` +
        `<i>⬇️ Tasdiqlaysizmi?</i>`,
        {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
                .text("✅ Tasdiqlash", "trans_confirm")
                .text("❌ Rad etish", "trans_deny")
                .row()
                .text("✏️ Matnni tahrirlash", "trans_edit_text")
                .text("✏️ Jinsni o'zgartirish", "trans_edit_gender")
        }
    );
}

// CONFIRM - Save transcription to S3
bot.callbackQuery("trans_confirm", async (ctx) => {
    await ctx.answerCallbackQuery("Saqlanmoqda...");

    const userId = ctx.from.id;
    const stateRow = await dbService.getState(userId);

    if (!stateRow || stateRow.state_type !== 'transcription_confirm' || !isValidState(stateRow.data)) {
        await ctx.reply("❌ Vazifa topilmadi.");
        return;
    }

    const { fileKey, tempText, gender } = stateRow.data;

    if (!tempText || !gender) {
        await ctx.reply("❌ Ma'lumotlar to'liq emas.");
        return;
    }

    try {
        // Extract duration
        let duration = 0;
        const audioBuffer = await s3Service.getTranscriptionAudioBuffer(fileKey);
        if (audioBuffer) {
            try {
                if (Buffer.isBuffer(audioBuffer) || audioBuffer instanceof Uint8Array) {
                    const metadata = await parseBuffer(new Uint8Array(audioBuffer));
                    duration = Math.floor((metadata.format.duration || 0) * 1000);
                }
            } catch (err) {
                Logger.warn('Failed to parse audio duration', { error: err, fileKey });
            }
        }

        // Copy S3 with metadata
        await s3Service.copyTranscriptionToSorted(fileKey, tempText, Math.round(duration), gender);

        // Update DB
        await dbService.updateTranscriptionFileStatus(userId, fileKey, 'ACCEPTED', tempText);

        await dbService.deleteState(userId);

        await ctx.reply(
            `✅ <b>Transkripsiya saqlandi!</b>\n\n` +
            `📂 <b>Jinsi:</b> ${gender === 'male' ? 'Erkak' : 'Ayol'}\n` +
            `⏱ <b>Davomiyligi:</b> ${Math.round(duration)}ms\n` +
            `<b>Matn:</b>\n<code>${tempText}</code>\n\n` +
            `Davom etamizmi?`,
            {
                parse_mode: "HTML",
                reply_markup: new Keyboard()
                    .text("📝 Transkripsiya")
                    .text("⬅️ Asosiy menyu")
                    .resized()
            }
        );

    } catch (e) {
        Logger.error('Bot command error', e, { userId });
        await ctx.reply("❌ Xatolik yuz berdi.");
    }
});

// DENY - Remove from DB only (don't delete from S3)
bot.callbackQuery("trans_deny", async (ctx) => {
    await ctx.answerCallbackQuery("Rad etildi");

    const userId = ctx.from.id;
    const stateRow = await dbService.getState(userId);

    if (!stateRow || (stateRow.state_type !== 'transcription_confirm' && stateRow.state_type !== 'transcription')) {
        await ctx.reply("❌ Vazifa topilmadi.");
        return;
    }

    const { fileKey } = stateRow.data;

    try {
        // Release file back to pending (don't delete from S3)
        await dbService.releaseTranscriptionFile(userId, fileKey);
        await dbService.deleteState(userId);

        await ctx.reply("❌ Rad etildi! Davom etamizmi?", {
            reply_markup: new Keyboard()
                .text("📝 Transkripsiya")
                .text("⬅️ Asosiy menyu")
                .resized()
        });
    } catch (e) {
        Logger.error('Error denying transcription', e, { userId });
        await ctx.reply("❌ Xatolik yuz berdi.");
    }
});

// EDIT TEXT - Allow re-entering transcription text
bot.callbackQuery("trans_edit_text", async (ctx) => {
    await ctx.answerCallbackQuery();

    const userId = ctx.from.id;
    const stateRow = await dbService.getState(userId);

    if (!stateRow || !isValidState(stateRow.data) || !stateRow.data.fileKey) {
        await ctx.reply("❌ Vazifa topilmadi.");
        return;
    }

    const { fileKey, tempText } = stateRow.data;

    // Switch back to transcription state for text input
    await dbService.saveState(userId, 'transcription', { fileKey });

    await ctx.reply(
        `✏️ <b>Matnni tahrirlash</b>\n\n` +
        `<b>Hozirgi matn:</b>\n<code>${tempText || 'Mavjud emas'}</code>\n\n` +
        `<i>Yangi matnni yozib yuboring:</i>`,
        {
            parse_mode: "HTML",
            reply_markup: transcriptionKeyboard
        }
    );
});

// EDIT GENDER - Go back to gender selection
bot.callbackQuery("trans_edit_gender", async (ctx) => {
    await ctx.answerCallbackQuery();

    const userId = ctx.from.id;
    const stateRow = await dbService.getState(userId);

    if (!stateRow || stateRow.state_type !== 'transcription_confirm' || !isValidState(stateRow.data)) {
        await ctx.reply("❌ Vazifa topilmadi.");
        return;
    }

    const { fileKey, tempText } = stateRow.data;

    // Switch back to transcription state (keep text)
    await dbService.saveState(userId, 'transcription', { fileKey, tempText });

    await ctx.reply("Jinsni qayta tanlang:", {
        reply_markup: new InlineKeyboard()
            .text("👨 Erkak", "trans_gender_male")
            .text("👩 Ayol", "trans_gender_female")
    });
});

// --- INLINE KEYBOARD HANDLERS (For Admin Only) ---

// Admin Stats
bot.callbackQuery("admin_stats", async (ctx) => {
    const user = await dbService.getUser(ctx.from.id);
    if (!user?.is_admin) return ctx.answerCallbackQuery("Admin emassiz");

    await ctx.answerCallbackQuery("Grafik chizilmoqda...");

    const stats = await dbService.getAllUserStats();
    const pending = await dbService.getPendingCount();

    const totalAccepted = stats.reduce((sum: number, s: any) => sum + (s.accepted_count || 0), 0);
    const totalRejected = stats.reduce((sum: number, s: any) => sum + (s.rejected_count || 0), 0);

    let caption = `📊 <b>ADMIN STATISTIKA</b>\n\n`;
    caption += `<code>┌──────────────────────────────┐</code>\n`;
    caption += `<code>│</code> ⏳ Kutilmoqda:    <code>${String(pending).padStart(8)}</code> <code>│</code>\n`;
    caption += `<code>│</code> ✅ Jami qabul:    <code>${String(totalAccepted).padStart(8)}</code> <code>│</code>\n`;
    caption += `<code>│</code> ❌ Jami rad:      <code>${String(totalRejected).padStart(8)}</code> <code>│</code>\n`;
    caption += `<code>└──────────────────────────────┘</code>\n\n`;

    caption += `👥 <b>Annotatorlar:</b>\n\n`;
    for (const s of stats) {
        const name = (s.full_name || "Noma'lum").substring(0, 12).padEnd(12);
        const acc = String(s.accepted_count || 0).padStart(4);
        const rej = String(s.rejected_count || 0).padStart(4);
        const balance = String(s.balance || 0).padStart(6);
        caption += `<code>${name}</code> ✅<code>${acc}</code> ❌<code>${rej}</code> 💰<code>${balance}</code>\n`;
    }

    const imageBuffer = await statsService.generateAdminStatsChart(stats);
    await ctx.replyWithPhoto(new InputFile(imageBuffer), {
        caption: caption,
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("🏠 Asosiy menyu", "main_menu_inline")
    });
});

// Inline main menu callback (for going back from admin stats)
bot.callbackQuery("main_menu_inline", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showMainMenu(ctx);
});

bot.callbackQuery("admin_sync", async (ctx) => {
    const user = await dbService.getUser(ctx.from.id);
    if (!user?.is_admin) return;

    await ctx.answerCallbackQuery("Sync boshlandi...");
    await ctx.reply("S3 Sync boshlandi. Bu biroz vaqt olishi mumkin...");

    s3Service.syncFiles().then(async () => {
        await ctx.reply("Sync tugadi! ✅");
        const pendingCount = await dbService.getPendingCount();
        await ctx.reply(`Jami pending fayllar: ${pendingCount}`);
    }).catch(async (err) => {
        console.error("Sync error:", err);
        await ctx.reply(`⚠️ Sync xatolik bilan tugadi:\n${err.message}`);
    });
});

bot.callbackQuery("admin_transcription_sync", async (ctx) => {
    const user = await dbService.getUser(ctx.from.id);
    if (!user?.is_admin) return;

    await ctx.answerCallbackQuery("Transkripsiya Sync boshlandi...");
    await ctx.reply("Transkripsiya S3 Sync boshlandi. Bu biroz vaqt olishi mumkin...");

    s3Service.syncTranscriptionFiles().then(async () => {
        await ctx.reply("Transkripsiya Sync tugadi! ✅");
        const pendingCount = await dbService.getTranscriptionPendingCount();
        await ctx.reply(`Jami transkripsiya fayllar: ${pendingCount}`);
    }).catch(async (err) => {
        console.error("Transcription Sync error:", err);
        await ctx.reply(`⚠️ Sync xatolik bilan tugadi:\n${err.message}`);
    });
});

// Clear all PENDING files and re-sync from fresh
bot.callbackQuery("admin_clear_and_sync", async (ctx) => {
    const user = await dbService.getUser(ctx.from.id);
    if (!user?.is_admin) return;

    await ctx.answerCallbackQuery("Tozalash boshlandi...");
    await ctx.reply("⏳ Barcha PENDING fayllar tozalanmoqda...");

    try {
        // Clear all PENDING files
        const clearedSTT = await dbService.clearAllPendingFiles();
        const clearedTrans = await dbService.clearAllPendingTranscriptionFiles();

        await ctx.reply(`🗑 Tozalandi: ${clearedSTT} STT, ${clearedTrans} transkripsiya fayllar`);
        await ctx.reply("🔄 Yangidan sync qilinmoqda (2026-02-09 dan)...");

        // Re-sync STT
        await s3Service.syncFiles();
        const pendingSTT = await dbService.getPendingCount();

        // Re-sync Transcription
        await s3Service.syncTranscriptionFiles();
        const pendingTrans = await dbService.getTranscriptionPendingCount();

        await ctx.reply(`✅ Sync tugadi!\n📁 STT: ${pendingSTT}\n📝 Transkripsiya: ${pendingTrans}`);
    } catch (err: any) {
        console.error("Clear and sync error:", err);
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
            await ctx.reply("Audio faylni yuklab bo'lmadi (S3 error).", { reply_markup: sttSubmenuKeyboard });
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

        const audioBuffer = await s3Service.getTranscriptionAudioBuffer(fileKey);

        if (!audioBuffer) {
            await ctx.reply("Audio faylni yuklab bo'lmadi (S3 error).", { reply_markup: mainMenuKeyboard });
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
