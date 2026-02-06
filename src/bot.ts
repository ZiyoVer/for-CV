import { Bot, InlineKeyboard, Context, NextFunction, InputFile } from 'grammy';
import { config } from './config';
import { s3Service } from './services/s3';
import { dbService } from './services/db';
import { statsService } from './services/stats';
import { parseBuffer } from 'music-metadata';
import { Logger } from './utils/logger';

export const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

// Track intervals for cleanup
const intervals: NodeJS.Timeout[] = [];

// State management types
interface BotState {
    fileKey?: string;
    tempText?: string;
    [key: string]: any;
}

function isValidState(data: any): data is BotState {
    return data && typeof data === 'object';
}

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
        reply_markup: new InlineKeyboard()
            .text("🎧 STT Tekshirish", "check_next")
            .text("📝 Transkripsiya", "transcription_next")
            .row()
            .text("📊 Batafsil Statistika", "my_stats")
            .text("ℹ️ Yordam", "help_info")
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
    });
});

// /add_user 12345 Name
bot.command('add_user', async (ctx) => {
    await ctx.reply("Bu funksiya endi Web panel orqali ishlaydi.");
});

// --- ACTIONS ---

bot.callbackQuery("check_next", async (ctx) => {
    await ctx.answerCallbackQuery("Yuklanmoqda...");
    await sendNextFile(ctx);
});

bot.callbackQuery("main_menu", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showMainMenu(ctx);
});

bot.callbackQuery("my_stats", async (ctx) => {
    const user = await dbService.getUser(ctx.from.id);
    const stats = await dbService.getUserStats(ctx.from.id);
    const transStats = await dbService.getUserTranscriptionStats(ctx.from.id);
    const checksToday = await dbService.get24hCheckCount(ctx.from.id);
    const transToday = await dbService.get24hTranscriptionCount(ctx.from.id);
    const totalChecked = stats.accepted + stats.rejected;
    const accuracy = totalChecked > 0 ? Math.round((stats.accepted / totalChecked) * 100) : 0;
    const freeLeft = Math.max(0, config.FREE_CHECKS_LIMIT - checksToday);

    let text = `📊 <b>Batafsil Statistika</b>\n\n`;

    // STT Section
    text += `<b>🎧 STT TEKSHIRUV</b>\n`;
    text += `<code>╔═══════════════════════════╗</code>\n`;
    text += `<code>║</code> ✅ Qabul qilindi: <code>${String(stats.accepted).padStart(6)}</code> <code>║</code>\n`;
    text += `<code>║</code> ❌ Rad etildi:    <code>${String(stats.rejected).padStart(6)}</code> <code>║</code>\n`;
    text += `<code>║</code> 📝 Jami:          <code>${String(totalChecked).padStart(6)}</code> <code>║</code>\n`;
    text += `<code>║</code> 🎯 Aniqlik:       <code>${String(accuracy).padStart(5)}%</code> <code>║</code>\n`;
    text += `<code>╠═══════════════════════════╣</code>\n`;
    text += `<code>║</code> 📅 Bugun:         <code>${String(checksToday).padStart(6)}</code> <code>║</code>\n`;
    text += `<code>║</code> 🎁 Bepul qoldi:   <code>${String(freeLeft).padStart(6)}</code> <code>║</code>\n`;
    if (user?.balance !== undefined) {
        text += `<code>╠═══════════════════════════╣</code>\n`;
        text += `<code>║</code> 💰 Balans:    <code>${String(user.balance).padStart(6)}</code> so'm<code>║</code>\n`;
    }
    text += `<code>╚═══════════════════════════╝</code>\n`;
    text += `<i>💡 ${config.FREE_CHECKS_LIMIT} ta bepul, keyin ${config.CHECK_PRICE} so'm</i>\n\n`;

    // Transcription Section
    text += `<b>📝 TRANSKRIPSIYA</b>\n`;
    text += `<code>╔═══════════════════════════╗</code>\n`;
    text += `<code>║</code> ✅ Bajarildi:     <code>${String(transStats.accepted).padStart(6)}</code> <code>║</code>\n`;
    text += `<code>║</code> 📅 Bugun:         <code>${String(transToday).padStart(6)}</code> <code>║</code>\n`;
    text += `<code>╚═══════════════════════════╝</code>\n`;
    text += `<i>💡 Transkripsiya bepul</i>`;

    await ctx.reply(text, {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("🏠 Asosiy menyu", "main_menu")
    });
    await ctx.answerCallbackQuery();
});

