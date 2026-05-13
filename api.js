// ============================================================
// DOTO — API + BOT (Express.js, webhook mode)
// v1.4 — флоу без анкет. Архів разом / сам. Solo-режим.
// ============================================================

const express = require('express');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres.kcdedrgylmxczjijoncx:DotoData2069@aws-1-eu-central-2.pooler.supabase.com:5432/postgres',
    ssl: { rejectUnauthorized: false }
});

const TOKEN = process.env.TELEGRAM_TOKEN;
const APP_URL = process.env.APP_URL || 'https://doto-6zi6.onrender.com';
const LOCATION = process.env.LOCATION || 'парк Шевченка, фонтан';
const SLOT_HOUR = parseInt(process.env.SLOT_HOUR || '18');
const SLOT_MIN = parseInt(process.env.SLOT_MIN || '30');

const bot = new TelegramBot(TOKEN, { webHook: false });

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

function slotTimeStr() {
    return `${String(SLOT_HOUR).padStart(2,'0')}:${String(SLOT_MIN).padStart(2,'0')}`;
}

function send(chatId, text, opts = {}) {
    return bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...opts });
}

function kbd(rows) {
    return { reply_markup: { inline_keyboard: rows } };
}

async function logEvent(client, { userId, meetingId, eventType, metadata = {} }) {
    await client.query(
        `INSERT INTO events (id, user_id, meeting_id, event_type, metadata) VALUES ($1, $2, $3, $4, $5)`,
        [uuidv4(), userId, meetingId, eventType, JSON.stringify(metadata)]
    );
}

async function changeDp(client, userId, amount, reason) {
    await client.query(`UPDATE users SET dp = dp + $1 WHERE id = $2`, [amount, userId]);
    await client.query(`INSERT INTO dp_log (id, user_id, change, reason) VALUES ($1, $2, $3, $4)`, [uuidv4(), userId, amount, reason]);
}

async function getUser(telegramId) {
    const r = await query(`SELECT * FROM users WHERE telegram_id = $1`, [String(telegramId)]);
    return r.rows[0] || null;
}

async function getTodaySession(userId) {
    const today = new Date().toISOString().split('T')[0];
    const r = await query(
        `SELECT * FROM meeting_participants mp
         JOIN meetings m ON m.id = mp.meeting_id
         WHERE mp.user_id = $1 AND DATE(m.scheduled_at) = $2
         LIMIT 1`,
        [userId, today]
    );
    return r.rows[0] || null;
}

// ============================================================
// TASKS POOL
// ============================================================

const TASKS = {
    A: [
        'Знайди жабку, яка дивиться як твій колишній о 3 ночі.\nСфоткай крупним планом. Надішли сюди. Без слів.',
        'Знайди дерево, яке ходить до психолога вже третій рік.\nСфоткай так, щоб було видно його проблему.',
        'Знайди лавку, яка явно переживає розставання.\nСфоткай. Без підпису.',
    ],
    B: [
        'Знайди місце, де хочеться говорити шепотом.\nПостій там 30 секунд.\nНадішли один емодзі, який описує повітря.',
        'Знайди щось, що виглядає так, ніби воно чекає вже дуже давно.\nСфоткай. Надішли. Без слів.',
        'Знайди місце в парку, де тихіше ніж скрізь.\nПостій хвилину. Надішли фото того, що побачив.',
    ],
    C: [
        'Знайди тінь, яка схожа на тварину. Не кажи вголос, яку.\nСфоткай.\nЯкщо ви обидва вгадали одне й те саме — отримуєте несправжнє очко.',
        'Знайдіть разом щось, що явно не на своєму місці.\nОбидва фоткаєте. Надсилаєте сюди.',
    ],
    SOLO: [
        'Сьогодні точка тиха.\n\nЗнайди жабку, яка не хоче, щоб її знайшли.\nСфоткай так, ніби ти її спалив.\nНадішли. Вона йде в архів.',
        'Сьогодні точка тиха.\n\nЗнайди місце, де місто звучить так, ніби про тебе забуло.\nПостій там 20 секунд.\nСфоткай щось, повз що всі проходять.',
    ],
};

