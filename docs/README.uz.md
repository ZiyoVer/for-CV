# STT Check Bot

Ovozli xabarlarni (STT) tekshirish va saralash uchun Telegram Bot.

## Imkoniyatlar
- **S3 Integration**: Fayllarni Wasabi S3 (`stt/` papkasi) dan oladi va `saralangan/` ga nusxalaydi.
- **PostgreSQL**: Statistika va foydalanuvchilar ma'lumotlarini saqlash uchun.
- **Security**: Faqat ruxsat etilgan ID'lar botdan foydalana oladi.
- **Admin Panel**: Foydalanuvchi qo'shish va umumiy statistikani grafik ko'rinishida ko'rish.

## O'rnatish

1. Repozitoriyani klon qiling.
2. `npm install`
3. `.env` faylini yarating:
```env
TELEGRAM_BOT_TOKEN=your_token
WASABI_ACCESS_KEY=...
WASABI_SECRET_KEY=...
WASABI_BUCKET=...
ADMIN_IDS=id1,id2
DATABASE_URL=postgres://...
```
4. `npm run build`
5. `npm start`

## Buyruqlar
- `/start` - Botni boshlash
- `/admin` - Admin paneli (Faqat adminlar uchun)
- `/add_user ID ISM` - Yangi annotator qo'shish