bot.callbackQuery("help_info", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
        `ℹ️ <b>Yordam</b>\n\n` +
        `<b>Tugmalar:</b>\n` +
        `✅ <b>To'g'ri</b> - Audio va matn to'g'ri\n` +
        `❌ <b>Xato</b> - Audio yoki matnda xato bor\n` +
        `✏️ <b>Tahrirlash</b> - Matnni to'g'rilash\n` +
        `⏭️ <b>O'tkazish</b> - Faylni o'tkazib yuborish\n\n` +
        `<b>Qoidalar:</b>\n` +
        `• Audiodagi matnni diqqat bilan tinglang\n` +
        `• Agar matn to'g'ri bo'lsa "To'g'ri" bosing\n` +
        `• Agar xato bo'lsa "Xato" yoki "Tahrirlash" bosing\n` +
        `• Har kuni ${config.FREE_CHECKS_LIMIT} ta bepul, keyin ${config.CHECK_PRICE} so'm`,
        {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("🏠 Asosiy menyu", "main_menu")
        }
    );
});

// Admin Stats
bot.callbackQuery("admin_stats", async (ctx) => {
    const user = await dbService.getUser(ctx.from.id);
    if (!user?.is_admin) return ctx.answerCallbackQuery("Admin emassiz");

    await ctx.answerCallbackQuery("Grafik chizilmoqda...");

    const stats = await dbService.getAllUserStats();
    const pending = await dbService.getPendingCount();

    // Calculate totals
    const totalAccepted = stats.reduce((sum: number, s: any) => sum + (s.accepted_count || 0), 0);
    const totalRejected = stats.reduce((sum: number, s: any) => sum + (s.rejected_count || 0), 0);

    // Generate Text Summary with table
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
        reply_markup: new InlineKeyboard().text("🏠 Asosiy menyu", "main_menu")
    });
});

bot.callbackQuery("admin_sync", async (ctx) => {
    const user = await dbService.getUser(ctx.from.id);
    if (!user?.is_admin) return;

    await ctx.answerCallbackQuery("Sync boshlandi...");
    await ctx.reply("S3 Sync boshlandi. Bu biroz vaqt olishi mumkin...");

    // Run async, don't block
    s3Service.syncFiles().then(async () => {
        await ctx.reply("Sync tugadi! ✅");
        const pendingCount = await dbService.getPendingCount();
        await ctx.reply(`Jami pending fayllar: ${pendingCount}`);
    }).catch(async (err) => {
        console.error("Sync error:", err);
        await ctx.reply(`⚠️ Sync xatolik bilan tugadi:\n${err.message}`);
    });
});