function pickTask(visitCount, hasParter) {
    if (!hasParter) return { type: 'SOLO', text: TASKS.SOLO[Math.floor(Math.random() * TASKS.SOLO.length)] };
    if (visitCount <= 1) return { type: 'A', text: TASKS.A[Math.floor(Math.random() * TASKS.A.length)] };
    if (visitCount <= 4) return { type: 'B', text: TASKS.B[Math.floor(Math.random() * TASKS.B.length)] };
    const pool = Math.random() < 0.5 ? TASKS.C : TASKS.B;
    return { type: visitCount >= 5 ? 'C' : 'B', text: pool[Math.floor(Math.random() * pool.length)] };
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
    const counts = await query(
        `SELECT mode, COUNT(*) as c FROM archive GROUP BY mode`
    );
    const countMap = {};
    counts.rows.forEach(r => { countMap[r.mode] = parseInt(r.c); });

    return { together: together.rows, solo: solo.rows, counts: countMap };
}

async function addToArchive(mode, caption, fileId) {
    await query(
        `INSERT INTO archive (id, slot_date, mode, caption, file_id) VALUES ($1, $2, $3, $4, $5)`,
        [uuidv4(), new Date().toISOString().split('T')[0], mode, caption, fileId || null]
    );
}

// ============================================================
// BOT — /start
// ============================================================

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = String(msg.from.id);
    const username = msg.from.username || msg.from.first_name || '';

    // Upsert user без анкет
    await query(
        `INSERT INTO users (id, telegram_id, username)
         VALUES ($1, $2, $3)
         ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username`,
        [uuidv4(), telegramId, username]
    );

    await send(chatId,
        `Doto — привід ненадовго вийти в місто.\n\n` +
        `15–20 хвилин. Можна мовчати.\n\n` +
        `Ось як це виглядає:\n` +
        `🐸 «Знайди жабку, яка дивиться як твій колишній о 3 ночі»\n` +
        `🌳 «Знайди дерево, яке ходить до психолога»\n\n` +
        `Приходиш — отримуєш завдання — робиш.\n` +
        `Поруч може бути хтось. А може — ні.\n\n` +
        `Найближча точка: сьогодні ${slotTimeStr()}, ${LOCATION}.`,
        kbd([[
            { text: '🌿 Хочу зайти', callback_data: 'join' },
            { text: '📷 Архів точки', callback_data: 'archive' },
        ]])
    );
});

// ============================================================
// BOT — callback_query
// ============================================================

