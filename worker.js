// ============================================================
// DOTO — Worker
// Отдельный процесс. Не бот, не API.
// Запускает таймеры, проверяет no-show, отправляет feedback.
// ============================================================

const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:DotoData2069@db.kcdedrgylmxczjijoncx.supabase.co:5432/postgres',
    ssl: { rejectUnauthorized: false }
});

// Bot token нужен для отправки уведомлений через Telegram API
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

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

async function sendTelegram(telegramId, text, options = {}) {
    const body = {
        chat_id: telegramId,
        text,
        parse_mode: 'HTML',
        ...options
    };
    await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}

async function logEvent(userId, meetingId, eventType, metadata = {}) {
    await query(
        `INSERT INTO events (id, user_id, meeting_id, event_type, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [uuidv4(), userId, meetingId, eventType, JSON.stringify(metadata)]
    );
}

async function changeDp(userId, amount, reason) {
    await query(
        `UPDATE users SET dp = dp + $1 WHERE id = $2`,
        [amount, userId]
    );
    await query(
        `INSERT INTO dp_log (id, user_id, change, reason) VALUES ($1, $2, $3, $4)`,
        [uuidv4(), userId, amount, reason]
    );
}

// ============================================================
// БЛОК-ТАЙМЕР — отправляет блоки по расписанию во время встречи
// Запускается каждую минуту
// ============================================================
async function runBlockTimer() {
    const now = new Date();

    // Найти все активные встречи
    const activeMeetings = await query(
        `SELECT m.*, t.blocks, t.duration as task_duration
         FROM meetings m
         JOIN tasks t ON t.id = m.task_id
         WHERE m.status = 'active'`
    );

    for (const meeting of activeMeetings.rows) {
        const blocks = meeting.blocks || [];
        const startedAt = new Date(meeting.scheduled_at);
        const elapsedMin = Math.floor((now - startedAt) / 60000);

        let cumulativeMin = 0;
        for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i];
            const blockStart = cumulativeMin;
            cumulativeMin += block.minutes;

            // Отправляем блок ровно в момент его старта (с допуском 1 мин)
            if (elapsedMin === blockStart) {
                // Получаем участников
                const participants = await query(
                    `SELECT mp.user_id, u.telegram_id
                     FROM meeting_participants mp
                     JOIN users u ON u.id = mp.user_id
                     WHERE mp.meeting_id = $1 AND mp.left_at IS NULL`,
                    [meeting.id]
                );

                for (const p of participants.rows) {
                    await sendTelegram(
                        p.telegram_id,
                        `⏱ <b>Блок ${i + 1} из ${blocks.length}</b> — ${block.minutes} мин\n\n${block.text}`
                    );
                }
            }
        }

        // Автозавершение если время вышло
        if (elapsedMin >= meeting.task_duration) {
            const result = await query(
                `UPDATE meetings SET status = 'completed'
                 WHERE id = $1 AND status != 'completed'
                 RETURNING id`,
                [meeting.id]
            );

            if (result.rowCount > 0) {
                await handleCompletion(meeting.id);
            }
        }
    }
}

// ============================================================
// NO-SHOW ПРОВЕРКА — grace period 15 мин
// ============================================================
async function checkNoShow() {
    const now = new Date();

    // Встречи в статусе matched где прошло > 15 мин после scheduled_at
    const staleMeetings = await query(
        `SELECT m.id, mp.user_id, u.telegram_id, u.no_show_count
         FROM meetings m
         JOIN meeting_participants mp ON mp.meeting_id = m.id
         JOIN users u ON u.id = mp.user_id
         WHERE m.status = 'matched'
           AND m.scheduled_at < NOW() - INTERVAL '15 minutes'
           AND mp.checkin_status = 'pending'`
    );

    for (const row of staleMeetings.rows) {
        const noShowCount = row.no_show_count + 1;

        // Обновляем статус участника
        await query(
            `UPDATE meeting_participants SET checkin_status = 'no_show'
             WHERE meeting_id = $1 AND user_id = $2`,
            [row.id, row.user_id]
        );

        await logEvent(row.user_id, row.id, 'no_show', { count: noShowCount });

        // Прогрессивные штрафы
        let dpPenalty = 0;
        let banDays = 0;

        if (noShowCount === 1) {
            dpPenalty = -15;
            // Первый раз — только предупреждение
            await sendTelegram(row.telegram_id,
                '😔 Ты не добрался до встречи. Бывает.\n\nВ следующий раз попробуй снова.'
            );
        } else if (noShowCount === 2) {
            dpPenalty = -30;
            await sendTelegram(row.telegram_id,
                '⚠️ Второй пропуск. Не забывай — другой человек тебя ждал.'
            );
        } else {
            dpPenalty = -30;
            banDays = 7;
            await query(
                `UPDATE users SET banned_until = NOW() + INTERVAL '${banDays} days'
                 WHERE id = $1`,
                [row.user_id]
            );
            await sendTelegram(row.telegram_id,
                `⛔ После нескольких пропусков запись приостановлена на ${banDays} дней.`
            );
        }

        await changeDp(row.user_id, dpPenalty, 'no_show');
        await query(
            `UPDATE users SET no_show_count = no_show_count + 1 WHERE id = $1`,
            [row.user_id]
        );

        // Уведомить второго участника и предложить соло
        const other = await query(
            `SELECT mp.user_id, u.telegram_id
             FROM meeting_participants mp
             JOIN users u ON u.id = mp.user_id
             WHERE mp.meeting_id = $1
               AND mp.user_id != $2
               AND mp.checkin_status = 'checked_in'`,
            [row.id, row.user_id]
        );

        for (const o of other.rows) {
            await sendTelegram(o.telegram_id,
                'Напарник не добрался. Хочешь продолжить один? За это +60 DP.',
                {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: 'Продолжу один (+60 DP)', callback_data: `solo_continue:${row.id}` },
                            { text: 'Завершу', callback_data: `cancel_after_noshow:${row.id}` }
                        ]]
                    }
                }
            );
        }
    }
}

// ============================================================
// FEEDBACK — отправка вопросов после встречи
// ============================================================
async function sendFeedback() {
    // Найти feedback записи где sent_at прошло и ещё не отправлено
    const pending = await query(
        `SELECT f.*, u.telegram_id
         FROM feedback f
         JOIN users u ON u.id = f.user_id
         WHERE f.answered_at IS NULL
           AND f.sent_at <= NOW()
           AND (f.retry_sent = FALSE OR f.retry_sent IS NULL)`
    );

    for (const f of pending.rows) {
        const isRetry = f.answered_at === null && f.retry_sent === true;

        if (!isRetry) {
            // Первая отправка
            await sendTelegram(f.telegram_id,
                'Как прошло?',
                {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '😐 Нормально', callback_data: `feedback:${f.meeting_id}:normal` },
                            { text: '🙂 Хорошо', callback_data: `feedback:${f.meeting_id}:good` },
                            { text: '👍 Хочу ещё', callback_data: `feedback:${f.meeting_id}:repeat` }
                        ]]
                    }
                }
            );

            // Запланировать retry через 12 часов
            await query(
                `UPDATE feedback SET sent_at = NOW() + INTERVAL '12 hours', retry_sent = FALSE
                 WHERE id = $1`,
                [f.id]
            );
        } else {
            // Retry — последний шанс
            await sendTelegram(f.telegram_id,
                'Кстати, как тебе было на встрече?',
                {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '😐', callback_data: `feedback:${f.meeting_id}:normal` },
                            { text: '🙂', callback_data: `feedback:${f.meeting_id}:good` },
                            { text: '👍', callback_data: `feedback:${f.meeting_id}:repeat` }
                        ]]
                    }
                }
            );
            await query(
                `UPDATE feedback SET retry_sent = TRUE WHERE id = $1`,
                [f.id]
            );
        }
    }

    // Comfort check — через 2-3 часа после встречи (отдельный вопрос)
    const comfortPending = await query(
        `SELECT f.*, u.telegram_id, m.scheduled_at
         FROM feedback f
         JOIN users u ON u.id = f.user_id
         JOIN meetings m ON m.id = f.meeting_id
         WHERE f.comfort IS NULL
           AND m.scheduled_at < NOW() - INTERVAL '2 hours'
           AND f.experience IS NOT NULL`
    );

    for (const f of comfortPending.rows) {
        await sendTelegram(f.telegram_id,
            'Было комфортно рядом?',
            {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '👍 да', callback_data: `comfort:${f.meeting_id}:yes` },
                        { text: '👎 не очень', callback_data: `comfort:${f.meeting_id}:no` }
                    ]]
                }
            }
        );
    }
}

// ============================================================
// COMPLETION HANDLER — вызывается при завершении встречи
// ============================================================
async function handleCompletion(meetingId) {
    const participants = await query(
        `SELECT mp.user_id, u.telegram_id, u.trust_score
         FROM meeting_participants mp
         JOIN users u ON u.id = mp.user_id
         WHERE mp.meeting_id = $1 AND mp.left_at IS NULL`,
        [meetingId]
    );

    for (const p of participants.rows) {
        await changeDp(p.user_id, 50, 'complete');
        await query(
            `UPDATE users SET
               meetings_completed = meetings_completed + 1,
               trust_score = LEAST(trust_score + 0.02, 1.5)
             WHERE id = $1`,
            [p.user_id]
        );
        await query(
            `INSERT INTO feedback (id, meeting_id, user_id, sent_at)
             VALUES ($1, $2, $3, NOW() + INTERVAL '30 minutes')
             ON CONFLICT (meeting_id, user_id) DO NOTHING`,
            [uuidv4(), meetingId, p.user_id]
        );
        await logEvent(p.user_id, meetingId, 'complete');
    }
}

// ============================================================
// SEED GENERATOR — проверяет ленту и добавляет seed если мало встреч
// ============================================================
async function ensureSeeds() {
    const openMeetings = await query(
        `SELECT COUNT(*) FROM meetings
         WHERE status IN ('open', 'partial')
           AND scheduled_at > NOW()`
    );

    const count = parseInt(openMeetings.rows[0].count);

    if (count < 3) {
        // Запрашиваем DeepSeek для генерации задания
        const seedTask = await generateSeedTask();
        if (seedTask) {
            await query(
                `INSERT INTO meetings (id, task_id, location_name, lat, lng, scheduled_at, is_seed)
                 VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '2 hours', TRUE)`,
                [uuidv4(), seedTask.id, seedTask.location, seedTask.lat, seedTask.lng]
            );
        }
    }
}

async function generateSeedTask() {
    try {
        const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
            },
            body: JSON.stringify({
                model: 'deepseek-chat',
                messages: [{
                    role: 'user',
                    content: `Создай задание для встречи Doto. Формат строго JSON:
{
  "title": "короткое название состояния (макс 5 слов)",
  "description": "одна строка описания",
  "type": "observe|move|act",
  "blocks": [
    {"minutes": 10, "text": "действие"},
    {"minutes": 10, "text": "действие"},
    {"minutes": 10, "text": "действие"},
    {"minutes": 10, "text": "итог или свобода"}
  ]
}
Правила: физическое действие, не абстракция. Всего не более 40 слов. Только JSON, без markdown.`
                }],
                max_tokens: 300
            })
        });

        const data = await response.json();
        const raw = data.choices?.[0]?.message?.content || '';
        const taskData = JSON.parse(raw.trim());

        // Валидация
        if (!taskData.title || !taskData.blocks || taskData.blocks.length !== 4) {
            return null;
        }

        // Дедупликация по hash
        const hash = Buffer.from(taskData.title.toLowerCase()).toString('base64');
        const exists = await query(
            `SELECT id FROM tasks WHERE similarity_hash = $1`, [hash]
        );
        if (exists.rows.length > 0) return null;

        // Сохраняем задание
        const result = await query(
            `INSERT INTO tasks (id, title, description, type, blocks, is_seed, similarity_hash)
             VALUES ($1, $2, $3, $4, $5, TRUE, $6)
             RETURNING id`,
            [
                uuidv4(),
                taskData.title,
                taskData.description || '',
                taskData.type || 'observe',
                JSON.stringify(taskData.blocks),
                hash
            ]
        );

        return {
            id: result.rows[0].id,
            location: 'Парк Шевченко',  // TODO: динамически по городу
            lat: 50.4417,
            lng: 30.5206
        };

    } catch (err) {
        console.error('DeepSeek generation failed:', err.message);
        return null;
    }
}

// ============================================================
// SCHEDULER — запускаем все воркеры по расписанию
// ============================================================
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runWorker() {
    console.log('Doto Worker started');

    while (true) {
        try {
            await Promise.all([
                runBlockTimer(),
                checkNoShow(),
                sendFeedback(),
                ensureSeeds()
            ]);
        } catch (err) {
            console.error('Worker error:', err);
        }

        await sleep(60 * 1000); // каждую минуту
    }
}

runWorker();