// Accept/Reject Logic
bot.callbackQuery(/^accept:(.+)$/, async (ctx) => {
    const key = ctx.match[1];

    try {
        await ctx.answerCallbackQuery("Qabul qilindi ✅");

        // 1. Copy S3
        await s3Service.copyToSorted(key);
        // 2. DB Update
        await dbService.updateFileStatus(ctx.from.id, key, 'ACCEPTED');

        // 3. Edit Msg
        await ctx.editMessageCaption({
            caption: `${ctx.callbackQuery.message?.caption}\n\n✅ **Qabul qilindi**`
        });

        // PAYMENT LOGIC
        // First N checks are free per 24 hours. After that, charge per check.
        const checksToday = await dbService.get24hCheckCount(ctx.from.id);
        // We just added one (dbService.updateFileStatus marks it processed NOW).
        // Since we verify AFTER update, checksToday includes the current one.
        // So if checksToday > FREE_CHECKS_LIMIT, we charge.
        // Example: 20th check -> checksToday=20. No charge.
        // 21st check -> checksToday=21. Charge.
        if (checksToday > config.FREE_CHECKS_LIMIT) {
            await dbService.incrementBalance(ctx.from.id, config.CHECK_PRICE);
            await ctx.reply(`💳 ${config.CHECK_PRICE} so'm hisobdan yechildi. Kunlik bepul limit: ${config.FREE_CHECKS_LIMIT}`);
        }

        // 4. Offer Next
        await ctx.reply("Davom etamizmi?", {
            reply_markup: new InlineKeyboard()
                .text("Keyingisi ➡️", "check_next")
                .text("🏠 Menyu", "main_menu")
        });

    } catch (e) {
        Logger.error('Bot command error', e, { userId: ctx.from?.id });
        await ctx.reply("Xatolik yuz berdi.");
    }
});

bot.callbackQuery(/^reject:(.+)$/, async (ctx) => {
    const key = ctx.match[1];
    try {
        await ctx.answerCallbackQuery("Rad etildi ❌");
        await dbService.updateFileStatus(ctx.from.id, key, 'REJECTED');

        await ctx.editMessageCaption({
            caption: `${ctx.callbackQuery.message?.caption}\n\n❌ **Rad etildi**`
        });

        await ctx.reply("Davom etamizmi?", {
            reply_markup: new InlineKeyboard()
                .text("Keyingisi ➡️", "check_next")
                .text("🏠 Menyu", "main_menu")
        });
    } catch (e) {
        Logger.error('Error rejecting file', e, { userId: ctx.from?.id });
        await ctx.reply("Xatolik yuz berdi.").catch(() => {});
    }
});

// --- EDIT TEXT HANDLER ---
// State is now handling via DB (bot_state table)

bot.callbackQuery(/^edit:(.+)$/, async (ctx) => {
    const key = ctx.match[1];
    await ctx.answerCallbackQuery();

    try {
        // Clear any existing state first
        await dbService.deleteState(ctx.from.id);

        const json = await s3Service.getJsonContent(key);
        const originalText = json.text || '';

        // Store the edit state (PERSISTED)
        await dbService.saveState(ctx.from.id, 'edit', { fileKey: key, originalText });

        await ctx.reply(
            `✏️ <b>Matnni tahrirlash</b>\n\n` +
            `<b>Hozirgi matn:</b>\n<code>${originalText}</code>\n\n` +
            `<i>To'g'ri matnni pastga yozing:</i>`,
            {
                parse_mode: "HTML",
                reply_markup: new InlineKeyboard().text("❌ Bekor qilish", `cancel_edit:${key}`)
            }
        );
    } catch (e) {
        Logger.error('Bot command error', e, { userId: ctx.from?.id });
        await ctx.reply("Xatolik yuz berdi.");
    }
});

bot.callbackQuery(/^cancel_edit:(.+)$/, async (ctx) => {
    await dbService.deleteState(ctx.from.id);
    await ctx.answerCallbackQuery("Bekor qilindi");
    await ctx.reply("Tahrirlash bekor qilindi.", {
        reply_markup: new InlineKeyboard()
            .text("Keyingisi ➡️", "check_next")
            .text("🏠 Menyu", "main_menu")
    });
});

