import { Bot, InlineKeyboard, Context, NextFunction, InputFile } from 'grammy';
import { config } from './config';
import { s3Service } from './services/s3';
import { dbService } from './services/db';
import { statsService } from './services/stats';

const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

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
    await ctx.reply(`Assalomu alaykum, ${ctx.from?.first_name}!\nSTT Checking botiga xush kelibsiz.`, {
        reply_markup: new InlineKeyboard()
            .text("🎧 STT Tekshirish", "check_next")
            .text("📊 Statistikam", "my_stats")
    });
});

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
    const user = await dbService.getUser(ctx.from?.id!);
    if (!user?.is_admin) return;

    const parts = ctx.match.toString().split(' ');
    const id = Number(parts[0]);
    const name = parts.slice(1).join(' ');

    if (!id || !name) return ctx.reply("Format: /add_user [id] [name]");

    await dbService.addUser(id, name, 0);
    await ctx.reply(`Foydalanuvchi qo'shildi: ${name} (${id})`);
});

// --- ACTIONS ---

bot.callbackQuery("check_next", async (ctx) => {
    await ctx.answerCallbackQuery("Yuklanmoqda...");
    await sendNextFile(ctx);
});

bot.callbackQuery("my_stats", async (ctx) => {
    const stats = await dbService.getUserStats(ctx.from.id);
    await ctx.reply(`📊 <b>Sizning Statistikangiz:</b>\n\n✅ Qabul qilindi: ${stats.accepted}\n❌ Rad etildi: ${stats.rejected}`, {
        parse_mode: "HTML"
    });
    await ctx.answerCallbackQuery();
});

// Admin Stats
bot.callbackQuery("admin_stats", async (ctx) => {
    const user = await dbService.getUser(ctx.from.id);
    if (!user?.is_admin) return ctx.answerCallbackQuery("Admin emassiz");

    await ctx.answerCallbackQuery("Grafik chizilmoqda...");
    const imageBuffer = await statsService.generateAdminStatsChart();
    await ctx.replyWithPhoto(new InputFile(imageBuffer), { caption: "Umumiy Statistika" });
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

        // 4. Offer Next
        await ctx.reply("Davom etamizmi?", {
            reply_markup: new InlineKeyboard().text("Keyingisi ➡️", "check_next")
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
            reply_markup: new InlineKeyboard().text("Keyingisi ➡️", "check_next")
        });
    } catch (e) { console.error(e); }
});


// Helper
async function sendNextFile(ctx: any) {
    const userId = ctx.from.id;
    try {
        const fileKey = await dbService.lockNextFile(userId);

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
        const audioUrl = await s3Service.getAudioUrl(fileKey);

        // Truncate text if too long
        let text = json.text || 'Noma\'lum';
        if (text.length > 800) text = text.substring(0, 800) + "...";

        const caption = `🆔 <code>${json.utt_id || fileKey}</code>\n\n📝 ${text}`;

        await ctx.replyWithAudio(audioUrl, {
            caption: caption,
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
                .text("✅ To'g'ri", `accept:${fileKey}`)
                .text("❌ Xato", `reject:${fileKey}`)
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

async function startBot() {
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

    await bot.start();
}

startBot().catch((err) => {
    console.error('Failed to start bot', err);
    process.exit(1);
});
