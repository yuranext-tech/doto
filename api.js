// ============================================================
// DOTO — API + BOT (Express.js, webhook mode)
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

// ============================================================
// API ENDPOINTS
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
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/join', async (req, res) => {
    const { userId, meetingId } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const meetingResult = await client.query(`SELECT * FROM meetings WHERE id = $1 FOR UPDATE`, [meetingId]);
        const meeting = meetingResult.rows[0];
        if (!meeting || !['open', 'partial'].includes(meeting.status)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Meeting not available' });
        }
        const countResult = await client.query(`SELECT COUNT(*) FROM meeting_participants WHERE meeting_id = $1`, [meetingId]);
        const count = parseInt(countResult.rows[0].count);
        if (count >= 3) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Meeting is full' });
        }
        await client.query(`INSERT INTO meeting_participants (id, meeting_id, user_id) VALUES ($1, $2, $3)`, [uuidv4(), meetingId, userId]);
        const newStatus = count === 0 ? 'partial' : 'matched';
        await client.query(`UPDATE meetings SET status = $1 WHERE id = $2`, [newStatus, meetingId]);
        await client.query('COMMIT');
        res.json({ status: newStatus });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Server error' });
    } finally {
        client.release();
    }
});

app.post('/checkin', async (req, res) => {
    const { userId, meetingId } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `UPDATE meeting_participants SET checkin_status = 'checked_in', checked_in_at = NOW() WHERE user_id = $1 AND meeting_id = $2`,
            [userId, meetingId]
        );
        await logEvent(client, { userId, meetingId, eventType: 'checkin' });
        const checkedIn = await client.query(`SELECT COUNT(*) FROM meeting_participants WHERE meeting_id = $1 AND checkin_status = 'checked_in'`, [meetingId]);
        const total = await client.query(`SELECT COUNT(*) FROM meeting_participants WHERE meeting_id = $1`, [meetingId]);
        if (parseInt(checkedIn.rows[0].count) === parseInt(total.rows[0].count)) {
            await client.query(`UPDATE meetings SET status = 'active' WHERE id = $1`, [meetingId]);
        }
        await client.query('COMMIT');
        res.json({ ok: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Server error' });
    } finally {
        client.release();
    }
});

app.post('/leave', async (req, res) => {
    const { userId, meetingId, blockNumber, timeSpent } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`UPDATE meeting_participants SET left_at = NOW() WHERE user_id = $1 AND meeting_id = $2`, [userId, meetingId]);
        await logEvent(client, { userId, meetingId, eventType: 'abandon', metadata: { block_number: blockNumber, time_spent: timeSpent } });
        await changeDp(client, userId, 20, 'abandon');
        const remaining = await client.query(`SELECT user_id FROM meeting_participants WHERE meeting_id = $1 AND left_at IS NULL AND user_id != $2`, [meetingId, userId]);
        if (remaining.rows.length === 0) {
            await client.query(`UPDATE meetings SET status = 'abandoned' WHERE id = $1`, [meetingId]);
        }
        await client.query('COMMIT');
        res.json({ ok: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Server error' });
    } finally {
        client.release();
    }
});

app.post('/complete', async (req, res) => {
    const { userId, meetingId } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(`UPDATE meetings SET status = 'completed' WHERE id = $1 AND status != 'completed' RETURNING id`, [meetingId]);
        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.json({ ok: true, alreadyCompleted: true });
        }
        const participants = await client.query(`SELECT user_id FROM meeting_participants WHERE meeting_id = $1 AND left_at IS NULL`, [meetingId]);
        for (const p of participants.rows) {
            await changeDp(client, p.user_id, 50, 'complete');
            await client.query(`UPDATE users SET meetings_completed = meetings_completed + 1, trust_score = LEAST(trust_score + 0.02, 1.5) WHERE id = $1`, [p.user_id]);
            await logEvent(client, { userId: p.user_id, meetingId, eventType: 'complete' });
            await client.query(
                `INSERT INTO feedback (id, meeting_id, user_id, sent_at) VALUES ($1, $2, $3, NOW() + INTERVAL '30 minutes') ON CONFLICT (meeting_id, user_id) DO NOTHING`,
                [uuidv4(), meetingId, p.user_id]
            );
        }
        await client.query('COMMIT');
        res.json({ ok: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Server error' });
    } finally {
        client.release();
    }
});