// Handle text messages for editing AND transcription
bot.on("message:text", async (ctx) => {
    const userId = ctx.from.id;
    const stateRow = await dbService.getState(userId);

    // If no state, ignore
    if (!stateRow) {
        return;
    }

    const { state_type: type, data } = stateRow;
    const newText = ctx.message.text.trim();

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
        const caption = `📝 <b>TRANSKRIPSIYA (Tekshirish)</b>\n\n🆔 <code>${fileName}</code>\n\n<b>Siz yozgan matn:</b>\n<code>${newText}</code>\n\n<i>⬇️ Iltimos, audioni tinglab, so'zlovchi jinsini tanlang:</i>`;

        await ctx.replyWithAudio(new InputFile(audioBuffer), {
            caption: caption,
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
                .text("✅ Erkak", "approve_trans:male")
                .text("✅ Ayol", "approve_trans:female")
                .row()
                .text("✏️ Tahrirlash", "transcription_edit_retry") // Keeps state, allowing re-entry
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
                // Done editing
                await dbService.deleteState(userId);

                // Fetch audio again
                const audioBuffer = await s3Service.getFileBuffer(fileKey);
                if (!audioBuffer) {
                    await ctx.reply("Matn saqlandi, lekin audio faylni qayta yuklab bo'lmadi.");
                    return;
                }

                const caption = `🆔 <code>${fileKey.split('/').pop()?.replace('.json', '') || fileKey}</code>\n\n📝 ${newText}\n\n<i>(Tahrirlangan)</i>`;

                await ctx.replyWithAudio(new InputFile(audioBuffer), {
                    caption: caption,
                    parse_mode: "HTML",
                    reply_markup: new InlineKeyboard()
                        .text("✅ To'g'ri", `accept:${fileKey}`)
                        .text("❌ Xato", `reject:${fileKey}`)
                        .row()
                        .text("✏️ Tahrirlash", `edit:${fileKey}`)
                        .text("⏭️ O'tkazish", `skip:${fileKey}`)
                        .row()
                        .text("🏠 Asosiy menyu", "main_menu")
                });
            } else {
                await ctx.reply("❌ Matnni saqlashda xatolik. Qaytadan urinib ko'ring.");
            }
        } catch (e) {
            console.error(e);
            await ctx.reply("Xatolik yuz berdi.");
        }
    }
});

// --- SKIP FILE HANDLER ---
bot.callbackQuery(/^skip:(.+)$/, async (ctx) => {
    const key = ctx.match[1];
    await ctx.answerCallbackQuery("O'tkazildi ⏭️");

    try {
        // Release the file back to pending
        await dbService.releaseFile(ctx.from.id, key);

        await ctx.editMessageCaption({
            caption: `${ctx.callbackQuery.message?.caption}\n\n⏭️ **O'tkazildi**`
        });

        await ctx.reply("Fayl o'tkazildi. Keyingisiga o'tamizmi?", {
            reply_markup: new InlineKeyboard()
                .text("Keyingisi ➡️", "check_next")
                .text("🏠 Menyu", "main_menu")
        });
    } catch (e) {
        Logger.error('Bot command error', e, { userId: ctx.from?.id });
        await ctx.reply("Xatolik yuz berdi.");
    }
});


// --- TRANSCRIPTION HANDLERS ---

bot.callbackQuery("transcription_next", async (ctx) => {
    await ctx.answerCallbackQuery("Yuklanmoqda...");
    await sendNextTranscriptionFile(ctx);
});

bot.callbackQuery("transcription_skip", async (ctx) => {
    const stateRow = await dbService.getState(ctx.from.id);
    if (!stateRow || stateRow.state_type !== 'transcription' || !isValidState(stateRow.data)) {
        await ctx.answerCallbackQuery("Fayl topilmadi");
        return;
    }
    const key = stateRow.data.fileKey;
    await ctx.answerCallbackQuery("O'tkazildi ⏭️");

    try {
        // Clear transcription state
        await dbService.deleteState(ctx.from.id);

        // Release the file back to pending
        await dbService.releaseTranscriptionFile(ctx.from.id, key);

        await ctx.editMessageCaption({
            caption: `${ctx.callbackQuery.message?.caption}\n\n⏭️ **O'tkazildi**`
        });

        await ctx.reply("Fayl o'tkazildi. Keyingisiga o'tamizmi?", {
            reply_markup: new InlineKeyboard()
                .text("Keyingisi ➡️", "transcription_next")
                .text("🏠 Menyu", "main_menu")
        });
    } catch (e) {
        Logger.error('Bot command error', e, { userId: ctx.from?.id });
        await ctx.reply("Xatolik yuz berdi.");
    }
});

