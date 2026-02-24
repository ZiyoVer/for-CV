import { Bot, InlineKeyboard, Keyboard, Context, NextFunction, InputFile } from 'grammy';
import { config } from './config';
import { s3Service } from './services/s3';
import { dbService } from './services/db';
import { statsService } from './services/stats';
import { parseBuffer } from 'music-metadata';
import { Logger } from './utils/logger';
import path from 'path';
import { exec } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { promisify } from 'util';
// ffmpeg-static bundles ffmpeg binary inside node_modules — no system install needed
const ffmpegBin: string = require('ffmpeg-static');

const execAsync = promisify(exec);

async function slowDownAudio(audioBuffer: Buffer | Uint8Array): Promise<Buffer | null> {
    const rand = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const inputFile = path.join(os.tmpdir(), `stt_in_${rand}.wav`);
    const outputFile = path.join(os.tmpdir(), `stt_out_${rand}.wav`);
    try {
        fs.writeFileSync(inputFile, audioBuffer);
        await execAsync(`"${ffmpegBin}" -i "${inputFile}" -filter:a "atempo=0.75" -f wav "${outputFile}" -y`);
        const result = fs.readFileSync(outputFile);
        return Buffer.from(result);
    } catch (e) {
        Logger.error('FFmpeg slowdown failed', e);
        return null;
    } finally {
        try { fs.unlinkSync(inputFile); } catch {}
        try { fs.unlinkSync(outputFile); } catch {}
    }
}

async function trimAudio(audioBuffer: Buffer | Uint8Array, endSeconds: number): Promise<Buffer | null> {
    const rand = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const inputFile = path.join(os.tmpdir(), `stt_trim_in_${rand}.wav`);
    const outputFile = path.join(os.tmpdir(), `stt_trim_out_${rand}.wav`);
    try {
        fs.writeFileSync(inputFile, audioBuffer);
        await execAsync(`"${ffmpegBin}" -i "${inputFile}" -t ${endSeconds} -c copy "${outputFile}" -y`);
        const result = fs.readFileSync(outputFile);
        return Buffer.from(result);
    } catch (e) {
        Logger.error('FFmpeg trim failed', e);
        return null;
    } finally {
        try { fs.unlinkSync(inputFile); } catch {}
        try { fs.unlinkSync(outputFile); } catch {}
    }
}

// ─── Merged action keyboards ───
function sttActionKeyboard() {
    return new InlineKeyboard()
        .text("✅ To'g'ri", "stt_accept").text("❌ Xato", "stt_reject")
        .row()
        .text("✏️ Tahrirlash", "stt_edit").text("⏭️ O'tkazish", "stt_skip")
        .row()
        .text("🐢 Sekinlashtirish", "slow_stt");
}