bot.on('callback_query', async (q) => {
    const chatId = q.message.chat.id;
    const telegramId = String(q.from.id);
    const data = q.data;
    await bot.answerCallbackQuery(q.id);

    // ── JOIN ──
    if (data === 'join') {
        await send(chatId,
            `Готово.\n\n` +
            `Нагадаємо за 15 хвилин до точки.\n\n` +
            `Якщо передумаєш — просто не приходь. Без штрафів.\n\n` +
            `Нічого не треба брати. Тільки телефон.\n` +
            `І трохи настрою дивитися на світ дивно.`,
            kbd([[{ text: 'Ок', callback_data: 'ok_joined' }]])
        );

        // Записуємо намір (meeting буде знайдено воркером при матчингу)
        const user = await getUser(telegramId);
        if (user) {
            await query(
                `INSERT INTO join_intents (id, user_id, slot_date, created_at)
                 VALUES ($1, $2, $3, NOW())
                 ON CONFLICT (user_id, slot_date) DO NOTHING`,
                [uuidv4(), user.id, new Date().toISOString().split('T')[0]]
            );
        }
        return;
    }

    if (data === 'ok_joined') {
        await send(chatId, `До ${slotTimeStr()} ✦`);
        return;
    }

    // ── ARCHIVE ──
    if (data === 'archive') {
        const { together, solo, counts } = await getArchiveSummary();

        let text = `*Архів точки*\n\n`;

        if ((counts.together || 0) > 0) {
            text += `*Архів разом* — ${counts.together} фото:\n`;
            together.forEach(a => { text += `📷 ${a.caption || '…'}\n`; });
        } else {
            text += `*Архів разом* — поки порожній\n`;
        }

        text += `\n`;

        if ((counts.solo || 0) > 0) {
            text += `*Архів сам* — ${counts.solo} фото:\n`;
            solo.forEach(a => { text += `🌿 ${a.caption || '…'}\n`; });
        } else {
            text += `*Архів сам* — поки порожній\n`;
        }

        text += `\nНаступна точка: сьогодні ${slotTimeStr()}`;

        await send(chatId, text, kbd([[
            { text: '🔔 Нагадати мені', callback_data: 'notify_me' },
            { text: '🌿 Хочу зайти', callback_data: 'join' },
        ]]));
        return;
    }

    // ── NOTIFY ME ──
    if (data === 'notify_me') {
        const user = await getUser(telegramId);
        if (user) {
            await query(`UPDATE users SET notify_next = TRUE WHERE id = $1`, [user.id]);
        }
        await send(chatId, `Нагадаємо коли точка відкриється. ✦`);
        return;
    }

    // ── FEEDBACK: MOOD ──
    if (data.startsWith('mood_')) {
        const mood = parseInt(data.split('_')[1]);
        const user = await getUser(telegramId);
        const today = new Date().toISOString().split('T')[0];
        if (user) {
            await query(
                `UPDATE meeting_participants SET feedback_mood = $1
                 WHERE user_id = $2 AND meeting_id IN (
                   SELECT id FROM meetings WHERE DATE(scheduled_at) = $3
                 )`,
                [mood, user.id, today]
            );
        }
        await send(chatId,
            `Хочеш ще раз?`,
            kbd([[
                { text: 'Так', callback_data: 'return_yes' },
                { text: 'Ні', callback_data: 'return_no' },
            ]])
        );
        return;
    }

    // ── FEEDBACK: RETURN ──
    if (data === 'return_yes' || data === 'return_no') {
        const wantsReturn = data === 'return_yes';
        const user = await getUser(telegramId);
        const today = new Date().toISOString().split('T')[0];
        if (user) {
            await query(
                `UPDATE meeting_participants SET feedback_return = $1
                 WHERE user_id = $2 AND meeting_id IN (
                   SELECT id FROM meetings WHERE DATE(scheduled_at) = $3
                 )`,
                [wantsReturn, user.id, today]
            );
        }
        await send(chatId,
            `Розказав комусь про те, що було?`,
            kbd([[
                { text: 'Так', callback_data: 'shared_yes' },
                { text: 'Ні', callback_data: 'shared_no' },
            ]])
        );
        return;
    }

    // ── FEEDBACK: SHARED ──
    if (data === 'shared_yes' || data === 'shared_no') {
        const shared = data === 'shared_yes';
        const user = await getUser(telegramId);
        const today = new Date().toISOString().split('T')[0];

        let wantsReturn = false;
        let mode = 'solo';

        if (user) {
            await query(
                `UPDATE meeting_participants SET feedback_shared = $1
                 WHERE user_id = $2 AND meeting_id IN (
                   SELECT id FROM meetings WHERE DATE(scheduled_at) = $3
                 )`,
                [shared, user.id, today]
            );

            const sess = await query(
                `SELECT mp.feedback_return, mp.meeting_mode
                 FROM meeting_participants mp
                 JOIN meetings m ON m.id = mp.meeting_id
                 WHERE mp.user_id = $1 AND DATE(m.scheduled_at) = $2
                 LIMIT 1`,
                [user.id, today]
            );
            if (sess.rows.length) {
                wantsReturn = sess.rows[0].feedback_return;
                mode = sess.rows[0].meeting_mode || 'solo';
            }
        }

        // Архівна картка — тільки якщо хоче повернутись АБО розказав
        if (wantsReturn || shared) {
            if (mode === 'solo') {
                await send(chatId,
                    `Твоє фото в архіві сам точки.\n\n` +
                    `Ти — частина дивної маленької історії.\n` +
                    `Та, яку побачив ти.`
                );
            } else {
                await send(chatId,
                    `Твоє фото в архіві точки.\n\n` +
                    `Ти — частина дивної маленької історії.`
                );
            }
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

    // ── PARTNER CHOICE ──
    if (data === 'partner_together') {
        const user = await getUser(telegramId);
        if (user) await query(`UPDATE users SET notify_next = TRUE WHERE id = $1`, [user.id]);
        await send(chatId, `Добре. Наступна точка — разом. Нагадаємо.`);
        return;
    }

    if (data === 'partner_new') {
        const user = await getUser(telegramId);
        if (user) await query(`UPDATE users SET notify_next = TRUE WHERE id = $1`, [user.id]);
        await send(chatId, `Підберемо нового партнера. Нагадаємо.`);
        return;
    }
});

// ============================================================
// BOT — фото від користувача → архів
// ============================================================

bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = String(msg.from.id);
    const today = new Date().toISOString().split('T')[0];

    const user = await getUser(telegramId);
    if (!user) return;

    const sess = await query(
        `SELECT mp.meeting_mode FROM meeting_participants mp
         JOIN meetings m ON m.id = mp.meeting_id
         WHERE mp.user_id = $1 AND DATE(m.scheduled_at) = $2
         LIMIT 1`,
        [user.id, today]
    );

    const mode = sess.rows[0]?.meeting_mode || 'solo';
    const photo = msg.photo[msg.photo.length - 1];
    const caption = msg.caption || null;

    await addToArchive(mode, caption, photo.file_id);
    await query(
        `UPDATE meeting_participants SET photo_received = TRUE
         WHERE user_id = $1 AND meeting_id IN (
           SELECT id FROM meetings WHERE DATE(scheduled_at) = $2
         )`,
        [user.id, today]
    );

    await send(chatId, `📷 Фото отримано. Йде в архів.`);
});