// Retry Edit (Cancellation of current review step, ready for new text)
bot.callbackQuery("transcription_edit_retry", async (ctx) => {
    await ctx.answerCallbackQuery();
    const stateRow = await dbService.getState(ctx.from.id);
    if (!stateRow || stateRow.state_type !== 'transcription' || !isValidState(stateRow.data)) {
        await ctx.reply("Vazifa topilmadi.");
        return;
    }

    await ctx.reply(
        `✏️ <b>Matnni tahrirlash</b>\n\n` +
        `<b>Hozirgi matn:</b>\n<code>${stateRow.data.tempText || ''}</code>\n\n` +
        `<i>To'g'ri matnni pastga yozing:</i>`,
        { parse_mode: "HTML" }
    );
});

// Approve Transcription (Male/Female)
bot.callbackQuery(/^approve_trans:(male|female)$/, async (ctx) => {
    const gender = ctx.match[1]; // male or female
    const userId = ctx.from.id;
    const stateRow = await dbService.getState(userId);

    if (!stateRow || stateRow.state_type !== 'transcription' || !isValidState(stateRow.data) || !stateRow.data.tempText) {
        await ctx.answerCallbackQuery("Vazifa muddati tugagan yoki topilmadi.");
        return;
    }

    const { fileKey, tempText } = stateRow.data;

    try {
        await ctx.answerCallbackQuery("Saqlanmoqda...");

        // Extract duration
        let duration = 0;
        const audioBuffer = await s3Service.getTranscriptionAudioBuffer(fileKey);
        if (audioBuffer) {
            try {
                // Validate buffer type before parsing
                if (Buffer.isBuffer(audioBuffer) || audioBuffer instanceof Uint8Array) {
                    const metadata = await parseBuffer(new Uint8Array(audioBuffer));
                    duration = Math.floor((metadata.format.duration || 0) * 1000); // to ms
                } else {
                    Logger.warn('Invalid audio buffer type for duration parsing', { fileKey, type: typeof audioBuffer });
                }
            } catch (err) {
                Logger.warn('Failed to parse audio duration', { error: err, fileKey });
                duration = 0; // Default fallback
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
            `<b>Matn:</b>\n<code>${tempText}</code>`,
            {
                parse_mode: "HTML",
                reply_markup: new InlineKeyboard()
                    .text("Keyingisi ➡️", "transcription_next")
                    .text("🏠 Menyu", "main_menu")
            }
        );

    } catch (e) {
        Logger.error('Bot command error', e, { userId: ctx.from?.id });
        await ctx.reply("Xatolik yuz berdi.");
    }
});

// Admin Transcription Sync
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

// Helper function for transcription
async function sendNextTranscriptionFile(ctx: any) {
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
                await ctx.reply(msg);
            } else {
                await ctx.reply("Hozircha barcha transkripsiya fayllar band. Birozdan so'ng urinib ko'ring.");
            }
            return;
        }

        // Get audio buffer (no text - this is transcription mode)
        const audioBuffer = await s3Service.getTranscriptionAudioBuffer(fileKey);

        if (!audioBuffer) {
            await ctx.reply("Audio faylni yuklab bo'lmadi (S3 error).");
            return;
        }

        // Store state for text input (PERSISTED)
        await dbService.saveState(userId, 'transcription', { fileKey });

        const fileName = fileKey.split('/').pop()?.replace('.wav', '') || fileKey;
        const caption = `📝 <b>TRANSKRIPSIYA</b>\n\n🆔 <code>${fileName}</code>\n\n<i>⬇️ Audioni tinglang va matnni yozing:</i>`;

        await ctx.replyWithAudio(new InputFile(audioBuffer), {
            caption: caption,
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
                .text("⏭️ O'tkazish", "transcription_skip")
                .text("🏠 Menyu", "main_menu")
        });

    } catch (e: any) {
        console.error("Error in sendNextTranscriptionFile:", e);
        let msg = "Faylni olishda xatolik.";
        if (e.message) msg += `\n(${e.message})`;
        await ctx.reply(msg);
    }
}


