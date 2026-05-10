const TelegramBot = require('node-telegram-bot-api');

const TOKEN = process.env.TELEGRAM_TOKEN;
const API_URL = process.env.API_URL || 'https://doto-6zi6.onrender.com';

const bot = new TelegramBot(TOKEN, { polling: true });

async function apiPost(path, body) {
    const res = await fetch(`${API_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return res.json();
}

async function apiGet(path) {
    const res = await fetch(`${API_URL}${path}`);
    return res.json();
}

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
    const userId = await getUserId(msg.from.id);
    if (!userId) return bot.sendMessage(chatId, 'Сначала зарегистрируйся — нажми /start');
    const data = await apiGet(`/feed?userId=${userId}`);
    const meetings = data.meetings || [];
    if (!meetings.length) return bot.sendMessage(chatId, 'Сейчас встреч нет. Загляни через пару часов.');
    for (const m of meetings.slice(0, 3)) {
        const date = new Date(m.scheduled_at).toLocaleString('ru-RU');
        const slots = parseInt(m.participant_count) === 1 ? '👥 1 из 2 — уже ждут' : '👥 0 из 2';
        await bot.sendMessage(chatId,
            `📍 ${m.location_name || 'Место встречи'}\n🎯 ${m.title}\n\n${date}\n${slots}`,
            { reply_markup: { inline_keyboard: [[{ text: 'Иду', callback_data: `join:${m.id}` }, { text: 'Подробнее', callback_data: `detail:${m.id}` }]] } }
        );
    }
});

bot.onText(/\/dp/, async (msg) => {
    const userId = await getUserId(msg.from.id);
    if (!userId) return;
    const data = await apiGet(`/users/${userId}/dp`);
    bot.sendMessage(msg.chat.id, `Твой баланс: ${data.dp} DP`);
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const telegramId = query.from.id;
    await bot.answerCallbackQuery(query.id);

    if (data === 'onboard:state') {
        await bot.sendMessage(chatId, 'Как тебе сегодня?', { reply_markup: { inline_keyboard: [
            [{ text: '🌿 спокойно, без разговоров', callback_data: 'state:calm' }],
            [{ text: '🙂 по настроению', callback_data: 'state:neutral' }],
            [{ text: '⚡ готов включаться', callback_data: 'state:active' }]
        ]}});
    }
    if (data.startsWith('state:')) {
        const state = data.split(':')[1];
        onboarding[chatId] = { ...onboarding[chatId], state };
        await bot.sendMessage(chatId, 'Тебе ближе:', { reply_markup: { inline_keyboard: [
            [{ text: '🎓 студент (18–21)', callback_data: 'age:student' }],
            [{ text: '🧑 уже работаю (22–25)', callback_data: 'age:early_work' }]
        ]}});
    }
    if (data.startsWith('age:')) {
        const ageGroup = data.split(':')[1];
        const ob = onboarding[chatId] || {};
        const result = await apiPost('/users', { telegramId, username: ob.username, ageGroup, currentState: ob.state });
        onboarding[chatId] = { ...ob, userId: result.id };
        await bot.sendMessage(chatId, 'Готово. Покажу ближайшие встречи.', { reply_markup: { inline_keyboard: [[{ text: 'Смотреть встречи', callback_data: 'show_feed' }]] }});
    }
    if (data === 'show_feed') {
        bot.emit('message', { ...query.message, text: '/tasks', from: query.from });
    }
    if (data.startsWith('join:')) {
        const meetingId = data.split(':')[1];
        const userId = await getUserId(telegramId);
        if (!userId) return;
        const result = await apiPost('/join', { userId, meetingId });
        if (result.error) return bot.sendMessage(chatId, 'Место уже занято. Попробуй другую встречу.');
        await bot.sendMessage(chatId, 'Ты записан.\n\nНичего готовить не нужно. Просто приди.');
    }
    if (data.startsWith('detail:')) {
        const meetingId = data.split(':')[1];
        await bot.sendMessage(chatId, '🕐 0–10 мин: найди место\n🕐 10–20 мин: сделайте вместе\n🕐 20–30 мин: зафиксируйте\n🕐 30–40 мин: свободно',
            { reply_markup: { inline_keyboard: [[{ text: 'Иду', callback_data: `join:${meetingId}` }]] }});
    }
    if (data.startsWith('checkin:')) {
        const meetingId = data.split(':')[1];
        const userId = await getUserId(telegramId);
        await apiPost('/checkin', { userId, meetingId });
        await bot.sendMessage(chatId, 'Отлично. Встреча начинается.');
    }
    if (data.startsWith('leave:')) {
        const [, meetingId, blockNumber] = data.split(':');
        const userId = await getUserId(telegramId);
        await apiPost('/leave', { userId, meetingId, blockNumber: parseInt(blockNumber), timeSpent: parseInt(blockNumber) * 10 });
        await bot.sendMessage(chatId, 'Ок. Встреча завершена для тебя.');
    }
    if (data.startsWith('feedback:')) {
        const [, meetingId, experience] = data.split(':');
        const userId = await getUserId(telegramId);
        await apiPost('/feedback', { userId, meetingId, experience });
        await bot.sendMessage(chatId, 'Спасибо.');
    }
    if (data.startsWith('comfort:')) {
        const [, meetingId, comfort] = data.split(':');
        const userId = await getUserId(telegramId);
        if (comfort === 'no') {
            await bot.sendMessage(chatId, 'Что было не так?', { reply_markup: { inline_keyboard: [
                [{ text: 'Не мой возраст', callback_data: `reason:${meetingId}:age` }],
                [{ text: 'Некомфортное поведение', callback_data: `reason:${meetingId}:behavior` }],
                [{ text: 'Другое', callback_data: `reason:${meetingId}:other` }]
            ]}});
        } else {
            await apiPost('/feedback', { userId, meetingId, comfort });
            await bot.sendMessage(chatId, 'Хорошо.');
        }
    }
    if (data.startsWith('reason:')) {
        const [, meetingId, reason] = data.split(':');
        const userId = await getUserId(telegramId);
        await apiPost('/feedback', { userId, meetingId, comfort: 'no', reason });
        await bot.sendMessage(chatId, 'Понял. Учтём.');
    }
});

async function getUserId(telegramId) {
    try {
        const res = await fetch(`${API_URL}/users?telegramId=${telegramId}`);
        if (!res.ok) return null;
        const data = await res.json();
        return data?.id || null;
    } catch { return null; }
}

console.log('Doto Bot started');