// ============================================================
// BOT — /status (адмін)
// ============================================================

bot.onText(/\/status/, async (msg) => {
    const today = new Date().toISOString().split('T')[0];
    const intents = await query(
        `SELECT COUNT(*) FROM join_intents WHERE slot_date = $1`, [today]
    );
    const { counts } = await getArchiveSummary();

    await send(msg.chat.id,
        `*Статус точки ${today}*\n\n` +
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
// API ENDPOINTS (залишаємо для сумісності)
// ============================================================

app.get('/feed', async (req, res) => {
    try {
        const feed = await query(
            `SELECT m.*, t.title, t.description,
             (SELECT COUNT(*) FROM meeting_participants mp WHERE mp.meeting_id = m.id) as participant_count
             FROM meetings m JOIN tasks t ON t.id = m.task_id
             WHERE m.status IN ('open','partial') AND m.scheduled_at > NOW()
             LIMIT 5`
        );
        res.json({ meetings: feed.rows });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/users', async (req, res) => {
    const { telegramId, username } = req.body;
    try {
        const result = await query(
            `INSERT INTO users (id, telegram_id, username)
             VALUES ($1, $2, $3)
             ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username
             RETURNING *`,
            [uuidv4(), String(telegramId), username]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/users', async (req, res) => {
    try {
        const { telegramId } = req.query;
        const result = await query(`SELECT * FROM users WHERE telegram_id = $1`, [String(telegramId)]);
        if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/feedback', async (req, res) => {
    const { userId, meetingId, experience, comfort, reason } = req.body;
    try {
        await query(
            `UPDATE feedback SET experience=$1, comfort=$2, reason=$3, answered_at=NOW()
             WHERE user_id=$4 AND meeting_id=$5`,
            [experience, comfort, reason || null, userId, meetingId]
        );
        if (comfort === 'no' && reason) {
            await query(
                `INSERT INTO reports (id, reporter_id, meeting_id, reason) VALUES ($1, $2, $3, $4)`,
                [uuidv4(), userId, meetingId, reason]
            );
        }
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/health', (req, res) => res.json({ ok: true }));

// ============================================================
// WORKER ENTRY — матчинг + нагадування + завдання + закриття
// Викликається воркером кожну хвилину через /worker/tick
// ============================================================

app.post('/worker/tick', async (req, res) => {
    const secret = req.headers['x-worker-secret'];
    if (secret !== process.env.WORKER_SECRET) return res.status(403).json({ error: 'Forbidden' });

    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();
    const today = now.toISOString().split('T')[0];

    // За 15 хв: нагадування
    if (h === SLOT_HOUR && m === SLOT_MIN - 15) {
        const intents = await query(
            `SELECT ji.*, u.telegram_id FROM join_intents ji
             JOIN users u ON u.id = ji.user_id
             WHERE ji.slot_date = $1`, [today]
        );
        for (const i of intents.rows) {
            try {
                await send(i.telegram_id,
                    `⏰ Точка відкриється через 15 хвилин.\n\n` +
                    `${LOCATION}.\n\n` +
                    `Якщо поруч буде ще хтось — ви зробите завдання разом.\n` +
                    `Якщо ні — точка працює в тихому режимі.`
                );
            } catch (e) { console.error('reminder error', e.message); }
        }
    }

    // О SLOT_HOUR:SLOT_MIN — видаємо завдання + матчимо
    if (h === SLOT_HOUR && m === SLOT_MIN) {
        const intents = await query(
            `SELECT ji.*, u.telegram_id, u.meetings_completed
             FROM join_intents ji
             JOIN users u ON u.id = ji.user_id
             WHERE ji.slot_date = $1 AND ji.task_sent = FALSE`,
            [today]
        );

        const users = intents.rows;
        const pairs = [];
        const solos = [];

        for (let i = 0; i + 1 < users.length; i += 2) {
            pairs.push([users[i], users[i + 1]]);
        }
        if (users.length % 2 !== 0) solos.push(users[users.length - 1]);

        // Пари
        for (const [a, b] of pairs) {
            const task = pickTask(Math.min(a.meetings_completed, b.meetings_completed) + 1, true);
            for (const u of [a, b]) {
                try {
                    await send(u.telegram_id, `*Завдання:*\n\n${task.text}`);
                    await query(
                        `UPDATE join_intents SET task_sent = TRUE, task_type = $1, meeting_mode = 'together'
                         WHERE user_id = $2 AND slot_date = $3`,
                        [task.type, u.user_id, today]
                    );
                    await query(`UPDATE users SET meetings_completed = meetings_completed + 1 WHERE id = $1`, [u.user_id]);
                } catch (e) { console.error('task pair error', e.message); }
            }
        }

        // Сольні
        for (const u of solos) {
            const task = pickTask(u.meetings_completed + 1, false);
            try {
                await send(u.telegram_id, `*Завдання:*\n\n${task.text}`);
                await query(
                    `UPDATE join_intents SET task_sent = TRUE, task_type = $1, meeting_mode = 'solo'
                     WHERE user_id = $2 AND slot_date = $3`,
                    [task.type, u.user_id, today]
                );
                await query(`UPDATE users SET meetings_completed = meetings_completed + 1 WHERE id = $1`, [u.user_id]);
            } catch (e) { console.error('task solo error', e.message); }
        }

        // Notify-next users
        const notifyUsers = await query(
            `SELECT telegram_id FROM users WHERE notify_next = TRUE`
        );
        for (const u of notifyUsers.rows) {
            if (!users.find(i => i.telegram_id === u.telegram_id)) {
                try {
                    await send(u.telegram_id,
                        `🌿 Точка зараз відкрита!\n\n${slotTimeStr()}, ${LOCATION}.\n\nХочеш зайти?`,
                        kbd([[{ text: '🌿 Хочу зайти', callback_data: 'join' }]])
                    );
                    await query(`UPDATE users SET notify_next = FALSE WHERE telegram_id = $1`, [u.telegram_id]);
                } catch (e) {}
            }
        }
    }

    // +20 хв: закриття точки
    const closeH = SLOT_HOUR + Math.floor((SLOT_MIN + 20) / 60);
    const closeM = (SLOT_MIN + 20) % 60;

    if (h === closeH && m === closeM) {
        const intents = await query(
            `SELECT ji.*, u.telegram_id FROM join_intents ji
             JOIN users u ON u.id = ji.user_id
             WHERE ji.slot_date = $1 AND ji.task_sent = TRUE AND ji.closed = FALSE`,
            [today]
        );
        for (const i of intents.rows) {
            try {
                const isSolo = i.meeting_mode === 'solo';
                let text = `Точка закривається.\n\nМожна піти. Можна сидіти ще. Немає правила.`;
                if (isSolo) {
                    text += `\n\nТвоє фото в архіві сам.\nНаступна людина побачить його перед тим, як зайти.`;
                }
                text += `\n\nЧерез 2 години надішлемо 3 коротких питання.`;
                await send(i.telegram_id, text);
                await query(
                    `UPDATE join_intents SET closed = TRUE WHERE user_id = $1 AND slot_date = $2`,
                    [i.user_id, today]
                );
            } catch (e) { console.error('close error', e.message); }
        }
    }

    // +2 год 20 хв: фідбек
    const feedH = closeH + 2;
    const feedM = closeM;

    if (h === feedH && m === feedM) {
        const intents = await query(
            `SELECT ji.*, u.telegram_id FROM join_intents ji
             JOIN users u ON u.id = ji.user_id
             WHERE ji.slot_date = $1 AND ji.closed = TRUE AND ji.feedback_sent = FALSE`,
            [today]
        );
        for (const i of intents.rows) {
            try {
                await send(i.telegram_id,
                    `Як ти себе почуваєш?`,
                    kbd([[
                        { text: '1', callback_data: 'mood_1' },
                        { text: '2', callback_data: 'mood_2' },
                        { text: '3', callback_data: 'mood_3' },
                        { text: '4', callback_data: 'mood_4' },
                        { text: '5', callback_data: 'mood_5' },
                    ]])
                );
                await query(
                    `UPDATE join_intents SET feedback_sent = TRUE WHERE user_id = $1 AND slot_date = $2`,
                    [i.user_id, today]
                );
            } catch (e) { console.error('feedback error', e.message); }
        }

        // Асиметричний фідбек партнерів
        const paired = await query(
            `SELECT ji1.user_id as uid1, u1.telegram_id as tg1,
                    ji2.user_id as uid2, u2.telegram_id as tg2
             FROM join_intents ji1
             JOIN join_intents ji2 ON ji2.slot_date = ji1.slot_date
               AND ji2.partner_id = ji1.user_id
             JOIN users u1 ON u1.id = ji1.user_id
             JOIN users u2 ON u2.id = ji2.user_id
             WHERE ji1.slot_date = $1
               AND ji1.meeting_mode = 'together'
               AND (ji1.feedback_return = TRUE OR ji2.feedback_return = TRUE)
               AND ji1.partner_notified = FALSE`,
            [today]
        );

        for (const pair of paired.rows) {
            const msg =
                `Хтось із вас хоче ще.\n\n` +
                `Якщо обидва натиснете "Разом" — наступна точка разом.\n` +
                `Якщо ні — підберемо нових партнерів. Без пояснень.`;
            const pKbd = kbd([[
                { text: 'Разом', callback_data: 'partner_together' },
                { text: 'Новий', callback_data: 'partner_new' },
            ]]);
            try {
                await send(pair.tg1, msg, pKbd);
                await send(pair.tg2, msg, pKbd);
                await query(
                    `UPDATE join_intents SET partner_notified = TRUE
                     WHERE user_id IN ($1, $2) AND slot_date = $3`,
                    [pair.uid1, pair.uid2, today]
                );
            } catch (e) {}
        }
    }

    res.json({ ok: true });
});

// ============================================================
// START
// ============================================================

const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
    console.log(`Doto API running on port ${PORT}`);
    await setWebhook();
});