// Helper
async function sendNextFile(ctx: any) {
    const userId = ctx.from.id;
    let fileKey: string | null = null;

    try {
        fileKey = await dbService.lockNextFile(userId);

        if (!fileKey) {
            // Check if DB is empty, maybe need sync
            const pending = await dbService.getPendingCount();
            if (pending === 0) {
                const user = await dbService.getUser(userId);
                let msg = "Hozircha vazifalar yo'q.";
                if (user?.is_admin) {
                    msg += " (Admin panel orqali 'S3 Sync' qiling).";
                }
                await ctx.reply(msg);
            } else {
                await ctx.reply("Hozircha barcha fayllar band. Birozdan so'ng urinib ko'ring.");
            }
            return;
        }

        // Clear existing states
        await dbService.deleteState(userId);

        const json = await s3Service.getJsonContent(fileKey);
        // Instead of URL, download the file
        const audioBuffer = await s3Service.getFileBuffer(fileKey);

        if (!audioBuffer) {
            await ctx.reply("Audio faylni yuklab bo'lmadi (S3 error).");
            return;
        }

        // Warn for large files
        if (audioBuffer.length > 20 * 1024 * 1024) {
            await ctx.reply('⚠️ Fayl juda katta, yuklanishi biroz vaqt oladi...');
        }

        // Truncate text if too long
        let text = json.text || 'Noma\'lum';
        if (text.length > 800) text = text.substring(0, 800) + "...";

        const caption = `🆔 <code>${json.utt_id || fileKey}</code>\n\n📝 ${text}`;

        await ctx.replyWithAudio(new InputFile(audioBuffer), {
            caption: caption,
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
                .text("✅ To'g'ri", `accept:${fileKey}`)
                .text("❌ Xato", `reject:${fileKey}`)
                .row()
                .text("✏️ Tahrirlash", `edit:${fileKey}`)
                .text("⏭️ O'tkazish", `skip:${fileKey}`)
                .row()
                .text("🏠 Asosiy menyu", "main_menu")
        });

    } catch (e: any) {
        console.error("Error in sendNextFile:", e);
        let msg = "Faylni olishda xatolik.";
        if (e.message) msg += `\n(${e.message})`;
        await ctx.reply(msg);
    }
}


// Start
bot.catch((err) => console.error(err));

// Old startBot function removed - now using launchBot() below

export async function launchBot() {
    await dbService.init();
    console.log("Bot ishga tushmoqda...");

    // Periodically release locks (every 5 mins)
    const lockReleaseInterval = setInterval(() => {
        // Release STT files
        dbService.releaseTimedOutFiles(config.LOCK_TIMEOUT_MS)
            .then((released) => {
                const count = released ?? 0;
                if (count > 0) console.log(`Released ${count} timed out STT files.`);
            })
            .catch((err) => Logger.error('Error releasing STT locks', err));

        // Release Transcription files
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

    // Bot start will be handled by runner, but bot.start() blocks...
    // We should use bot.start() or bot.run() (runner). 
    // Since we want to run express alongside, we shouldn't await bot.start() infinitely if we were in the same process loop without async.
    // actually bot.start() runs concurrently if node.js is async. 
    // However, bot.start() manages the polling loop.

    // We will just call it and not await it to block? No, await is fine as long as express listens too.
    // Better: use runner. 
    // For simple polling:
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

    // Clear all intervals
    intervals.forEach(interval => clearInterval(interval));
    intervals.length = 0;

    // Stop bot
    bot.stop();

    console.log('Bot cleanup completed');
}
