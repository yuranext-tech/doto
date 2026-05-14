// ============================================================
// DOTO — API + BOT (Express.js, webhook mode)
// v1.10 — тексти оновлено, luxon, polling:false, slotDateForHour виправлено
// ============================================================

const express = require('express');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const TelegramBot = require('node-telegram-bot-api');
const { DateTime } = require('luxon');

const app = express();
app.use(express.json());

if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL не встановлений. Зупинка.');
    process.exit(1);
}
if (!process.env.TELEGRAM_TOKEN) {
    console.error('TELEGRAM_TOKEN не встановлений. Зупинка.');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const TOKEN    = process.env.TELEGRAM_TOKEN;
const APP_URL  = process.env.APP_URL  || 'https://doto-6zi6.onrender.com';
const LOCATION = process.env.LOCATION || 'парк Шевченка, фонтан';
const SLOT_HOUR = parseInt(process.env.SLOT_HOUR || '18');
const SLOT_MIN  = parseInt(process.env.SLOT_MIN  || '30');
const CITY_TZ   = process.env.CITY_TZ || 'Europe/Kyiv';

const LOCATION_CONTEXT = [
    'Сьогодні біля фонтану тихо.',
    'Після дощу там особливо дивно.',
    'Сьогодні точка під деревами.',
    'Вітер змінив напрямок. Це помітно.',
];

const bot = new TelegramBot(TOKEN, { polling: false });

async function setWebhook() {
    try {
        await bot.setWebHook(`${APP_URL}/bot${TOKEN}`);
        console.log('Webhook set OK');
    } catch (err) {
        console.error('Webhook error:', err.message);
    }
}

app.post(`/bot${TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// ============================================================
// HELPERS
// ============================================================

async function query(sql, params) {
    const client = await pool.connect();
    try {
        return await client.query(sql, params);
    } finally {
        client.release();
    }
}

function kyivNow() {
    return DateTime.now().setZone(CITY_TZ);
}

function localToday() {
    return kyivNow().toISODate();
}

function slotTimeStr() {
    return `${String(SLOT_HOUR).padStart(2,'0')}:${String(SLOT_MIN).padStart(2,'0')}`;
}

function slotDateForHour(slotH) {
    const now = kyivNow();
    const todaySlotDt = now.set({ hour: slotH, minute: SLOT_MIN, second: 0, millisecond: 0 });
    if (now < todaySlotDt) {
        return now.minus({ days: 1 }).toISODate();
    }
    return now.toISODate();
}

function getSlotTimings() {
    const now = kyivNow();
    const slotDate = slotDateForHour(SLOT_HOUR);
    const slotDt = DateTime.fromISO(slotDate, { zone: CITY_TZ })
        .set({ hour: SLOT_HOUR, minute: SLOT_MIN, second: 0 });
    const closeDt = slotDt.plus({ minutes: 20 });
    const feedDt  = closeDt.plus({ hours: 2 });
    const remDt   = slotDt.minus({ minutes: 15 });
    return { now, slotDate, slotDt, closeDt, feedDt, remDt };
}

function inWindow(now, targetDt, beforeMin, afterMin) {
    const diffMin = now.diff(targetDt, 'minutes').minutes;
    return diffMin >= -beforeMin && diffMin <= afterMin;
}

async function send(telegramId, text, opts = {}) {
    try {
        return await bot.sendMessage(telegramId, text, { parse_mode: 'Markdown', ...opts });
    } catch (e) {
        if (e.response?.statusCode === 403 || (e.message && e.message.includes('blocked'))) {
            await query(
                `UPDATE users SET blocked = TRUE WHERE telegram_id = $1`,
                [String(telegramId)]
            ).catch(() => {});
        }
        console.error(`send failed for ${telegramId}:`, e.message);
    }
}

function kbd(rows) {
    return { reply_markup: { inline_keyboard: rows } };
}

async function getUser(telegramId) {
    const r = await query(`SELECT * FROM users WHERE telegram_id = $1`, [String(telegramId)]);
    return r.rows[0] || null;
}

async function getIntent(userId, slotDate) {
    const r = await query(
        `SELECT * FROM join_intents WHERE user_id = $1 AND slot_date = $2`,
        [userId, slotDate]
    );
    return r.rows[0] || null;
}

// ============================================================
// TASKS POOL
// ============================================================

const TASKS = {
    absurd: [
        'Знайди жабку, яка дивиться як твій колишній о 3 ночі.\nСфоткай крупним планом. Надішли сюди. Без слів.',
        'Знайди дерево, яке ходить до психолога вже третій рік.\nСфоткай так, щоб було видно його проблему.',
        'Знайди лавку, яка явно переживає розставання.\nСфоткай. Без підпису.',
    ],
    ambient: [
        'Знайди місце, де хочеться говорити шепотом.\nПостій там 30 секунд.\nНадішли один емодзі, який описує повітря.',
        'Знайди щось, що виглядає так, ніби воно чекає вже дуже давно.\nСфоткай. Надішли. Без слів.',
        'Знайди місце в парку, де тихіше ніж скрізь.\nПостій хвилину. Надішли фото того, що побачив.',
    ],
    coordination: [
        'Знайди тінь, яка схожа на тварину. Не кажи вголос, яку.\nСфоткай.\nЯкщо ви обидва вгадали одне й те саме — отримуєте несправжнє очко.',
        'Знайдіть разом щось, що явно не на своєму місці.\nОбидва фоткаєте. Надсилаєте сюди.',
    ],
    city_attention: [
        'Сьогодні точка тиха.\n\nЗнайди жабку, яка не хоче, щоб її знайшли.\nСфоткай так, ніби ти її спалив.\nНадішли. Вона йде в архів.',
        'Сьогодні точка тиха.\n\nЗнайди місце, де місто звучить так, ніби про тебе забуло.\nПостій там 20 секунд.\nСфоткай щось, повз що всі проходять.',
    ],
};

function pickTask(visitCount, hasPartner) {
    if (!hasPartner) {
        const p = TASKS.city_attention;
        return { type: 'city_attention', text: p[Math.floor(Math.random() * p.length)] };
    }
    if (visitCount <= 1) {
        const p = TASKS.absurd;
        return { type: 'absurd', text: p[Math.floor(Math.random() * p.length)] };
    }
    if (visitCount <= 4) {
        const p = TASKS.ambient;
        return { type: 'ambient', text: p[Math.floor(Math.random() * p.length)] };
    }
    const p = Math.random() < 0.5 ? TASKS.coordination : TASKS.ambient;
    return { type: visitCount >= 5 ? 'coordination' : 'ambient', text: p[Math.floor(Math.random() * p.length)] };
}

// ============================================================
// ARCHIVE HELPERS
// ============================================================

async function getArchiveSummary() {
    const together = await query(
        `SELECT caption FROM archive WHERE mode = 'together' ORDER BY created_at DESC LIMIT 4`
    );
    const solo = await query(
        `SELECT caption FROM archive WHERE mode = 'solo' ORDER BY created_at DESC LIMIT 3`
    );
    const counts = await query(`SELECT mode, COUNT(*) as c FROM archive GROUP BY mode`);
    const countMap = {};
    counts.rows.forEach(r => { countMap[r.mode] = parseInt(r.c); });
    return { together: together.rows, solo: solo.rows, counts: countMap };
}

async function addToArchive({ slotDate, mode, caption, fileId, taskType, userId, intentId }) {
    await query(
        `INSERT INTO archive (id, slot_date, mode, caption, file_id, task_type, user_id, join_intent_id, photo_sent_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [uuidv4(), slotDate, mode, caption, fileId || null, taskType || null, userId || null, intentId || null]
    );
}

// ============================================================
// BOT — /start
// ============================================================

bot.onText(/\/start/, async (msg) => {
    const chatId     = msg.chat.id;
    const telegramId = String(msg.from.id);
    const username   = msg.from.username || msg.from.first_name || '';
    const locCtx     = LOCATION_CONTEXT[Math.floor(Math.random() * LOCATION_CONTEXT.length)];

    await query(
        `INSERT INTO users (id, telegram_id, username)
         VALUES ($1, $2, $3)
         ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username, blocked = FALSE`,
        [uuidv4(), telegramId, username]
    );

    await send(chatId,
        `Doto — привід ненадовго вийти в місто.\n\n` +
        `15–20 хвилин. Можна мовчати.\n\n` +
        `Ось як це виглядає:\n` +
        `🐸 «Знайди жабку, яка дивиться як твій колишній о 3 ночі»\n` +
        `🌳 «Знайди дерево, яке ходить до психолога»\n\n` +
        `Приходиш.\n` +
        `Отримуєш дивне маленьке завдання.\n` +
        `Робиш його.\n` +
        `Поруч може бути хтось. А може — ні.\n\n` +
        `Найближча точка: сьогодні ${slotTimeStr()}, ${LOCATION}.\n\n` +
        `${locCtx}`,
        kbd([[
            { text: '🌿 Хочу зайти',  callback_data: 'join' },
            { text: '📷 Сліди точки', callback_data: 'archive' },
        ]])
    );
});

// ============================================================
// BOT — /helper
// ============================================================

bot.onText(/\/helper/, async (msg) => {
    await query(`UPDATE users SET is_helper = TRUE WHERE telegram_id = $1`, [String(msg.from.id)]);
    await send(msg.chat.id, `✦ Тебе додано як помічника точки. Дякуємо.`);
});

// ============================================================
// BOT — callback_query
// ============================================================

bot.on('callback_query', async (q) => {
    const chatId     = q.message.chat.id;
    const telegramId = String(q.from.id);
    const data       = q.data;
    await bot.answerCallbackQuery(q.id);

    const slotDate = slotDateForHour(SLOT_HOUR);

    if (data === 'join') {
        const user = await getUser(telegramId);
        if (!user) return;
        await query(
            `INSERT INTO join_intents (id, user_id, slot_date)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, slot_date) DO NOTHING`,
            [uuidv4(), user.id, localToday()]
        );
        await send(chatId,
            `Готово.\n\n` +
            `Нагадаємо за 15 хвилин до точки.\n\n` +
            `Якщо передумаєш — просто не приходь. Без штрафів.\n\n` +
            `Нічого не треба брати. Тільки телефон.\n` +
            `І трохи настрою дивитися на світ дивно.\n\n` +
            `До ${slotTimeStr()} ✦`
        );
        return;
    }

    if (data === 'archive') {
        const { together, solo, counts } = await getArchiveSummary();
        let text = `*Сліди точки*\n\n`;
        if ((counts.together || 0) > 0) {
            text += `*Разом* — ${counts.together} фото:\n`;
            together.forEach(a => { text += `📷 ${a.caption || '…'}\n`; });
        } else {
            text += `*Разом* — поки тихо\n`;
        }
        text += `\n`;
        if ((counts.solo || 0) > 0) {
            text += `*Сам* — ${counts.solo} фото:\n`;
            solo.forEach(a => { text += `🌿 ${a.caption || '…'}\n`; });
        } else {
            text += `*Сам* — поки тихо\n`;
        }
        text += `\nНаступна точка: сьогодні ${slotTimeStr()}`;
        await send(chatId, text, kbd([[
            { text: '🔔 Нагадати мені', callback_data: 'notify_me' },
            { text: '🌿 Хочу зайти',   callback_data: 'join'      },
        ]]));
        return;
    }

    if (data === 'notify_me') {
        const user = await getUser(telegramId);
        if (user) await query(`UPDATE users SET notify_next = TRUE WHERE id = $1`, [user.id]);
        await send(chatId, `Нагадаємо коли точка відкриється. ✦`);
        return;
    }

    if (data.startsWith('mood_')) {
        const mood = parseInt(data.split('_')[1]);
        const user = await getUser(telegramId);
        if (user) {
            await query(
                `UPDATE join_intents SET feedback_mood = $1 WHERE user_id = $2 AND slot_date = $3`,
                [mood, user.id, slotDate]
            );
        }
        await send(chatId, `Хочеш ще раз?`, kbd([[
            { text: 'Так', callback_data: 'return_yes' },
            { text: 'Ні',  callback_data: 'return_no'  },
        ]]));
        return;
    }

    if (data === 'return_yes' || data === 'return_no') {
        const wantsReturn = data === 'return_yes';
        const user = await getUser(telegramId);
        if (user) {
            await query(
                `UPDATE join_intents SET feedback_return = $1 WHERE user_id = $2 AND slot_date = $3`,
                [wantsReturn, user.id, slotDate]
            );
        }
        await send(chatId, `Розказав комусь про те, що було?`, kbd([[
            { text: 'Так', callback_data: 'shared_yes' },
            { text: 'Ні',  callback_data: 'shared_no'  },
        ]]));
        return;
    }

    if (data === 'shared_yes' || data === 'shared_no') {
        const shared = data === 'shared_yes';
        const user = await getUser(telegramId);
        let wantsReturn = false;
        let mode = 'solo';

        if (user) {
            await query(
                `UPDATE join_intents SET feedback_shared = $1 WHERE user_id = $2 AND slot_date = $3`,
                [shared, user.id, slotDate]
            );
            const intent = await getIntent(user.id, slotDate);
            if (intent) {
                wantsReturn = intent.feedback_return;
                mode = intent.meeting_mode || 'solo';
            }
        }

        if (wantsReturn || shared) {
            const cardText = mode === 'solo'
                ? `Твоє фото в архіві сам точки.\n\nТи — частина дивної маленької історії.\nТа, яку побачив ти.`
                : `Твоє фото в архіві точки.\n\nТи — частина дивної маленької історії.`;
            await send(chatId, cardText);
        }

        if (wantsReturn) {
            await send(chatId,
                `Наступна точка: завтра ${slotTimeStr()}.`,
                kbd([[{ text: '🔔 Нагадати', callback_data: 'notify_me' }]])
            );
        } else {
            await send(chatId, `Добре. Підберемо нову точку, коли будеш готовий.`);
        }
        return;
    }

    if (data === 'partner_together' || data === 'partner_new') {
        const user = await getUser(telegramId);
        if (user) await query(`UPDATE users SET notify_next = TRUE WHERE id = $1`, [user.id]);
        await send(chatId, data === 'partner_together'
            ? `Добре. Наступна точка — разом. Нагадаємо.`
            : `Підберемо нового партнера. Нагадаємо.`
        );
        return;
    }
});

// ============================================================
// BOT — фото → архів (перше фото на сесію)
// ============================================================

bot.on('photo', async (msg) => {
    const telegramId = String(msg.from.id);
    const slotDate   = slotDateForHour(SLOT_HOUR);
    const user = await getUser(telegramId);
    if (!user) return;

    const intent = await getIntent(user.id, slotDate);
    if (!intent) return;
    if (intent.photo_received) return;

    const photo = msg.photo[msg.photo.length - 1];

    await addToArchive({
        slotDate,
        mode:     intent.meeting_mode || 'solo',
        caption:  msg.caption || null,
        fileId:   photo.file_id,
        taskType: intent.task_type || null,
        userId:   user.id,
        intentId: intent.id,
    });

    await query(
        `UPDATE join_intents SET photo_received = TRUE, photo_sent_at = NOW()
         WHERE user_id = $1 AND slot_date = $2`,
        [user.id, slotDate]
    );

    await send(msg.chat.id, `📷 Фото отримано. Йде в архів.`);
});

// ============================================================
// BOT — /status
// ============================================================

bot.onText(/\/status/, async (msg) => {
    const slotDate = localToday();
    const intents  = await query(`SELECT COUNT(*) FROM join_intents WHERE slot_date = $1`, [slotDate]);
    const { counts } = await getArchiveSummary();
    await send(msg.chat.id,
        `*Статус точки ${slotDate}*\n\n` +
        `Записалось: ${intents.rows[0].count}\n` +
        `Архів разом: ${counts.together || 0} фото\n` +
        `Архів сам: ${counts.solo || 0} фото\n` +
        `Точка: ${slotTimeStr()}, ${LOCATION}`
    );
});

bot.onText(/\/archive/, async (msg) => {
    bot.emit('callback_query', {
        id: 'cmd', message: { chat: msg.chat }, from: msg.from, data: 'archive'
    });
});

// ============================================================
// WORKER TICK
// POST /worker/tick   header: x-worker-secret
// ============================================================

app.post('/worker/tick', async (req, res) => {
    if (req.headers['x-worker-secret'] !== process.env.WORKER_SECRET) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    const { now, slotDate, remDt, slotDt, closeDt, feedDt } = getSlotTimings();

    // ── НАГАДУВАННЯ: за 15 хв (вікно ±2 хв) ──
    if (inWindow(now, remDt, 2, 2)) {
        const intents = await query(
            `SELECT ji.user_id, u.telegram_id FROM join_intents ji
             JOIN users u ON u.id = ji.user_id
             WHERE ji.slot_date = $1
               AND ji.task_sent = FALSE
               AND (ji.reminder_sent = FALSE OR ji.reminder_sent IS NULL)
               AND (u.blocked = FALSE OR u.blocked IS NULL)`,
            [slotDate]
        );
        for (const i of intents.rows) {
            await send(i.telegram_id,
                `⏰ Ще 15 хвилин.\n\n${LOCATION}.\n\nНе поспішай.`
            );
            await query(
                `UPDATE join_intents SET reminder_sent = TRUE WHERE user_id = $1 AND slot_date = $2`,
                [i.user_id, slotDate]
            );
        }
    }

    // ── МАТЧИНГ + ЗАВДАННЯ: вікно [0, +5 хв] від слоту ──
    if (inWindow(now, slotDt, 0, 5)) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const intentsRes = await client.query(
                `SELECT ji.id, ji.user_id, u.telegram_id, u.meetings_completed, u.is_helper
                 FROM join_intents ji
                 JOIN users u ON u.id = ji.user_id
                 WHERE ji.slot_date = $1
                   AND ji.task_sent = FALSE
                   AND (u.blocked = FALSE OR u.blocked IS NULL)
                 ORDER BY u.is_helper ASC, ji.created_at ASC
                 FOR UPDATE OF ji SKIP LOCKED`,
                [slotDate]
            );

            const users = intentsRes.rows;
            const pairs = [];
            const solos = [];
            for (let i = 0; i + 1 < users.length; i += 2) pairs.push([users[i], users[i + 1]]);
            if (users.length % 2 !== 0) solos.push(users[users.length - 1]);

            for (const [a, b] of pairs) {
                const task = pickTask(Math.min(a.meetings_completed, b.meetings_completed) + 1, true);
                a._task = task; b._task = task;
                await client.query(
                    `UPDATE join_intents SET task_sent=TRUE, task_type=$1, meeting_mode='together', partner_id=$2
                     WHERE user_id=$3 AND slot_date=$4`,
                    [task.type, b.user_id, a.user_id, slotDate]
                );
                await client.query(
                    `UPDATE join_intents SET task_sent=TRUE, task_type=$1, meeting_mode='together', partner_id=$2
                     WHERE user_id=$3 AND slot_date=$4`,
                    [task.type, a.user_id, b.user_id, slotDate]
                );
                await client.query(
                    `UPDATE users SET meetings_completed = meetings_completed + 1 WHERE id IN ($1, $2)`,
                    [a.user_id, b.user_id]
                );
            }
            for (const u of solos) {
                const task = pickTask(u.meetings_completed + 1, false);
                u._task = task;
                await client.query(
                    `UPDATE join_intents SET task_sent=TRUE, task_type=$1, meeting_mode='solo'
                     WHERE user_id=$2 AND slot_date=$3`,
                    [task.type, u.user_id, slotDate]
                );
                await client.query(
                    `UPDATE users SET meetings_completed = meetings_completed + 1 WHERE id=$1`,
                    [u.user_id]
                );
            }
            await client.query('COMMIT');

            for (const [a, b] of pairs) {
                await send(a.telegram_id, `Точка відкрита.\n\n${a._task.text}\n\nМожна мовчати.`);
                await send(b.telegram_id, `Точка відкрита.\n\n${b._task.text}\n\nМожна мовчати.`);
            }
            for (const u of solos) {
                await send(u.telegram_id, `Точка відкрита.\n\n${u._task.text}\n\nНе треба швидко.`);
            }
        } catch (e) {
            await client.query('ROLLBACK');
            console.error('Matching error:', e.message);
        } finally {
            client.release();
        }

        const notifyUsers = await query(
            `SELECT telegram_id FROM users WHERE notify_next=TRUE AND (blocked=FALSE OR blocked IS NULL)`
        );
        const slotIds = await query(
            `SELECT u.telegram_id FROM join_intents ji JOIN users u ON u.id=ji.user_id WHERE ji.slot_date=$1`,
            [slotDate]
        );
        const sentIds = new Set(slotIds.rows.map(i => i.telegram_id));
        for (const u of notifyUsers.rows) {
            if (!sentIds.has(u.telegram_id)) {
                await send(u.telegram_id,
                    `🌿 Точка зараз відкрита!\n\n${slotTimeStr()}, ${LOCATION}.`,
                    kbd([[{ text: '🌿 Хочу зайти', callback_data: 'join' }]])
                );
                await query(`UPDATE users SET notify_next=FALSE WHERE telegram_id=$1`, [u.telegram_id]);
            }
        }
    }

    // ── ЗАКРИТТЯ: вікно [0, +3 хв] від closeDt ──
    if (inWindow(now, closeDt, 0, 3)) {
        const intents = await query(
            `SELECT ji.user_id, ji.meeting_mode, u.telegram_id FROM join_intents ji
             JOIN users u ON u.id=ji.user_id
             WHERE ji.slot_date=$1 AND ji.task_sent=TRUE AND ji.closed=FALSE
               AND (u.blocked=FALSE OR u.blocked IS NULL)`,
            [slotDate]
        );
        for (const i of intents.rows) {
            const isSolo = i.meeting_mode === 'solo';
            let text = `Точка закривається.\n\nМожна піти. Можна сидіти ще.\n\nНемає правила.`;
            if (isSolo) text += `\n\nТвоє фото в архіві сам.\nНаступна людина побачить його перед тим, як зайти.`;
            text += `\n\nЧерез 2 години надішлемо 3 коротких питання.`;
            await send(i.telegram_id, text);
            await query(
                `UPDATE join_intents SET closed=TRUE WHERE user_id=$1 AND slot_date=$2`,
                [i.user_id, slotDate]
            );
        }
    }

    // ── ФІДБЕК: вікно [0, +3 хв] від feedDt ──
    if (inWindow(now, feedDt, 0, 3)) {
        const intents = await query(
            `SELECT ji.user_id, u.telegram_id FROM join_intents ji
             JOIN users u ON u.id=ji.user_id
             WHERE ji.slot_date=$1 AND ji.closed=TRUE AND ji.feedback_sent=FALSE
               AND (u.blocked=FALSE OR u.blocked IS NULL)`,
            [slotDate]
        );
        for (const i of intents.rows) {
            await send(i.telegram_id, `Пройшло вже дві години.\n\nЯк ти себе почуваєш?`, kbd([[
                { text: '1', callback_data: 'mood_1' },
                { text: '2', callback_data: 'mood_2' },
                { text: '3', callback_data: 'mood_3' },
                { text: '4', callback_data: 'mood_4' },
                { text: '5', callback_data: 'mood_5' },
            ]]));
            await query(
                `UPDATE join_intents SET feedback_sent=TRUE WHERE user_id=$1 AND slot_date=$2`,
                [i.user_id, slotDate]
            );
        }

        const pairsToNotify = await query(
            `SELECT ji1.user_id as uid1, u1.telegram_id as tg1,
                    ji2.user_id as uid2, u2.telegram_id as tg2
             FROM join_intents ji1
             JOIN join_intents ji2 ON ji2.user_id=ji1.partner_id AND ji2.slot_date=ji1.slot_date
             JOIN users u1 ON u1.id=ji1.user_id
             JOIN users u2 ON u2.id=ji2.user_id
             WHERE ji1.slot_date=$1
               AND ji1.meeting_mode='together'
               AND ji1.partner_id IS NOT NULL
               AND (ji1.feedback_return=TRUE OR ji2.feedback_return=TRUE)
               AND ji1.partner_notified=FALSE
               AND (u1.blocked=FALSE OR u1.blocked IS NULL)`,
            [slotDate]
        );
        for (const pair of pairsToNotify.rows) {
            const msg =
                `Хтось із вас хоче ще.\n\n` +
                `Якщо обидва натиснете "Разом" — наступна точка разом.\n` +
                `Якщо ні — підберемо нових партнерів. Без пояснень.`;
            const pKbd = kbd([[
                { text: 'Разом', callback_data: 'partner_together' },
                { text: 'Новий', callback_data: 'partner_new' },
            ]]);
            await send(pair.tg1, msg, pKbd);
            await send(pair.tg2, msg, pKbd);
            await query(
                `UPDATE join_intents SET partner_notified=TRUE WHERE user_id IN ($1,$2) AND slot_date=$3`,
                [pair.uid1, pair.uid2, slotDate]
            );
        }
    }

    res.json({ ok: true, ts: now.toISO() });
});

// ============================================================
// HEALTH
// ============================================================

app.get('/health', (req, res) => res.json({ ok: true, version: '1.10' }));

// ============================================================
// START
// ============================================================

const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
    console.log(`Doto API v1.10 running on port ${PORT}`);
    await setWebhook();
});