function xorazmActionKeyboard() {
    return new InlineKeyboard()
        .text("✅ To'g'ri", "xrz_accept").text("❌ Xato", "xrz_deny")
        .row()
        .text("✏️ Tahrirlash", "xrz_edit").text("⏭️ O'tkazish", "xrz_skip")
        .row()
        .text("🐢 Sekinlashtirish", "slow_xorazm").text("✂️ Kesish", "trim_xorazm");
}

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
    const xorazmStats = await dbService.getUserXorazmStats(ctx.from.id);
    const checksToday = await dbService.get24hCheckCount(ctx.from.id);
    const transToday = await dbService.get24hTranscriptionCount(ctx.from.id);
    const xorazmToday = await dbService.get24hXorazmCount(ctx.from.id);
    const freeLeft = Math.max(0, config.FREE_CHECKS_LIMIT - checksToday);

    let text = `🏠 <b>Asosiy Menyu</b>\n\n`;
    text += `Salom, <b>${ctx.from?.first_name}</b>! 👋\n\n`;

    // STT Stats
    text += `🎧 <b>STT Tekshiruv (Adabiy):</b>\n`;
    text += `<code>┌─────────────────────────┐</code>\n`;
    text += `<code>│</code> ✅ Qabul:    <code>${String(stats.accepted).padStart(5)}</code> <code>│</code>\n`;
    text += `<code>│</code> ❌ Rad:      <code>${String(stats.rejected).padStart(5)}</code> <code>│</code>\n`;
    text += `<code>│</code> 📅 Bugun:    <code>${String(checksToday).padStart(5)}</code> <code>│</code>\n`;
    text += `<code>└─────────────────────────┘</code>\n`;

    // Xorazm Stats
    text += `🌍 <b>Xorazm shevasi:</b>\n`;
    text += `<code>┌─────────────────────────┐</code>\n`;
    text += `<code>│</code> ✅ Qabul:    <code>${String(xorazmStats.accepted).padStart(5)}</code> <code>│</code>\n`;
    text += `<code>│</code> ❌ Rad:      <code>${String(xorazmStats.rejected).padStart(5)}</code> <code>│</code>\n`;
    text += `<code>│</code> 📅 Bugun:    <code>${String(xorazmToday).padStart(5)}</code> <code>│</code>\n`;
    if (user?.balance) {
        text += `<code>├─────────────────────────┤</code>\n`;
        text += `<code>│</code> 💰 Balans: <code>${String(user.balance).padStart(6)}</code> <code>│</code>\n`;
    }
    text += `<code>└─────────────────────────┘</code>\n`;

    // Transcription Stats
    text += `📝 <b>Transkripsiya:</b>\n`;
    text += `<code>┌─────────────────────────┐</code>\n`;
    text += `<code>│</code> ✅ Bajarildi: <code>${String(transStats.accepted).padStart(4)}</code> <code>│</code>\n`;
    text += `<code>│</code> 📅 Bugun:     <code>${String(transToday).padStart(4)}</code> <code>│</code>\n`;
    text += `<code>└─────────────────────────┘</code>\n`;

    text += `🎁 Bepul qoldi: <b>${freeLeft}</b>/${config.FREE_CHECKS_LIMIT}\n\n`;

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
    await ctx.reply("Fayl yuklanmoqda...");
    await sendNextFile(ctx);
});

bot.hears("🌍 Xorazm viloyati", async (ctx) => {
    if (!ctx.from) return;
    await ctx.reply("Fayl yuklanmoqda...", { reply_markup: sttSubmenuKeyboard });
    await sendNextXorazmFile(ctx);
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

// --- STT FILE CHECK CALLBACKS (InlineKeyboard) ---

bot.callbackQuery("stt_accept", async (ctx) => {
    await ctx.answerCallbackQuery("Saqlanmoqda...");
    const userId = ctx.from.id;
    const stateRow = await dbService.getState(userId);

    if (!stateRow || !isValidState(stateRow.data) || !stateRow.data.fileKey) {
        await ctx.reply("❌ Faol fayl topilmadi. Iltimos, yangi fayl so'rang.");
        return;
    }

    const { fileKey, editedText } = stateRow.data;

    try {
        await s3Service.copyToSorted(fileKey, editedText);
        await dbService.updateFileStatus(userId, fileKey, 'ACCEPTED', editedText);
        await dbService.deleteState(userId);

        const checksToday = await dbService.get24hCheckCount(userId);
        if (checksToday > config.FREE_CHECKS_LIMIT) {
            await dbService.incrementBalance(userId, config.CHECK_PRICE);
            await ctx.reply(`💰 ${config.CHECK_PRICE} so'm hisobingizga qo'shildi! (Bepul limit: ${config.FREE_CHECKS_LIMIT})`);
        }

        await ctx.reply("✅ Qabul qilindi! Davom etamizmi?", {
            reply_markup: new Keyboard().text("📚 Adabiy gaplar").text("⬅️ Asosiy menyu").resized()
        });
    } catch (e) {
        Logger.error('stt_accept error', e, { userId });
        await ctx.reply("❌ Xatolik yuz berdi.");
    }
});

bot.callbackQuery("stt_reject", async (ctx) => {
    await ctx.answerCallbackQuery("Rad etildi");
    const userId = ctx.from.id;
    const stateRow = await dbService.getState(userId);

    if (!stateRow || !isValidState(stateRow.data) || !stateRow.data.fileKey) {
        await ctx.reply("❌ Faol fayl topilmadi. Iltimos, yangi fayl so'rang.");
        return;
    }

    try {
        await dbService.updateFileStatus(userId, stateRow.data.fileKey, 'REJECTED');
        await dbService.deleteState(userId);

        await ctx.reply("❌ Rad etildi! Davom etamizmi?", {
            reply_markup: new Keyboard().text("📚 Adabiy gaplar").text("⬅️ Asosiy menyu").resized()
        });
    } catch (e) {
        Logger.error('stt_reject error', e, { userId });
        await ctx.reply("❌ Xatolik yuz berdi.");
    }
});

bot.callbackQuery("stt_edit", async (ctx) => {
    await ctx.answerCallbackQuery();
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

        await dbService.saveState(userId, 'edit', { ...stateRow.data, fileKey: key, originalText });

        await ctx.reply(
            `✏️ <b>Matnni tahrirlash</b>\n\n` +
            `<b>Hozirgi matn:</b>\n<code>${originalText}</code>\n\n` +
            `<i>To'g'ri matnni yozib yuboring:</i>`,
            {
                parse_mode: "HTML",
                reply_markup: new InlineKeyboard().text("❌ Bekor qilish", "stt_cancel_edit")
            }
        );
    } catch (e) {
        Logger.error('stt_edit error', e, { userId });
        await ctx.reply("❌ Xatolik yuz berdi.");
    }
});

bot.callbackQuery("stt_cancel_edit", async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from.id;
    const stateRow = await dbService.getState(userId);

    if (!stateRow || !isValidState(stateRow.data) || !stateRow.data.fileKey) {
        await showMainMenu(ctx);
        return;
    }

    const { fileKey, editedText, trimEndSeconds } = stateRow.data;
    await dbService.saveState(userId, 'checking', { fileKey, editedText, trimEndSeconds });

    try {
        const json = await s3Service.getJsonContent(fileKey);
        const audioBuffer = await s3Service.getFileBuffer(fileKey);
        if (!audioBuffer) { await ctx.reply("Bekor qilindi."); return; }

        const text = editedText || json?.text || 'Noma\'lum';
        const caption = `🆔 <code>${json?.utt_id || fileKey}</code>\n\n📝 ${text}`;
        await ctx.replyWithAudio(new InputFile(audioBuffer), {
            caption, parse_mode: "HTML", reply_markup: sttActionKeyboard()
        });
    } catch (e) {
        await ctx.reply("Tahrirlash bekor qilindi.", { reply_markup: sttActionKeyboard() });
    }
});

