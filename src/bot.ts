import { Bot, InlineKeyboard, Context, NextFunction, InputFile } from 'grammy';
import { config } from './config';
import { s3Service } from './services/s3';
import { dbService } from './services/db';
import { statsService } from './services/stats';

export const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

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

    let text = `🏠 <b>Asosiy Menyu</b>\n\n`;
    text += `Assalomu alaykum, <b>${ctx.from?.first_name}</b>!\n\n`;
    text += `📊 <b>Sizning statistikangiz:</b>\n`;
    text += `   ✅ Qabul qilindi: ${stats.accepted}\n`;
    text += `   ❌ Rad etildi: ${stats.rejected}\n`;
    if (user?.balance) {
        text += `   💰 Balans: ${user.balance} so'm\n`;
    }

    await ctx.reply(text, {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
            .text("🎧 STT Tekshirish", "check_next")
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
            .text("🔄 S3 Sync", "admin_sync")
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
    const checksToday = await dbService.get24hCheckCount(ctx.from.id);

    let text = `📊 <b>Sizning Statistikangiz:</b>\n\n`;
    text += `✅ Jami qabul qilindi: ${stats.accepted}\n`;
    text += `❌ Jami rad etildi: ${stats.rejected}\n`;
    text += `📅 Bugun tekshirildi: ${checksToday}\n`;
    if (user?.balance) {
        text += `💰 Balans: ${user.balance} so'm\n`;
    }
    text += `\n<i>20 ta bepul tekshirish, keyin har biri 50 so'm</i>`;

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
        `• Har kuni 20 ta bepul, keyin 50 so'm`,
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

    // Generate Text Summary
    let caption = "<b>📊 Umumiy Statistika:</b>\n\n";
    for (const s of stats) {
        const name = s.full_name || "Noma'lum";
        caption += `👤 <b>${name}</b>\n   ✅ ${s.accepted_count}   ❌ ${s.rejected_count}\n\n`;
    }

    const imageBuffer = await statsService.generateAdminStatsChart(stats);
    await ctx.replyWithPhoto(new InputFile(imageBuffer), {
        caption: caption,
        parse_mode: "HTML"
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
        // 20 free checks per 24 hours. After that 50 som per check.
        const checksToday = await dbService.get24hCheckCount(ctx.from.id);
        // We just added one (Wait, dbService.updateFileStatus marks it processed NOW).
        // Since we verify AFTER update, checksToday includes the current one.
        // So if checksToday > 20, we pay.
        // Example: 20th check -> checksToday=20. No pay.
        // 21st check -> checksToday=21. Pay.
        if (checksToday > 20) {
            await dbService.incrementBalance(ctx.from.id, 50);
        }

        // 4. Offer Next
        await ctx.reply("Davom etamizmi?", {
            reply_markup: new InlineKeyboard()
                .text("Keyingisi ➡️", "check_next")
                .text("🏠 Menyu", "main_menu")
        });

    } catch (e) {
        console.error(e);
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
    } catch (e) { console.error(e); }
});

// --- EDIT TEXT HANDLER ---
// Store edit state per user
const editState: Map<number, { fileKey: string; originalText: string }> = new Map();

bot.callbackQuery(/^edit:(.+)$/, async (ctx) => {
    const key = ctx.match[1];
    await ctx.answerCallbackQuery();

    try {
        const json = await s3Service.getJsonContent(key);
        const originalText = json.text || '';

        // Store the edit state
        editState.set(ctx.from.id, { fileKey: key, originalText });

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
        console.error(e);
        await ctx.reply("Xatolik yuz berdi.");
    }
});

bot.callbackQuery(/^cancel_edit:(.+)$/, async (ctx) => {
    editState.delete(ctx.from.id);
    await ctx.answerCallbackQuery("Bekor qilindi");
    await ctx.reply("Tahrirlash bekor qilindi.", {
        reply_markup: new InlineKeyboard()
            .text("Keyingisi ➡️", "check_next")
            .text("🏠 Menyu", "main_menu")
    });
});

// Handle text messages for editing
bot.on("message:text", async (ctx) => {
    const userId = ctx.from.id;
    const state = editState.get(userId);

    if (!state) {
        // Not in edit mode, ignore or show help
        return;
    }

    const newText = ctx.message.text.trim();
    const { fileKey } = state;

    try {
        // Update JSON in S3
        const success = await s3Service.updateJsonText(fileKey, newText);

        if (success) {
            // Copy to sorted folder
            await s3Service.copyToSorted(fileKey);
            // Update DB status
            await dbService.updateFileStatus(userId, fileKey, 'ACCEPTED');

            // Payment logic
            const checksToday = await dbService.get24hCheckCount(userId);
            if (checksToday > 20) {
                await dbService.incrementBalance(userId, 50);
            }

            editState.delete(userId);

            await ctx.reply(
                `✅ <b>Matn tahrirlandi va saqlandi!</b>\n\n` +
                `<b>Yangi matn:</b>\n<code>${newText}</code>`,
                {
                    parse_mode: "HTML",
                    reply_markup: new InlineKeyboard()
                        .text("Keyingisi ➡️", "check_next")
                        .text("🏠 Menyu", "main_menu")
                }
            );
        } else {
            await ctx.reply("❌ Matnni saqlashda xatolik. Qaytadan urinib ko'ring.");
        }
    } catch (e) {
        console.error(e);
        await ctx.reply("Xatolik yuz berdi.");
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
        console.error(e);
        await ctx.reply("Xatolik yuz berdi.");
    }
});


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

        const json = await s3Service.getJsonContent(fileKey);
        // Instead of URL, download the file
        const audioBuffer = await s3Service.getFileBuffer(fileKey);

        if (!audioBuffer) {
            await ctx.reply("Audio faylni yuklab bo'lmadi (S3 error).");
            return;
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
    setInterval(() => {
        dbService.releaseTimedOutFiles(config.LOCK_TIMEOUT_MS)
            .then((released) => {
                const count = released ?? 0;
                if (count > 0) console.log(`Released ${count} timed out files.`);
            })
            .catch((err) => console.error('Error releasing locks', err));
    }, 5 * 60 * 1000);

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