app.post('/feedback', async (req, res) => {
    const { userId, meetingId, experience, comfort, reason } = req.body;
    try {
        await query(`UPDATE feedback SET experience=$1, comfort=$2, reason=$3, answered_at=NOW() WHERE user_id=$4 AND meeting_id=$5`, [experience, comfort, reason || null, userId, meetingId]);
        if (comfort === 'no' && reason) {
            await query(`INSERT INTO reports (id, reporter_id, meeting_id, reason) VALUES ($1, $2, $3, $4)`, [uuidv4(), userId, meetingId, reason]);
            const other = await query(`SELECT user_id FROM meeting_participants WHERE meeting_id = $1 AND user_id != $2`, [meetingId, userId]);
            if (other.rows.length > 0) {
                await query(`UPDATE users SET trust_score = GREATEST(trust_score - 0.1, 0) WHERE id = $1`, [other.rows[0].user_id]);
            }
        }
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/users', async (req, res) => {
    const { telegramId, username, ageGroup, currentState } = req.body;
    try {
        const result = await query(
            `INSERT INTO users (id, telegram_id, username, age_group, current_state) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username RETURNING *`,
            [uuidv4(), telegramId, username, ageGroup, currentState]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/users', async (req, res) => {
    try {
        const { telegramId } = req.query;
        const result = await query(`SELECT * FROM users WHERE telegram_id = $1`, [telegramId]);
        if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/users/:id/dp', async (req, res) => {
    try {
        const result = await query(`SELECT dp FROM users WHERE id = $1`, [req.params.id]);
        if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
        res.json({ dp: result.rows[0].dp });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ============================================================
// BOT HANDLERS
// ============================================================

const onboarding = {};

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const username = msg.from.username || msg.from.first_name;
    onboarding[chatId] = { telegramId, username };
    await bot.sendMessage(chatId,
        'Doto — задания в парке или библиотеке.\nДля студентов и тех кому 18–25.\n\nНикакого знакомства если не хочешь — просто оказаться рядом пока делаешь что-то.',
        { reply_markup: { inline_keyboard: [[{ text: 'Попробовать', callback_data: 'onboard:state' }]] } }
    );
});

bot.onText(/\/tasks/, async (msg) => {
    const chatId = msg.chat.id;
    const result = await query(`SELECT id FROM users WHERE telegram_id = $1`, [msg.from.id]);
    if (!result.rows.length) return bot.sendMessage(chatId, 'Сначала зарегистрируйся — нажми /start');
    const feed = await query(
        `SELECT m.*, t.title, t.description FROM meetings m JOIN tasks t ON t.id = m.task_id WHERE m.status IN ('open','partial') AND m.scheduled_at > NOW() LIMIT 3`
    );
    if (!feed.rows.length) return bot.sendMessage(chatId, 'Сейчас встреч нет. Загляни через пару часов.');
    for (const m of feed.rows) {
        const date = new Date(m.scheduled_at).toLocaleString('ru-RU');
        await bot.sendMessage(chatId,
            `📍 ${m.location_name || 'Место встречи'}\n\n${m.description || m.title}\n\n${date} · 👥 Небольшая встреча`,
            { reply_markup: { inline_keyboard: [[{ text: 'Иду', callback_data: `join:${m.id}` }, { text: 'Другой вариант', callback_data: 'show_feed' }]] } }
        );
    }
});

bot.onText(/\/dp/, async (msg) => {
    const result = await query(`SELECT dp FROM users WHERE telegram_id = $1`, [msg.from.id]);
    if (!result.rows.length) return;
    bot.sendMessage(msg.chat.id, `Твой баланс: ${result.rows[0].dp} DP`);
});

bot.on('callback_query', async (q) => {
    const chatId = q.message.chat.id;
    const data = q.data;
    const telegramId = q.from.id;
    await bot.answerCallbackQuery(q.id);

    if (data === 'onboard:state') {
        await bot.sendMessage(chatId, 'Как ты видишь эту встречу?', { reply_markup: { inline_keyboard: [
            [{ text: '❤️ Можно почти не разговаривать', callback_data: 'state:calm' }],
            [{ text: '🙂 Немного общения', callback_data: 'state:neutral' }],
            [{ text: '⚡ Более живой формат', callback_data: 'state:active' }]
        ] } });
    }

    if (data.startsWith('state:')) {
        const state = data.split(':')[1];
        onboarding[chatId] = { ...onboarding[chatId], state };
        await bot.sendMessage(chatId, 'Тебе ближе:', { reply_markup: { inline_keyboard: [
            [{ text: '🎓 студент (18–21)', callback_data: 'age:student' }],
            [{ text: '🧑 уже работаю (22–25)', callback_data: 'age:early_work' }]
        ] } });
    }

    if (data.startsWith('age:')) {
        const ageGroup = data.split(':')[1];
        const ob = onboarding[chatId] || {};
        const result = await query(
            `INSERT INTO users (id, telegram_id, username, age_group, current_state) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username RETURNING *`,
            [uuidv4(), telegramId, ob.username, ageGroup, ob.state]
        );
        onboarding[chatId] = { ...ob, userId: result.rows[0].id };
        await bot.sendMessage(chatId, 'Готово. Покажу ближайшие встречи.',
            { reply_markup: { inline_keyboard: [[{ text: 'Смотреть встречи', callback_data: 'show_feed' }]] } }
        );
    }

    if (data === 'show_feed') {
        const feed = await query(
            `SELECT m.*, t.title, t.description FROM meetings m JOIN tasks t ON t.id = m.task_id WHERE m.status IN ('open','partial') AND m.scheduled_at > NOW() LIMIT 3`
        );
        if (!feed.rows.length) return bot.sendMessage(chatId, 'Сейчас встреч нет. Загляни через пару часов.');
        for (const m of feed.rows) {
            const date = new Date(m.scheduled_at).toLocaleString('ru-RU');
            await bot.sendMessage(chatId,
                `📍 ${m.location_name || 'Место встречи'}\n\n${m.description || m.title}\n\n${date} · 👥 Небольшая встреча`,
                { reply_markup: { inline_keyboard: [[{ text: 'Иду', callback_data: `join:${m.id}` }, { text: 'Другой вариант', callback_data: 'show_feed' }]] } }
            );
        }
    }

    if (data.startsWith('join:')) {
        const meetingId = data.split(':')[1];
        const userRes = await query(`SELECT id FROM users WHERE telegram_id = $1`, [telegramId]);
        if (!userRes.rows.length) return;
        const userId = userRes.rows[0].id;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const m = await client.query(`SELECT * FROM meetings WHERE id = $1 FOR UPDATE`, [meetingId]);
            if (!m.rows.length || !['open', 'partial'].includes(m.rows[0].status)) {
                await client.query('ROLLBACK');
                return bot.sendMessage(chatId, 'Место уже занято. Попробуй другую встречу.');
            }
            const cnt = await client.query(`SELECT COUNT(*) FROM meeting_participants WHERE meeting_id = $1`, [meetingId]);
            if (parseInt(cnt.rows[0].count) >= 3) {
                await client.query('ROLLBACK');
                return bot.sendMessage(chatId, 'Место уже занято.');
            }
            await client.query(`INSERT INTO meeting_participants (id, meeting_id, user_id) VALUES ($1, $2, $3)`, [uuidv4(), meetingId, userId]);
            const newStatus = parseInt(cnt.rows[0].count) === 0 ? 'partial' : 'matched';
            await client.query(`UPDATE meetings SET status = $1 WHERE id = $2`, [newStatus, meetingId]);
            await client.query('COMMIT');
            await bot.sendMessage(chatId, 'Ты записан.\n\nНичего готовить не нужно. Просто приди.');
        } catch (e) {
            await client.query('ROLLBACK');
            bot.sendMessage(chatId, 'Что-то пошло не так. Попробуй ещё раз.');
        } finally {
            client.release();
        }
    }

    if (data.startsWith('feedback:')) {
        const [, meetingId, experience] = data.split(':');
        const userRes = await query(`SELECT id FROM users WHERE telegram_id = $1`, [telegramId]);
        if (!userRes.rows.length) return;
        await query(`UPDATE feedback SET experience=$1, answered_at=NOW() WHERE user_id=$2 AND meeting_id=$3`, [experience, userRes.rows[0].id, meetingId]);
        await bot.sendMessage(chatId, 'Спасибо.');
    }

    if (data.startsWith('comfort:')) {
        const [, meetingId, comfort] = data.split(':');
        const userRes = await query(`SELECT id FROM users WHERE telegram_id = $1`, [telegramId]);
        if (!userRes.rows.length) return;
        if (comfort === 'no') {
            await bot.sendMessage(chatId, 'Что было не так?', { reply_markup: { inline_keyboard: [
                [{ text: 'Не мой возраст', callback_data: `reason:${meetingId}:age` }],
                [{ text: 'Некомфортное поведение', callback_data: `reason:${meetingId}:behavior` }],
                [{ text: 'Другое', callback_data: `reason:${meetingId}:other` }]
            ] } });
        } else {
            await query(`UPDATE feedback SET comfort=$1 WHERE user_id=$2 AND meeting_id=$3`, [comfort, userRes.rows[0].id, meetingId]);
            await bot.sendMessage(chatId, 'Хорошо.');
        }
    }

    if (data.startsWith('reason:')) {
        const [, meetingId, reason] = data.split(':');
        const userRes = await query(`SELECT id FROM users WHERE telegram_id = $1`, [telegramId]);
        if (!userRes.rows.length) return;
        await query(`UPDATE feedback SET comfort='no', reason=$1 WHERE user_id=$2 AND meeting_id=$3`, [reason, userRes.rows[0].id, meetingId]);
        await bot.sendMessage(chatId, 'Понял. Учтём.');
    }
});

// ============================================================
// START
// ============================================================

const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
    console.log(`Doto API running on port ${PORT}`);
    console.log('Doto Bot attached to API process');
    await setWebhook();
});