bot.callbackQuery("stt_skip", async (ctx) => {
    await ctx.answerCallbackQuery("O'tkazildi");
    const userId = ctx.from.id;
    const stateRow = await dbService.getState(userId);

    if (!stateRow || !isValidState(stateRow.data) || !stateRow.data.fileKey) {
        await ctx.reply("❌ Faol fayl topilmadi.");
        return;
    }

    try {
        await dbService.releaseFile(userId, stateRow.data.fileKey);
        await dbService.deleteState(userId);

        await ctx.reply("⏭️ Fayl o'tkazildi. Davom etamizmi?", {
            reply_markup: new Keyboard().text("📚 Adabiy gaplar").text("⬅️ Asosiy menyu").resized()
        });
    } catch (e) {
        Logger.error('stt_skip error', e, { userId });
        await ctx.reply("❌ Xatolik yuz berdi.");
    }
});

// Keep hears handler only for transcription ⏭️ skip (Reply Keyboard)
bot.hears("⏭️ O'tkazish", async (ctx) => {
    if (!ctx.from) return;
    const userId = ctx.from.id;
    const stateRow = await dbService.getState(userId);
    if (!stateRow) return;

    // Only handle transcription state here (STT uses stt_skip callback now)
    if (stateRow.state_type === 'transcription' || stateRow.state_type === 'transcription_confirm') {
        const { fileKey } = stateRow.data;
        if (!fileKey) return;
        try {
            await dbService.releaseTranscriptionFile(userId, fileKey);
            await dbService.deleteState(userId);
            await ctx.reply("⏭️ O'tkazildi.", { reply_markup: mainMenuKeyboard });
        } catch (e) {
            await ctx.reply("❌ Xatolik yuz berdi.");
        }
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

    // Handle TRIM XORAZM input
    if (type === 'trim_xorazm') {
        const { xorazmId, audioPath, originalText } = data;
        const endSeconds = parseFloat(messageText);
        if (isNaN(endSeconds) || endSeconds <= 0) {
            await ctx.reply("❌ Noto'g'ri qiymat. Musbat soniya yuboring (masalan: <code>12</code> yoki <code>12.5</code>)", { parse_mode: "HTML" });
            return;
        }

        const audioBuffer = await s3Service.getXorazmAudioBuffer(audioPath);
        if (!audioBuffer) {
            await ctx.reply("❌ Audio fayl topilmadi.");
            await dbService.saveState(userId, 'xorazm', data);
            return;
        }

        await ctx.reply(`✂️ ${endSeconds} sekundgacha kessilmoqda...`);
        const trimmedBuffer = await trimAudio(audioBuffer, endSeconds);
        if (!trimmedBuffer) {
            await ctx.reply("❌ Kesishda xatolik yuz berdi.");
            await dbService.saveState(userId, 'xorazm', data);
            return;
        }

        // Save trimEndSeconds so xrz_accept will upload the trimmed version
        await dbService.saveState(userId, 'xorazm', { ...data, trimEndSeconds: endSeconds });

        const caption = `✂️ <b>Kessilgan audio (0 — ${endSeconds} sek)</b>\n\n🆔 <code>${xorazmId}</code>`;
        await ctx.replyWithAudio(new InputFile(trimmedBuffer, 'trimmed.wav'), {
            caption,
            parse_mode: "HTML",
            reply_markup: xorazmActionKeyboard()
        });
        return;
    }

    // Handle XORAZM EDIT text input
    if (type === 'xorazm_edit') {
        const { xorazmId, originalText, geminiText } = data;

        // Save edited text to DB and state — spread `data` to preserve trimEndSeconds and other fields
        await dbService.updateXorazmText(xorazmId, newText);
        await dbService.saveState(userId, 'xorazm', {
            ...data,
            editedText: newText
        });

        let msg = `✅ <b>Matn tahrirlandi!</b>\n\n`;
        msg += `🆔 <code>${xorazmId}</code>\n\n`;
        msg += `<b>Original:</b>\n<code>${originalText.substring(0, 200)}</code>\n\n`;
        if (geminiText) {
            msg += `<b>Gemini:</b>\n<code>${geminiText.substring(0, 200)}</code>\n\n`;
        }
        msg += `<b>Tahrirlangan:</b>\n<code>${newText.substring(0, 200)}</code>\n\n`;
        msg += `<i>Tasdiqlaysizmi?</i>`;

        await ctx.reply(msg, {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
                .text("✅ To'g'ri", "xrz_accept")
                .text("❌ Xato", "xrz_deny")
                .row()
                .text("✏️ Qayta tahrirlash", "xrz_edit")
                .text("⏭️ O'tkazish", "xrz_skip")
        });
        return;
    }

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
        const { fileKey, trimEndSeconds } = data;
        try {
            const success = await s3Service.updateJsonText(fileKey, newText);

            if (success) {
                // Preserve trimEndSeconds if it was set before editing
                await dbService.saveState(userId, 'checking', { fileKey, editedText: newText, trimEndSeconds });

                const audioBuffer = await s3Service.getFileBuffer(fileKey);
                if (!audioBuffer) {
                    await ctx.reply("Matn saqlandi, lekin audio faylni qayta yuklab bo'lmadi.");
                    return;
                }

                const caption = `🆔 <code>${fileKey.split('/').pop()?.replace('.json', '') || fileKey}</code>\n\n📝 ${newText}\n\n<i>(Tahrirlangan)</i>`;

                await ctx.replyWithAudio(new InputFile(audioBuffer), {
                    caption,
                    parse_mode: "HTML",
                    reply_markup: sttActionKeyboard()
                });
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
        try {
            await s3Service.copyTranscriptionToSorted(fileKey, tempText, Math.round(duration), gender);
            console.log('[TRANSCRIBE] Successfully copied to sorted folder');
        } catch (err) {
            console.error('[TRANSCRIBE] Error copying to sorted folder:', err);
        }

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

// --- XORAZM DIALECT CALLBACK HANDLERS ---

// Accept - copy to xorazm_saralangan/
bot.callbackQuery("xrz_accept", async (ctx) => {
    await ctx.answerCallbackQuery("Saqlanmoqda...");

    const userId = ctx.from.id;
    const stateRow = await dbService.getState(userId);

    if (!stateRow || stateRow.state_type !== 'xorazm' || !stateRow.data?.xorazmId) {
        await ctx.reply("❌ Vazifa topilmadi.");
        return;
    }

    const { xorazmId, audioPath, originalText, editedText, trimEndSeconds } = stateRow.data;
    const finalText = editedText || originalText;

    try {
        if (trimEndSeconds) {
            const audioBuffer = await s3Service.getXorazmAudioBuffer(audioPath);
            if (!audioBuffer) throw new Error("Audio topilmadi");
            const trimmedBuffer = await trimAudio(audioBuffer, trimEndSeconds);
            if (!trimmedBuffer) throw new Error("Kesish xatolik");
            await s3Service.uploadTrimmedXorazmToAccepted(xorazmId, audioPath, trimmedBuffer, finalText);
        } else {
            await s3Service.copyXorazmToAccepted(xorazmId, audioPath, finalText);
        }
        await dbService.updateXorazmFileStatus(userId, xorazmId, 'ACCEPTED', editedText);
        await dbService.deleteState(userId);

        // PAYMENT LOGIC
        await dbService.incrementBalance(userId, config.XORAZM_CHECK_PRICE);

        await ctx.reply(
            `✅ <b>Qabul qilindi!</b>\n\n` +
            `🆔 <code>${xorazmId}</code>\n` +
            `📝 <code>${finalText.substring(0, 100)}${finalText.length > 100 ? '...' : ''}</code>\n\n` +
            `💰 <b>${config.XORAZM_CHECK_PRICE} so'm qo'shildi!</b>\n\n` +
            `Davom etamizmi?`,
            {
                parse_mode: "HTML",
                reply_markup: new Keyboard()
                    .text("🌍 Xorazm viloyati")
                    .text("⬅️ Asosiy menyu")
                    .resized()
            }
        );
    } catch (e) {
        Logger.error('Error accepting xorazm file', e, { userId, xorazmId });
        await ctx.reply("❌ Xatolik yuz berdi.");
    }
});

// Deny - mark as REJECTED (NO deletion from S3)
bot.callbackQuery("xrz_deny", async (ctx) => {
    await ctx.answerCallbackQuery("Rad etildi");

    const userId = ctx.from.id;
    const stateRow = await dbService.getState(userId);

    if (!stateRow || stateRow.state_type !== 'xorazm' || !stateRow.data?.xorazmId) {
        await ctx.reply("❌ Vazifa topilmadi.");
        return;
    }

    try {
        await dbService.updateXorazmFileStatus(userId, stateRow.data.xorazmId, 'REJECTED');
        await dbService.deleteState(userId);

        await ctx.reply("❌ Rad etildi! (Original fayl o'zgartirilmadi)\n\nDavom etamizmi?", {
            reply_markup: new Keyboard()
                .text("🌍 Xorazm viloyati")
                .text("⬅️ Asosiy menyu")
                .resized()
        });
    } catch (e) {
        Logger.error('Error denying xorazm file', e, { userId });
        await ctx.reply("❌ Xatolik yuz berdi.");
    }
});

// Edit - enter text editing mode
bot.callbackQuery("xrz_edit", async (ctx) => {
    await ctx.answerCallbackQuery();

    const userId = ctx.from.id;
    const stateRow = await dbService.getState(userId);

    if (!stateRow || stateRow.state_type !== 'xorazm' || !stateRow.data?.xorazmId) {
        await ctx.reply("❌ Vazifa topilmadi.");
        return;
    }

    const { xorazmId, originalText, geminiText, editedText } = stateRow.data;
    const currentText = editedText || originalText;

    await dbService.saveState(userId, 'xorazm_edit', stateRow.data);

    let prompt = `✏️ <b>Matnni tahrirlash</b>\n\n`;
    prompt += `🆔 <code>${xorazmId}</code>\n\n`;
    prompt += `<b>📝 Asl matn (metadata):</b>\n<code>${originalText.substring(0, 300)}</code>\n\n`;
    if (geminiText) {
        prompt += `<b>🤖 Gemini transkripsiya:</b>\n<code>${geminiText.substring(0, 300)}</code>\n\n`;
    }
    prompt += `<i>Yangi matnni yozib yuboring:</i>`;

    await ctx.reply(prompt, { parse_mode: "HTML" });
});

// Skip - release and get next
bot.callbackQuery("xrz_skip", async (ctx) => {
    await ctx.answerCallbackQuery("O'tkazildi");

    const userId = ctx.from.id;
    const stateRow = await dbService.getState(userId);

    if (!stateRow || stateRow.state_type !== 'xorazm' || !stateRow.data?.xorazmId) {
        await ctx.reply("❌ Vazifa topilmadi.");
        return;
    }

    try {
        await dbService.releaseXorazmFile(userId, stateRow.data.xorazmId);
        await dbService.deleteState(userId);
        await sendNextXorazmFile(ctx);
    } catch (e) {
        Logger.error('Error skipping xorazm file', e, { userId });
        await ctx.reply("❌ Xatolik yuz berdi.");
    }
});

// --- AUDIO SLOWDOWN CALLBACKS ---

bot.callbackQuery("slow_stt", async (ctx) => {
    await ctx.answerCallbackQuery("🐢 Audio sekinlashtirilmoqda...");

    const userId = ctx.from.id;
    const stateRow = await dbService.getState(userId);

    if (!stateRow || !isValidState(stateRow.data) || !stateRow.data.fileKey) {
        await ctx.reply("❌ Faol fayl topilmadi.");
        return;
    }

    const { fileKey } = stateRow.data;

    try {
        const audioBuffer = await s3Service.getFileBuffer(fileKey);
        if (!audioBuffer) {
            await ctx.reply("❌ Audio fayl topilmadi.");
            return;
        }

        const slowedBuffer = await slowDownAudio(audioBuffer);
        if (!slowedBuffer) {
            await ctx.reply("❌ Audio sekinlashtirishda xatolik. Serverdagi ffmpeg ni tekshiring.");
            return;
        }

        await ctx.replyWithAudio(new InputFile(slowedBuffer, 'slowed.wav'), {
            caption: "🐢 <b>Sekinlashtirilgan audio (0.75x)</b>",
            parse_mode: "HTML",
            reply_markup: sttActionKeyboard()
        });
    } catch (e) {
        Logger.error('Error slowing down STT audio', e, { userId });
        await ctx.reply("❌ Xatolik yuz berdi.");
    }
});

bot.callbackQuery("slow_xorazm", async (ctx) => {
    await ctx.answerCallbackQuery("🐢 Audio sekinlashtirilmoqda...");

    const userId = ctx.from.id;
    const stateRow = await dbService.getState(userId);

    if (!stateRow || !stateRow.data?.audioPath) {
        await ctx.reply("❌ Faol fayl topilmadi.");
        return;
    }

    const { audioPath } = stateRow.data;

    try {
        const audioBuffer = await s3Service.getXorazmAudioBuffer(audioPath);
        if (!audioBuffer) {
            await ctx.reply("❌ Audio fayl topilmadi.");
            return;
        }

        const slowedBuffer = await slowDownAudio(audioBuffer);
        if (!slowedBuffer) {
            await ctx.reply("❌ Audio sekinlashtirishda xatolik. Serverdagi ffmpeg ni tekshiring.");
            return;
        }

        await ctx.replyWithAudio(new InputFile(slowedBuffer, 'slowed.wav'), {
            caption: "🐢 <b>Sekinlashtirilgan audio (0.75x)</b>",
            parse_mode: "HTML",
            reply_markup: xorazmActionKeyboard()
        });
    } catch (e) {
        Logger.error('Error slowing down Xorazm audio', e, { userId });
        await ctx.reply("❌ Xatolik yuz berdi.");
    }
});

// --- AUDIO TRIM CALLBACKS ---

bot.callbackQuery("trim_xorazm", async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from.id;
    const stateRow = await dbService.getState(userId);

    if (!stateRow || !stateRow.data?.xorazmId) {
        await ctx.reply("❌ Faol fayl topilmadi.");
        return;
    }

    await dbService.saveState(userId, 'trim_xorazm', stateRow.data);
    await ctx.reply(
        "✂️ <b>Audio kesish</b>\n\nNecha sekundgacha qoldirish kerak?\n<i>Soniyani yuboring (masalan: <code>12</code> yoki <code>12.5</code>)</i>",
        { parse_mode: "HTML" }
    );
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
            parse_mode: "HTML",
            reply_markup: sttActionKeyboard()
        });

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

        // Get STT transcription
        let geminiText: string | null = null;
        await ctx.reply("🎙 STT transkripsiya qilinmoqda... (bu biroz vaqt olishi mumkin)");
        try {
            geminiText = await s3Service.transcribeXorazmAudio(xorazmFile.audio_path);
            if (geminiText) {
                await dbService.updateXorazmGeminiText(xorazmFile.id, geminiText);
            }
        } catch (e) {
            console.warn('STT transcription failed for xorazm file:', xorazmFile.id, e);
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
            parse_mode: "HTML",
            reply_markup: xorazmActionKeyboard()
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
