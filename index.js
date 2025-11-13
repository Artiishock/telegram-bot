

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express');
require('dotenv').config();


// Конфигурация
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const STATAMIC_API_URL = process.env.STATAMIC_API_URL;
const API_TOKEN = process.env.TELEGRAM_API_TOKEN;

const ADMIN_CHAT_IDS = process.env.ADMIN_CHAT_IDS 
    ? process.env.ADMIN_CHAT_IDS.split(',').map(id => parseInt(id.trim()))
    : [];

// Группы для публикации
const PROPERTY_GROUPS = process.env.TELEGRAM_PROPERTY_GROUPS 
    ? process.env.TELEGRAM_PROPERTY_GROUPS.split(',').map(id => id.trim())
    : [];

const NEWS_GROUPS = process.env.TELEGRAM_NEWS_GROUPS 
    ? process.env.TELEGRAM_NEWS_GROUPS.split(',').map(id => id.trim())
    : [];

const ALL_GROUPS = process.env.TELEGRAM_ALL_GROUPS 
    ? process.env.TELEGRAM_ALL_GROUPS.split(',').map(id => id.trim())
    : [];

const PORT = process.env.PORT || 3000;

// Инициализация бота
const bot = new TelegramBot(TELEGRAM_TOKEN, { 
    polling: true

 });
const app = express();

// Временное хранилище данных пользователей
const userStates = new Map();
const pendingConfirmations = new Map();

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Необработанное отклонение промиса:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Неперехваченное исключение:', error);
});

// Обработчик для самого бота
bot.on('polling_error', (error) => {
    console.error('❌ Ошибка polling бота:', error);
});

bot.on('webhook_error', (error) => {
    console.error('❌ Ошибка webhook бота:', error);
});

function escapeMarkdown(text) {
    if (!text) return '';
    
    // Экранируем символы, которые могут сломать Markdown
    return text.toString()
        .replace(/_/g, '\\_')
        .replace(/\*/g, '\\*')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)')
        .replace(/~/g, '\\~')
        .replace(/`/g, '\\`')
        .replace(/>/g, '\\>')
        .replace(/#/g, '\\#')
        .replace(/\+/g, '\\+')
        .replace(/-/g, '\\-')
        .replace(/=/g, '\\=')
        .replace(/\|/g, '\\|')
        .replace(/\{/g, '\\{')
        .replace(/\}/g, '\\}')
        .replace(/\./g, '\\.')
        .replace(/!/g, '\\!');
}

// ==================== ФУНКЦИИ ПРОВЕРКИ ПРАВ ДОСТУПА ====================

function isAdmin(chatId) {
    return ADMIN_CHAT_IDS.includes(chatId);
}

function sendAccessDenied(chatId) {
    return bot.sendMessage(chatId, '❌ У вас нет доступа к этому боту. Обратитесь к администратору.');
}

function logAction(chatId, username, action) {
    console.log(`🔐 Действие: ${action} | ChatID: ${chatId} | User: @${username || 'Unknown'} | Status: ${isAdmin(chatId) ? 'ALLOWED' : 'DENIED'}`);
}

// ==================== СИСТЕМА ПОДТВЕРЖДЕНИЙ ====================

function askConfirmation(chatId, action, actionData, confirmationMessage) {
    pendingConfirmations.set(chatId, {
        action: action,
        data: actionData,
        timestamp: Date.now()
    });
    
    return bot.sendMessage(chatId, confirmationMessage, {
        reply_markup: {
            keyboard: [[{ text: '✅ Да' }, { text: '❌ Нет' }]],
            one_time_keyboard: true,
            resize_keyboard: true
        }
    });
}

async function handleConfirmation(chatId, text, username) {
    const confirmation = pendingConfirmations.get(chatId);
    
    if (!confirmation) {
        return false;
    }
    
    // Удаляем подтверждение независимо от ответа
    pendingConfirmations.delete(chatId);
    
    if (text.toLowerCase().includes('да') || text === '✅ Да') {
        logAction(chatId, username, `ПОДТВЕРЖДЕНО: ${confirmation.action}`);
        
        switch (confirmation.action) {
            case 'deleteAll':
                await executeDeleteAll(chatId);
                break;
            case 'deleteDrafts':
                await executeDeleteDrafts(chatId);
                break;
            case 'deleteOld':
                await executeDeleteOld(chatId);
                break;
            case 'deleteById':
                await executeDeleteById(chatId, confirmation.data.id);
                break;
            case 'addProperty':
                await executeAddProperty(chatId, confirmation.data.propertyData);
                break;
            case 'addNews':
                await executeAddNews(chatId, confirmation.data.newsData);
                break;
            default:
                bot.sendMessage(chatId, '❌ Неизвестное действие');
        }
    } else {
        bot.sendMessage(chatId, '❌ Действие отменено.');
        logAction(chatId, username, `ОТМЕНЕНО: ${confirmation.action}`);
    }
    
    return true;
}

// ==================== ФУНКЦИИ ВЫПОЛНЕНИЯ ДЕЙСТВИЙ ====================

bot.onText(/\/check_groups/, (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAdmin(chatId)) {
        return sendAccessDenied(chatId);
    }
    
    const info = `
🔍 *Проверка настроек групп:*

🏠 *Группы объектов:* ${PROPERTY_GROUPS.length}
${PROPERTY_GROUPS.map(g => `  - ${g}`).join('\n')}

📰 *Группы новостей:* ${NEWS_GROUPS.length}
${NEWS_GROUPS.map(g => `  - ${g}`).join('\n')}

🌐 *Все группы:* ${ALL_GROUPS.length}
${ALL_GROUPS.map(g => `  - ${g}`).join('\n')}

*Объединенные группы для объектов:* ${[...new Set([...PROPERTY_GROUPS, ...ALL_GROUPS])].length}
*Объединенные группы для новостей:* ${[...new Set([...NEWS_GROUPS, ...ALL_GROUPS])].length}

*Проверьте .env файл:*
- TELEGRAM_PROPERTY_GROUPS
- TELEGRAM_NEWS_GROUPS  
- TELEGRAM_ALL_GROUPS
    `;
    
    bot.sendMessage(chatId, info, { parse_mode: 'Markdown' });
});

bot.onText(/\/check_bot_rights/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAdmin(chatId)) {
        return sendAccessDenied(chatId);
    }
    
    const allGroups = [...new Set([...PROPERTY_GROUPS, ...NEWS_GROUPS, ...ALL_GROUPS])];
    
    if (allGroups.length === 0) {
        return bot.sendMessage(chatId, '❌ Группы не настроены в .env файле');
    }
    
    let resultMessage = '🔍 *Проверка прав бота в группах:*\n\n';
    
    for (const groupId of allGroups) {
        try {
            // Попробуем отправить тестовое сообщение
            await bot.sendMessage(groupId, '🧪 Проверка прав бота...');
            resultMessage += `✅ Группа ${groupId} - бот может отправлять сообщения\n`;
            
            // Удалим тестовое сообщение
            // await bot.deleteMessage(groupId, testMessage.message_id);
            
        } catch (error) {
            resultMessage += `❌ Группа ${groupId} - ошибка: ${error.message}\n`;
        }
        
        // Задержка между проверками
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    bot.sendMessage(chatId, resultMessage, { parse_mode: 'Markdown' });
});

async function executeDeleteAll(chatId) {
    try {
        const response = await makeStatamicRequest('DELETE', `${STATAMIC_API_URL}/delete/all`);
        bot.sendMessage(chatId, response.message);
    } catch (error) {
        console.error('Delete error:', error);
        bot.sendMessage(chatId, '❌ Ошибка при удалении записей.');
    }
}

async function executeDeleteDrafts(chatId) {
    try {
        const response = await makeStatamicRequest('DELETE', `${STATAMIC_API_URL}/delete/drafts`);
        bot.sendMessage(chatId, response.message);
    } catch (error) {
        console.error('Delete error:', error);
        bot.sendMessage(chatId, '❌ Ошибка при удалении черновиков.');
    }
}

async function executeDeleteOld(chatId) {
    try {
        const response = await makeStatamicRequest('DELETE', `${STATAMIC_API_URL}/delete/old`);
        bot.sendMessage(chatId, response.message);
    } catch (error) {
        console.error('Delete error:', error);
        bot.sendMessage(chatId, '❌ Ошибка при удалении старых записей.');
    }
}

async function executeDeleteById(chatId, id) {
    try {
        const response = await makeStatamicRequest('DELETE', `${STATAMIC_API_URL}/delete/${id}`);
        bot.sendMessage(chatId, response.message);
    } catch (error) {
        console.error('Delete error:', error);
        bot.sendMessage(chatId, '❌ Ошибка при удалении записи.');
    }
}

async function executeDeleteByTitle(chatId, title) {
    try {
        const response = await makeStatamicRequest('DELETE', `${STATAMIC_API_URL}/delete-by-title`, { title: title });
        bot.sendMessage(chatId, response.message);
    } catch (error) {
        console.error('Delete by title error:', error);
        if (error.response && error.response.status === 404) {
            bot.sendMessage(chatId, error.response.data.message || 'Записей с таким заголовком не найдено.');
        } else {
            bot.sendMessage(chatId, '❌ Ошибка при удалении записей.');
        }
    }
}

async function sendToGroups(groupIds, message) {
    if (!groupIds || groupIds.length === 0) {
        console.log('❌ Нет групп для отправки');
        return;
    }
    
    // Обрезаем сообщение если оно слишком длинное
    const truncatedMessage = truncateMessage(message);
    
    console.log(`📤 Отправка сообщения в ${groupIds.length} групп`);
    console.log(`📝 Длина сообщения: ${message.length} символов (обрезано до: ${truncatedMessage.length})`);
    
    for (const groupId of groupIds) {
        try {
            // Отправляем БЕЗ parse_mode
            await bot.sendMessage(groupId, truncatedMessage);
            console.log(`✅ Сообщение отправлено в группу ${groupId}`);
            
            // Небольшая задержка чтобы избежать лимитов Telegram
            await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
            console.error(`❌ Ошибка отправки в группу ${groupId}:`, error.message);
            
            // Если сообщение слишком длинное даже после обрезки, пытаемся разбить на части
            if (error.message.includes('message is too long')) {
                try {
                    console.log(`🔄 Пытаемся разбить сообщение на части для группы ${groupId}...`);
                    const messageParts = splitLongMessage(message);
                    
                    for (let i = 0; i < messageParts.length; i++) {
                        await bot.sendMessage(groupId, messageParts[i]);
                        console.log(`✅ Часть ${i + 1}/${messageParts.length} отправлена в группу ${groupId}`);
                        await new Promise(resolve => setTimeout(resolve, 300));
                    }
                } catch (splitError) {
                    console.error(`❌ Ошибка при отправке частей в группу ${groupId}:`, splitError.message);
                }
            }
        }
    }
}

async function sendPhotoToGroups(groupIds, imageUrl, caption) {
    if (!groupIds || groupIds.length === 0) {
        console.log('❌ Нет групп для отправки фото');
        return;
    }
    
    console.log(`📤 Отправка фото в ${groupIds.length} групп`);
    console.log(`🖼️ URL фото: ${imageUrl}`);
    
    for (const groupId of groupIds) {
        let success = false;
        
        // Метод 1: Прямая отправка через скачивание
        try {
            await downloadAndSendPhoto(groupId, imageUrl, caption);
            console.log(`✅ Фото отправлено в группу ${groupId} (метод 1)`);
            success = true;
        } catch (error1) {
            console.error(`❌ Метод 1 не сработал для группы ${groupId}:`, error1.message);
            
            // Метод 2: Отправка через FormData
            try {
                await sendPhotoWithFormData(groupId, imageUrl, caption);
                console.log(`✅ Фото отправлено в группу ${groupId} (метод 2)`);
                success = true;
            } catch (error2) {
                console.error(`❌ Метод 2 не сработал для группы ${groupId}:`, error2.message);
            }
        }
        
        // Если оба метода не сработали, отправляем текст
        if (!success) {
            try {
                console.log(`🔄 Отправляем текстовое сообщение в группу ${groupId}...`);
                await sendToGroups([groupId], caption);
            } catch (textError) {
                console.error(`❌ Ошибка отправки текста в группу ${groupId}:`, textError.message);
            }
        }
        
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}
async function downloadImageWithRetry(url, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const buffer = await downloadImageBuffer(url);
            return buffer;
        } catch (error) {
            console.warn(`Attempt ${attempt} failed for ${url}:`, error.message);
            if (attempt === maxRetries) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
    }
}
async function sendMultiplePhotos(groupIds, imageUrls, caption) {
    if (!groupIds || groupIds.length === 0 || !imageUrls || imageUrls.length === 0) {
        console.log('❌ Нет групп или фото для отправки');
        return;
    }

    console.log(`📤 Отправка ${imageUrls.length} фото в ${groupIds.length} групп`);

    for (const groupId of groupIds) {
        try {
            // Если фото 1-2 - отправляем как отдельные фото с подписью у первого
            if (imageUrls.length <= 2) {
                for (let i = 0; i < imageUrls.length; i++) {
                    await sendSinglePhotoToGroup(groupId, imageUrls[i], i === 0 ? caption : '');
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
            // Если фото 3-10 - отправляем медиагруппой
            else if (imageUrls.length <= 10) {
                await sendMediaGroupToGroups([groupId], imageUrls, caption);
            }
            // Если фото больше 10 - разбиваем на части
            else {
                console.log(`🔄 Слишком много фото (${imageUrls.length}), разбиваю на части...`);
                
                // Разбиваем на группы по 10 фото
                const chunks = [];
                for (let i = 0; i < imageUrls.length; i += 10) {
                    chunks.push(imageUrls.slice(i, i + 10));
                }
                
                // Отправляем первую группу с подписью
                if (chunks[0].length > 0) {
                    await sendMediaGroupToGroups([groupId], chunks[0], caption);
                }
                
                // Отправляем остальные группы без подписи
                for (let i = 1; i < chunks.length; i++) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    await sendMediaGroupToGroups([groupId], chunks[i], '');
                }
            }
            
            console.log(`✅ Все ${imageUrls.length} фото отправлены в группу ${groupId}`);
            
        } catch (error) {
            console.error(`❌ Ошибка отправки фото в группу ${groupId}:`, error.message);
            
            // Fallback: пытаемся отправить по одному
            try {
                console.log(`🔄 Пробую отправить фото по одному в группу ${groupId}...`);
                await sendAllPhotosSeparately(groupId, imageUrls, caption);
            } catch (fallbackError) {
                console.error(`❌ Fallback не сработал для группы ${groupId}:`, fallbackError.message);
                
                // Последняя попытка: отправляем только текст
                try {
                    await sendToGroups([groupId], caption);
                } catch (textError) {
                    console.error(`❌ Не удалось отправить даже текст:`, textError.message);
                }
            }
        }
        
        // Задержка между группами
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}
async function downloadImageBuffer(url) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? require('https') : require('http');
        
        const request = protocol.get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`HTTP ${response.statusCode}`));
                return;
            }

            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                const buffer = Buffer.concat(chunks);
                
                // Проверяем минимальный размер (не пустой файл)
                if (buffer.length < 100) {
                    reject(new Error('File too small or empty'));
                    return;
                }
                
                resolve(buffer);
            });
        });

        request.on('error', reject);
        request.setTimeout(15000, () => {
            request.destroy();
            reject(new Error('Download timeout'));
        });
    });
}
async function sendPhotosIndividually(groupId, imageUrls, caption) {
    if (!imageUrls || imageUrls.length === 0) return;
    
    // Первое фото с подписью
    if (imageUrls[0]) {
        await sendPhotoToGroups([groupId], imageUrls[0], caption);
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // Остальные фото без подписи
    for (let i = 1; i < imageUrls.length; i++) {
        try {
            await sendPhotoToGroups([groupId], imageUrls[i], '');
            await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
            console.error(`Failed to send photo ${i} to ${groupId}:`, error.message);
            // Продолжаем отправлять остальные фото
        }
    }
}
// Функция для отправки медиагруппы (несколько фото в одном сообщении)
async function sendMediaGroupToGroups(groupIds, imageUrls, caption) {
    if (!groupIds || groupIds.length === 0) return;
    
    for (const groupId of groupIds) {
        try {
            // Проверяем лимит Telegram
            if (imageUrls.length > 10) {
                console.log(`⚠️ Too many photos (${imageUrls.length}), splitting...`);
                await sendMultiplePhotos(groupId, imageUrls, caption);
                continue;
            }

            const mediaGroup = [];
            
            for (let i = 0; i < imageUrls.length; i++) {
                try {
                    const buffer = await downloadImageWithRetry(imageUrls[i]);
                    mediaGroup.push({
                        type: 'photo',
                        media: buffer,
                        caption: i === 0 ? caption?.substring(0, 1024) : undefined
                    });
                } catch (imgError) {
                    console.error(`Failed to download image ${i}:`, imgError);
                    // Пропускаем проблемное фото, но продолжаем
                }
            }

            if (mediaGroup.length > 0) {
                await bot.sendMediaGroup(groupId, mediaGroup);
                console.log(`✅ Media group sent to ${groupId} (${mediaGroup.length} photos)`);
            } else {
                // Если ни одно фото не загрузилось, отправляем текст
                await sendToGroups([groupId], caption || 'Фото объекта');
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
            
        } catch (error) {
            console.error(`❌ Error sending media group to ${groupId}:`, error.message);
            
            // Fallback: отправляем фото по одному
            try {
                console.log('🔄 Trying fallback: sending photos individually...');
                await sendPhotosIndividually(groupId, imageUrls, caption);
            } catch (fallbackError) {
                console.error(`❌ Fallback also failed for ${groupId}:`, fallbackError.message);
                await sendToGroups([groupId], caption || 'Не удалось отправить фото');
            }
        }
    }
}

// Функция для скачивания изображения в буфер
function downloadImageBuffer(url) {
    return new Promise((resolve, reject) => {
        console.log(`🔄 Скачивание изображения: ${url}`);
        
        const protocol = url.startsWith('https') ? https : http;
        
        const request = protocol.get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`HTTP ${response.statusCode}`));
                return;
            }

            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                const buffer = Buffer.concat(chunks);
                
                // Проверяем, что это действительно изображение
                if (buffer.length === 0) {
                    reject(new Error('Пустой файл'));
                    return;
                }
                
                resolve(buffer);
            });
        });

        request.on('error', (error) => {
            reject(error);
        });
        
        // Таймаут 15 секунд
        request.setTimeout(15000, () => {
            request.destroy();
            reject(new Error('Timeout при скачивании фото'));
        });
    });
}

// Функция для отправки всех фото по отдельности (fallback)
async function sendAllPhotosSeparately(groupId, imageUrls, caption) {
    if (!imageUrls || imageUrls.length === 0) {
        await sendToGroups([groupId], caption);
        return;
    }
    
    console.log(`📨 Отправка ${imageUrls.length} фото по отдельности в группу ${groupId}`);
    
    // Первое фото с подписью
    if (imageUrls[0]) {
        await sendSinglePhotoToGroup(groupId, imageUrls[0], caption);
    }
    
    // Остальные фото без подписи
    for (let i = 1; i < imageUrls.length; i++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        try {
            await sendSinglePhotoToGroup(groupId, imageUrls[i], '');
            console.log(`✅ Фото ${i + 1}/${imageUrls.length} отправлено`);
        } catch (error) {
            console.error(`❌ Ошибка отправки фото ${i + 1}:`, error.message);
        }
    }
}

async function executeAddProperty(chatId, propertyData) {
    try {
        console.log('🏠 Данные объекта для отправки в Statamic:', propertyData);
        console.log('📸 Images array:', propertyData.images);
        console.log('🖼️ Assets array:', propertyData.assets_array);
        
        // Формируем данные для API
        const apiData = {
            title: propertyData.title,
            type: propertyData.type,
            price: parseInt(propertyData.price) || 0,
            address: propertyData.address,
            district: propertyData.district,
            floor: parseInt(propertyData.floor) || 0,
            rooms: parseInt(propertyData.rooms) || 0,
            has_lift: Boolean(propertyData.has_lift),
            has_balcony: Boolean(propertyData.has_balcony),
            bathroom: parseInt(propertyData.bathroom) || 1,
            type_home: propertyData.type_home,
            nearbu: propertyData.nearbu,
            date_use: propertyData.date_use,
            apartment_area: parseInt(propertyData.apartment_area) || 0,
            description: propertyData.description,
            images: propertyData.images || [],
            assets_array: propertyData.assets_array || []
        };

        console.log('📤 Отправка данных на API:', {
            title: apiData.title,
            images_count: apiData.images.length,
            assets_count: apiData.assets_array.length,
            images_sample: apiData.images.slice(0, 2) // первые 2 URL для проверки
        });
        
        const response = await makeStatamicRequest('POST', STATAMIC_API_URL, apiData);
        
        // ДОБАВЬТЕ ЭТОТ ЛОГ
        console.log('📨 Ответ от Statamic:', {
            success: response.success,
            message: response.message,
            entry_id: response.entry_id || 'не указан'
        });
        
        if (response.success) {
            await bot.sendMessage(chatId, '✅ Объект недвижимости успешно добавлен!');
            
            // Отправка в группы Telegram
            const message = formatPropertyMessage(propertyData);
            const allGroups = [...new Set([...PROPERTY_GROUPS, ...ALL_GROUPS])];
            
     const allImages = [
    ...(propertyData.images || []),
    ...(propertyData.assets_array || [])
];

if (allImages.length > 0) {
    console.log(`🖼️ Отправка ${allImages.length} фото в группы`);
    await sendMultiplePhotos(allGroups, allImages, message);
} else {
    await sendToGroups(allGroups, message);
}
            
            console.log(`✅ Объект добавлен и отправлен в ${allGroups.length} групп`);
       } else {
            await bot.sendMessage(chatId, '❌ Произошла ошибка при добавлении объекта: ' + response.message);
        }
    } catch (error) {
        console.error('❌ Ошибка при добавлении объекта:', error);
        console.error('❌ Детали ошибки:', error.response?.data || error.message);
        await bot.sendMessage(chatId, '❌ Ошибка при добавлении объекта. Проверьте логи для подробностей.');
    }
}
async function makeStatamicRequest(method, url, data = null) {
    try {
        console.log('📡 Отправка запроса:', { method, url, data: data ? 'present' : 'null' });

        const config = {
            method: method,
            url: url,
            headers: {
                'Authorization': `Bearer ${API_TOKEN}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'TelegramBot/1.0'
            },
            timeout: 30000, // 30 секунд таймаут
            validateStatus: function (status) {
                return status >= 200 && status < 500; // Разрешаем статусы 200-499
            }
        };

        if (data && (method === 'POST' || method === 'PUT')) {
            config.data = data;
        }

        const response = await axios(config);
        
        console.log('✅ Ответ от сервера:', {
            status: response.status,
            data: response.data
        });

        return response.data;

    } catch (error) {
        console.error('❌ Критическая ошибка запроса:', {
            message: error.message,
            code: error.code,
            url: url
        });

        // Создаем структурированную ошибку
        const structuredError = new Error(error.message || 'Request failed');
        structuredError.status = error.response?.status;
        structuredError.data = error.response?.data;
        throw structuredError;
    }
}
// Функция для отправки всех фотографий в группы
async function sendAllPhotosToGroups(groupIds, imageUrls, caption) {
    if (!groupIds || groupIds.length === 0) {
        console.log('❌ Нет групп для отправки фото');
        return;
    }
    
    console.log(`📤 Отправка ${imageUrls.length} фото в ${groupIds.length} групп`);
    
    for (const groupId of groupIds) {
        try {
            // Отправляем первое фото с подписью
            if (imageUrls.length > 0) {
                await sendSinglePhotoToGroup(groupId, imageUrls[0], caption);
            }
            
            // Отправляем остальные фото без подписи
            for (let i = 1; i < imageUrls.length; i++) {
                await new Promise(resolve => setTimeout(resolve, 500)); // Задержка между отправками
                await sendSinglePhotoToGroup(groupId, imageUrls[i], '');
                console.log(`✅ Фото ${i + 1}/${imageUrls.length} отправлено в группу ${groupId}`);
            }
            
            console.log(`✅ Все ${imageUrls.length} фото отправлены в группу ${groupId}`);
            
        } catch (error) {
            console.error(`❌ Ошибка отправки фото в группу ${groupId}:`, error.message);
            
            // Если не удалось отправить фото, пробуем отправить текст
            try {
                console.log(`🔄 Попытка отправить текстовое сообщение в группу ${groupId}...`);
                await sendToGroups([groupId], caption);
            } catch (textError) {
                console.error(`❌ Ошибка отправки текста в группу ${groupId}:`, textError.message);
            }
        }
    }
}

// Функция для отправки одного фото в группу
async function sendSinglePhotoToGroup(groupId, imageUrl, caption) {
    try {
        // Пытаемся скачать и отправить фото
        await downloadAndSendPhoto(groupId, imageUrl, caption);
        return true;
    } catch (error) {
        console.error(`❌ Ошибка отправки фото в группу ${groupId}:`, error.message);
        
        // Если не удалось отправить фото, пробуем отправить как документ
        try {
            await sendPhotoAsDocument(groupId, imageUrl, caption);
            return true;
        } catch (docError) {
            console.error(`❌ Ошибка отправки фото как документа в группу ${groupId}:`, docError.message);
            throw error; // Пробрасываем ошибку дальше
        }
    }
}

// Обновленная функция для скачивания и отправки фото
async function downloadAndSendPhoto(groupId, imageUrl, caption) {
    try {
        const buffer = await downloadImageBuffer(imageUrl);
        await bot.sendPhoto(groupId, buffer, {
            caption: caption.substring(0, 1024)
        });
        console.log(`✅ Фото отправлено в группу ${groupId}`);
    } catch (error) {
        throw error;
    }
}

// Функция для отправки фото как документа (альтернативный метод)
async function sendPhotoAsDocument(groupId, imageUrl, caption) {
    return new Promise((resolve, reject) => {
        const protocol = imageUrl.startsWith('https') ? https : http;
        
        protocol.get(imageUrl, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`HTTP ${response.statusCode}`));
                return;
            }

            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', async () => {
                try {
                    const buffer = Buffer.concat(chunks);
                    
                    // Отправляем как документ
                    await bot.sendDocument(groupId, buffer, {
                        caption: caption.substring(0, 1024)
                    });
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
        }).on('error', (error) => {
            reject(error);
        });
    });
}

// Функция проверки URL изображения
function isValidImageUrl(url) {
    if (!url || typeof url !== 'string') return false;
    
    try {
        const parsedUrl = new URL(url);
        const pathname = parsedUrl.pathname.toLowerCase();
        
        // Проверяем расширения файлов
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
        return imageExtensions.some(ext => pathname.endsWith(ext));
    } catch (error) {
        return false;
    }
}

async function executeAddNews(chatId, newsData) {
    try {
        console.log('📰 Данные новости для отправки в Statamic:', newsData);
        
        const { collection, ...cleanNewsData } = newsData;
        
        const newsApiUrl = process.env.STATAMIC_NEWS_API_URL || STATAMIC_API_URL;
        
        console.log('📡 Отправка новости на:', newsApiUrl);
        
        const response = await makeStatamicRequest('POST', newsApiUrl, cleanNewsData);
        
        if (response.success) {
            await bot.sendMessage(chatId, '✅ Новость успешно добавлена!');
            
            const message = formatNewsMessage(newsData);
            const allGroups = [...new Set([...NEWS_GROUPS, ...ALL_GROUPS])];
            
            console.log('📤 Подготовка к отправке новости в группы:', {
                groupsCount: allGroups.length,
                hasLogo: newsData.logo_blog && newsData.logo_blog.length > 0,
                hasFileId: !!newsData.logo_blog_file_id
            });
            
            // Используем file_id для отправки в группы
            if (newsData.logo_blog_file_id) {
                await sendPhotoToGroups(allGroups, newsData.logo_blog_file_id, message);
            } else if (newsData.logo_blog && newsData.logo_blog.length > 0) {
                // Fallback: пытаемся использовать URL
                try {
                    await sendPhotoToGroups(allGroups, newsData.logo_blog[0], message);
                } catch (error) {
                    console.error('❌ Ошибка отправки по URL, отправляем текст:', error.message);
                    await sendToGroups(allGroups, message);
                }
            } else {
                await sendToGroups(allGroups, message);
            }
            
            logAction(chatId, null, `Новость добавлена и отправлена в ${allGroups.length} групп`);
        } else {
            await bot.sendMessage(chatId, '❌ Произошла ошибка при добавлении новости: ' + response.message);
        }
    } catch (error) {
        console.error('Error sending news to Statamic:', error);
        console.error('Error details:', error.response?.data || error.message);
        await bot.sendMessage(chatId, '❌ Ошибка при добавлении новости. Код ошибки: ' + (error.response?.status || 'неизвестен'));
    }
}
async function executeAddNews(chatId, newsData) {
    try {
        console.log('📰 Данные новости для отправки в Statamic:', newsData);
        
        const { collection, ...cleanNewsData } = newsData;
        
        const newsApiUrl = process.env.STATAMIC_NEWS_API_URL || STATAMIC_API_URL;
        
        console.log('📡 Отправка новости на:', newsApiUrl);
        
        const response = await makeStatamicRequest('POST', newsApiUrl, cleanNewsData);
        
        if (response.success) {
            await bot.sendMessage(chatId, '✅ Новость успешно добавлена!');
            
            const message = formatNewsMessage(newsData);
            const allGroups = [...new Set([...NEWS_GROUPS, ...ALL_GROUPS])];
            
            console.log('📤 Подготовка к отправке новости в группы:', {
                groupsCount: allGroups.length,
                hasLogo: newsData.logo_blog && newsData.logo_blog.length > 0
            });
            
            if (newsData.logo_blog && newsData.logo_blog.length > 0) {
                await sendPhotoToGroups(allGroups, newsData.logo_blog[0], message);
            } else {
                await sendToGroups(allGroups, message); // Убрали параметр { parse_mode: 'Markdown' }
            }
            
            logAction(chatId, null, `Новость добавлена и отправлена в ${allGroups.length} групп`);
        } else {
            await bot.sendMessage(chatId, '❌ Произошла ошибка при добавлении новости: ' + response.message);
        }
    } catch (error) {
        console.error('Error sending news to Statamic:', error);
        console.error('Error details:', error.response?.data || error.message);
        await bot.sendMessage(chatId, '❌ Ошибка при добавлении новости. Код ошибки: ' + (error.response?.status || 'неизвестен'));
    }
}
bot.onText(/\/test_groups/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAdmin(chatId)) {
        return sendAccessDenied(chatId);
    }
    
    try {
        const testMessage = `🧪 Тестовое сообщение 🧪\n\n` +
                           `Это тестовое сообщение для проверки работы бота в группах.\n\n` +
                           `✅ Бот работает корректно!\n` +
                           `🕒 Время: ${new Date().toLocaleString('ru-RU')}`;
        
        const allGroups = [...new Set([...PROPERTY_GROUPS, ...NEWS_GROUPS, ...ALL_GROUPS])];
        
        await sendToGroups(allGroups, testMessage); // Убрали { parse_mode: 'Markdown' }
        await bot.sendMessage(chatId, `✅ Тестовые сообщения отправлены в ${allGroups.length} групп`);
        
    } catch (error) {
        console.error('Test groups error:', error);
        await bot.sendMessage(chatId, '❌ Ошибка при отправке тестовых сообщений');
    }
});

// ==================== ОСНОВНЫЕ КОМАНДЫ ====================

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username;
    
    logAction(chatId, username, '/start');
    
    if (!isAdmin(chatId)) {
        return sendAccessDenied(chatId);
    }
    
    userStates.delete(chatId); // Очищаем состояние
    
    showMainMenu(chatId);
});

bot.onText(/\/myid/, (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username;
    
    logAction(chatId, username, '/myid');
    
    if (!isAdmin(chatId)) {
        return sendAccessDenied(chatId);
    }
    
    bot.sendMessage(chatId, `Ваш chat ID: ${chatId}\nВаш username: @${username || 'не установлен'}\n\nСтатус: ✅ Администратор`);
});

// ==================== ГЛАВНОЕ МЕНЮ ====================

function showMainMenu(chatId) {
    const options = {
        reply_markup: {
            keyboard: [
                [{ text: '➕ Добавить объект' }, { text: '📰 Добавить новость' }],
                [{ text: '📋 Список объектов' }, { text: '🗑️ Управление удалением' }],
                // [{ text: '👑 Информация' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    };
    
    bot.sendMessage(chatId, '👋 Добро пожаловать в панель администратора! Выберите действие:', options);
}
// bot.onText(/👑 Информация/, (msg) => {
//     const chatId = msg.chat.id;
    
//     if (!isAdmin(chatId)) {
//         return sendAccessDenied(chatId);
//     }
    
//     const infoMessage = `👑 *Информация о боте*\n\n` +
//                        `🤖 *Имя бота:* @${bot.options.username}\n` +
//                        `👤 *Ваш ID:* ${chatId}\n` +
//                        `🏠 *Группы объектов:* ${PROPERTY_GROUPS.length}\n` +
//                        `📰 *Группы новостей:* ${NEWS_GROUPS.length}\n` +
//                        `🌐 *Все группы:* ${ALL_GROUPS.length}\n\n` +
//                        `📊 *Статистика:*\n` +
//                        `• Пользователей в памяти: ${userStates.size}\n` +
//                        `• Ожидают подтверждения: ${pendingConfirmations.size}\n\n` +
//                        `🛠 *Команды:*\n` +
//                        `/test_groups - тест групп\n` +
//                        `/myid - ваш ID`;
    
//     bot.sendMessage(chatId, infoMessage, { parse_mode: 'Markdown' });
// });
// ==================== ФУНКЦИОНАЛ НОВОСТЕЙ ====================

// bot.onText(/📰 Добавить новость/, (msg) => {
//     const chatId = msg.chat.id;
//     const username = msg.from.username;
    
//     logAction(chatId, username, 'Начало добавления новости');
    
//     if (!isAdmin(chatId)) {
//         return sendAccessDenied(chatId);
//     }
    
//     // Очищаем предыдущее состояние и устанавливаем новое для новости
//     userStates.set(chatId, {
//         step: 'news_title',
//         data: {
//             collection: 'contact'
//         }
//     });
    
//     bot.sendMessage(chatId, '');
// });

// Функции для обработки шагов создания новости
async function handleNewsTitleStep(chatId, text, userState) {
    // Игнорируем команды и кнопки
    if (text.startsWith('/') || text.includes('Добавить') || text.includes('Удалить')) {
        bot.sendMessage(chatId, '📝 Пожалуйста, введите заголовок новости:');
        return;
    }
    
    userState.data.title = text;
    userState.step = 'news_logo';
    userStates.set(chatId, userState);
    
    bot.sendMessage(chatId, '🖼️ Теперь отправьте логотип/обложку для новости (одно фото) :');
}

async function handleNewsLogoStep(chatId, text, userState) {
    if (text === '/skip') {
        userState.step = 'news_text';
        userStates.set(chatId, userState);
        bot.sendMessage(chatId, '📝 Введите текст новости:');
    } else {
        bot.sendMessage(chatId, 'Пожалуйста, отправьте изображение или введите /skip чтобы пропустить');
    }
}

async function handleNewsTextStep(chatId, text, userState) {
    userState.data.blog_text = text;
    
    // Показываем предпросмотр и запрашиваем подтверждение
    const newsData = userState.data;
    let preview = `📰 ПРЕДПРОСМОТР НОВОСТИ:\n\n`;
    preview += `📝 Заголовок: ${newsData.title}\n`;
    preview += `📖 Текст: ${newsData.blog_text.substring(0, 100)}${newsData.blog_text.length > 100 ? '...' : ''}\n`;
    preview += `🖼️ Изображений: ${newsData.logo_blog ? newsData.logo_blog.length : 0}\n\n`;
    preview += `✅ Все правильно?`;
    
    askConfirmation(
        chatId, 
        'addNews', 
        { newsData: newsData }, 
        preview
    );
    
    // Очищаем состояние, так как дальше идет подтверждение
    userStates.delete(chatId);
}


// bot.onText(/📋 Список объектов/, async (msg) => {
//     const chatId = msg.chat.id;
//     const username = msg.from.username;
    
//     logAction(chatId, username, 'Просмотр списка объектов');
    
//     if (!isAdmin(chatId)) {
//         return sendAccessDenied(chatId);
//     }
    
//     try {
//         const response = await makeStatamicRequest('GET', `${STATAMIC_API_URL}/list`);
        
//         if (response.success && response.entries && response.entries.length > 0) {
//             // Разбиваем список на части если слишком длинный
//             let currentMessage = '📋 Список записей:\n\n';
//             const messages = [];
            
//             response.entries.forEach(entry => {
//                 const entryText = `🏠 ID: ${entry.id}\n` +
//                                 `📝 Заголовок: ${entry.title}\n` +
//                                 `💰 Цена: ${entry.price} €\n` +
//                                 (entry.date ? `📅 Дата: ${new Date(entry.date * 1000).toLocaleDateString()}\n` : '') +
//                                 `🔗 Удалить: /delete_${entry.id}\n\n`;
                
//                 // Если добавление новой записи превысит лимит, начинаем новое сообщение
//                 if (currentMessage.length + entryText.length > 4096) {
//                     messages.push(currentMessage);
//                     currentMessage = '📋 Продолжение списка:\n\n' + entryText;
//                 } else {
//                     currentMessage += entryText;
//                 }
//             });
            
//             // Добавляем последнее сообщение
//             if (currentMessage) {
//                 messages.push(currentMessage);
//             }
            
//             // Отправляем все части
//             for (let i = 0; i < messages.length; i++) {
//                 await bot.sendMessage(chatId, messages[i]);
//                 // Задержка между сообщениями
//                 if (i < messages.length - 1) {
//                     await new Promise(resolve => setTimeout(resolve, 500));
//                 }
//             }
//         } else {
//             bot.sendMessage(chatId, '📭 Записей не найдено.');
//         }
//     } catch (error) {
//         console.error('List error:', error);
//         bot.sendMessage(chatId, '❌ Ошибка при получении списка записей.');
//     }
// });

// bot.onText(/🗑️ Управление удалением/, (msg) => {
//     const chatId = msg.chat.id;
//     const username = msg.from.username;
    
//     logAction(chatId, username, 'Меню удаления');
    
//     if (!isAdmin(chatId)) {
//         return sendAccessDenied(chatId);
//     }
    
//     showDeleteMenu(chatId);
// });

function showDeleteMenu(chatId) {
    const options = {
        reply_markup: {
            keyboard: [
                [{ text: '🗑️ Удалить все' },{ text: '🔍 Удалить по заголовку' }],
                [{ text: '🕐 Удалить старые' },{ text: '↩️ Назад в меню' } ],
                
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    };
    
    bot.sendMessage(chatId, '🗑️ Выберите тип удаления:', options);
}

bot.onText(/🗑️ Удалить все/, (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username;
    
    logAction(chatId, username, 'Запрос удаления всех записей');
    
    if (!isAdmin(chatId)) {
        return sendAccessDenied(chatId);
    }
    
    askConfirmation(
        chatId, 
        'deleteAll', 
        {}, 
        '❓ Вы уверены, что хотите удалить ВСЕ записи?\n\nЭто действие нельзя отменить!\n\n✅ Да - подтвердить удаление\n❌ Нет - отменить'
    );
});

bot.onText(/📄 Удалить черновики/, (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username;
    
    logAction(chatId, username, 'Запрос удаления черновиков');
    
    if (!isAdmin(chatId)) {
        return sendAccessDenied(chatId);
    }
    
    askConfirmation(
        chatId, 
        'deleteDrafts', 
        {}, 
        
    );
});

bot.onText(/🕐 Удалить старые/, (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username;
    
    logAction(chatId, username, 'Запрос удаления старых записей');
    
    if (!isAdmin(chatId)) {
        return sendAccessDenied(chatId);
    }
    
    askConfirmation(
        chatId, 
        'deleteOld', 
        {}, 
        
    );
});

bot.onText(/🔍 Удалить по заголовку/, (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username;
    
    logAction(chatId, username, 'Запрос удаления по заголовку');
    
    if (!isAdmin(chatId)) {
        return sendAccessDenied(chatId);
    }
    
    userStates.set(chatId, { 
        step: '',
        action: 'deleteByTitle'
    });
    
    bot.sendMessage(chatId, '📝 Введите заголовок объекта для удаления:');
});

// bot.onText(/↩️ Назад в меню/, (msg) => {
//     const chatId = msg.chat.id;
//     showMainMenu(chatId);
// });


// ==================== ДОБАВЛЕНИЕ ОБЪЕКТОВ ====================

// bot.onText(/➕ Добавить объект/, (msg) => {
//     const chatId = msg.chat.id;
//     const username = msg.from.username;
    
//     logAction(chatId, username, 'Начало добавления объекта');
    
//     if (!isAdmin(chatId)) {
//         return sendAccessDenied(chatId);
//     }
    
//     userStates.set(chatId, {
//         step: 'type',
//         data: {
//             images: []
//         }
//     });
    
//     showTypeStep(chatId);
// });

// ==================== ОБРАБОТКА СООБЩЕНИЙ ====================
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username;
    const text = msg.text || '';
    
    // Пропускаем команды, начинающиеся с /
    if (text.startsWith('/')) {
        return;
    }
    
    // Пропускаем фото
    if (msg.photo) {
        return;
    }
    
    // Проверяем права доступа
    if (!isAdmin(chatId)) {
        logAction(chatId, username, `Попытка доступа: "${text}"`);
        return sendAccessDenied(chatId);
    }
    
    // Сначала проверяем подтверждения
    const handled = await handleConfirmation(chatId, text, username);
    if (handled) return;
    
    // Обработка ВСЕХ кнопок главного меню
    if (text === '➕ Добавить объект') {
        logAction(chatId, username, 'Начало добавления объекта');
        userStates.set(chatId, {
            step: 'type',
            data: {
                images: []
            }
        });
        showTypeStep(chatId);
        return;
    }
    
    if (text === '📰 Добавить новость') {
        logAction(chatId, username, 'Начало добавления новости');
        userStates.set(chatId, {
            step: 'news_title',
            data: {
                collection: 'contact'
            }
        });
        bot.sendMessage(chatId, '📝 Введите заголовок новости:');
        return;
    }
    
    if (text === '📋 Список объектов') {
        logAction(chatId, username, 'Просмотр списка объектов');
        
        try {
            const response = await makeStatamicRequest('GET', `${STATAMIC_API_URL}/list`);
            
            if (response.success && response.entries && response.entries.length > 0) {
                // Разбиваем список на части если слишком длинный
                let currentMessage = '📋 Список записей:\n\n';
                const messages = [];
                
                response.entries.forEach(entry => {
                    const entryText = `🏠 ID: ${entry.id}\n` +
                                    `📝 Заголовок: ${entry.title}\n` +
                                    `💰 Цена: ${entry.price} €\n` +
                                    (entry.date ? `📅 Дата: ${new Date(entry.date * 1000).toLocaleDateString()}\n` : '') +
                                    `🔗 Удалить: /delete_${entry.id}\n\n`;
                    
                    // Если добавление новой записи превысит лимит, начинаем новое сообщение
                    if (currentMessage.length + entryText.length > 4096) {
                        messages.push(currentMessage);
                        currentMessage = '📋 Продолжение списка:\n\n' + entryText;
                    } else {
                        currentMessage += entryText;
                    }
                });
                
                // Добавляем последнее сообщение
                if (currentMessage) {
                    messages.push(currentMessage);
                }
                
                // Отправляем все части
                for (let i = 0; i < messages.length; i++) {
                    await bot.sendMessage(chatId, messages[i]);
                    // Задержка между сообщениями
                    if (i < messages.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                }
            } else {
                bot.sendMessage(chatId, '📭 Записей не найдено.');
            }
        } catch (error) {
            console.error('List error:', error);
            bot.sendMessage(chatId, '❌ Ошибка при получении списка записей.');
        }
        return;
    }
    
    if (text === '🗑️ Управление удалением') {
        logAction(chatId, username, 'Меню удаления');
        showDeleteMenu(chatId);
        return;
    }
    
    if (text === '👑 Информация') {
        const infoMessage = `👑 *Информация о боте*\n\n` +
                           `🤖 *Имя бота:* @${bot.options.username}\n` +
                           `👤 *Ваш ID:* ${chatId}\n` +
                           `🏠 *Группы объектов:* ${PROPERTY_GROUPS.length}\n` +
                           `📰 *Группы новостей:* ${NEWS_GROUPS.length}\n` +
                           `🌐 *Все группы:* ${ALL_GROUPS.length}\n\n` +
                           `📊 *Статистика:*\n` +
                           `• Пользователей в памяти: ${userStates.size}\n` +
                           `• Ожидают подтверждения: ${pendingConfirmations.size}`;
        
        bot.sendMessage(chatId, infoMessage, { parse_mode: 'Markdown' });
        return;
    }
    
    // Обработка кнопок меню удаления
    if (text === '🗑️ Удалить все') {
        logAction(chatId, username, 'Запрос удаления всех записей');
        askConfirmation(
            chatId, 
            'deleteAll', 
            {}, 
            '❓ Вы уверены, что хотите удалить ВСЕ записи?\n\nЭто действие нельзя отменить!\n\n✅ Да - подтвердить удаление\n❌ Нет - отменить'
        );
        return;
    }
    
    if (text === '🔍 Удалить по заголовку') {
        logAction(chatId, username, 'Запрос удаления по заголовку');
        userStates.set(chatId, { 
            step: 'awaiting_title_for_deletion',
            action: 'deleteByTitle'
        });
        bot.sendMessage(chatId, '📝 Введите заголовок объекта для удаления:');
        return;
    }
    
    if (text === '🕐 Удалить старые') {
        logAction(chatId, username, 'Запрос удаления старых записей');
        askConfirmation(
            chatId, 
            'deleteOld', 
            {}, 
            '❓ Вы уверены, что хотите удалить старые записи?\n\n✅ Да - подтвердить удаление\n❌ Нет - отменить'
        );
        return;
    }
    
    if (text === '↩️ Назад в меню') {
        showMainMenu(chatId);
        return;
    }
    
    // Обработка удаления по заголовку
    const userState = userStates.get(chatId);
    if (userState && userState.step === 'awaiting_title_for_deletion') {
        logAction(chatId, username, `Удаление по заголовку: "${text}"`);
        await executeDeleteByTitle(chatId, text);
        userStates.delete(chatId);
        return;
    }
    
    // Если нет активного состояния, НЕ показываем главное меню автоматически
    // Показываем главное меню только для неизвестных сообщений
    if (!userState) {
        // Если это не одна из известных кнопок меню, показываем главное меню
        const knownButtons = [
            '➕ Добавить объект', '📰 Добавить новость', '📋 Список объектов',
            '🗑️ Управление удалением', '👑 Информация', '↩️ Назад в меню',
            '🗑️ Удалить все', '🔍 Удалить по заголовку', '🕐 Удалить старые'
        ];
        
        if (!knownButtons.includes(text)) {
            showMainMenu(chatId);
        }
        return;
    }
    
    // Обработка шагов создания новости
    if (userState.data.collection === 'contact') {
        switch (userState.step) {
            case 'news_title':
                await handleNewsTitleStep(chatId, text, userState);
                break;
            case 'news_logo':
                await handleNewsLogoStep(chatId, text, userState);
                break;
            case 'news_text':
                await handleNewsTextStep(chatId, text, userState);
                break;
            default:
                bot.sendMessage(chatId, 'Неизвестный шаг создания новости. Начните заново.');
                userStates.delete(chatId);
                showMainMenu(chatId);
        }
        return;
    }
    
    // Обработка шагов добавления объекта
    switch (userState.step) {
        case 'type':
            await handleTypeStep(chatId, text, userState);
            break;
        case 'title':
            await handleTitleStep(chatId, text, userState);
            break;
        case 'price':
            await handlePriceStep(chatId, text, userState);
            break;
        case 'address':
            await handleAddressStep(chatId, text, userState);
            break;
        case 'district':
            await handleDistrictStep(chatId, text, userState);
            break;
        case 'floor':
            await handleFloorStep(chatId, text, userState);
            break;
        case 'rooms':
            await handleRoomsStep(chatId, text, userState);
            break;
        case 'has_lift':
            await handleLiftStep(chatId, text, userState);
            break;
        case 'has_balcony':
            await handleBalconyStep(chatId, text, userState);
            break;
        case 'bathroom':
            await handleBathroomStep(chatId, text, userState);
            break;
        case 'type_home':
            await handleTypeHomeStep(chatId, text, userState);
            break;
        case 'nearbu':
            await handleNearbuStep(chatId, text, userState);
            break;
        case 'date_use':
            await handleDateUseStep(chatId, text, userState);
            break;
        case 'apartment_area':
            await handleApartmentAreaStep(chatId, text, userState);
            break;
        case 'description':
            await handleDescriptionStep(chatId, text, userState);
            break;
        default:
            userStates.set(chatId, { step: 'type', data: {} });
            showTypeStep(chatId);
    }
});
// ==================== ОБРАБОТКА ФОТОГРАФИЙ ====================
bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username;
    
    logAction(chatId, username, 'загрузка фото');
    
    if (!isAdmin(chatId)) {
        return sendAccessDenied(chatId);
    }
    
    const userState = userStates.get(chatId);
    
    if (!userState) {
        bot.sendMessage(chatId, 'Сначала начните процесс добавления объекта или новости');
        return;
    }
    
    try {
        const photoId = msg.photo[msg.photo.length - 1].file_id;
        const fileLink = await bot.getFileLink(photoId);
        
        console.log('📸 Получено фото:', {
            chatId,
            step: userState.step,
            collection: userState.data.collection,
            fileId: photoId,
            fileLink: fileLink
        });
        
        // Для новостей
        if (userState.data.collection === 'contact') {
            if (userState.step === 'news_logo') {
                userState.data.logo_blog = [fileLink];
                userState.data.logo_blog_file_id = photoId;
                userState.step = 'news_text';
                userStates.set(chatId, userState);
                
                bot.sendMessage(chatId, '✅ Логотип новости получен! Теперь введите текст новости:');
                return;
            }
        } 
        // Для объектов недвижимости
        else {
            if (!userState.data.collection) {
                userState.data.collection = 'properties';
            }
            
            if (userState.step === 'main_image') {
                userState.data.images = [fileLink];
                userState.data.images_file_id = photoId;
                userState.step = 'additional_images';
                userStates.set(chatId, userState);
                
                const countMain = userState.data.images.length;
                bot.sendMessage(chatId, `✅ Главное изображение получено! Всего основных фото: ${countMain}\n\nТеперь отправьте дополнительные изображения. Когда закончите, введите /done.`);
            } else if (userState.step === 'additional_images') {
                if (!userState.data.assets_array) {
                    userState.data.assets_array = [];
                }
                if (!userState.data.assets_array_file_ids) {
                    userState.data.assets_array_file_ids = [];
                }
                
                userState.data.assets_array.push(fileLink);
                userState.data.assets_array_file_ids.push(photoId);
                userStates.set(chatId, userState);
                
                const countMain = userState.data.images ? userState.data.images.length : 0;
                const countAdditional = userState.data.assets_array.length;
                const total = countMain + countAdditional;
                
                bot.sendMessage(chatId, 
                    `✅ Дополнительное изображение добавлено!\n\n` +
                    `📊 Статистика фото:\n` +
                    `• Основные: ${countMain}\n` +
                    `• Дополнительные: ${countAdditional}\n` +
                    `• Всего: ${total}\n\n` +
                    `Отправьте еще фото или введите /done для завершения.`
                );
            } else {
                bot.sendMessage(chatId, '❌ Сначала завершите текущий шаг добавления объекта.');
            }
        }
    } catch (error) {
        console.error('❌ Error downloading photo:', error);
        bot.sendMessage(chatId, '❌ Ошибка загрузки фото. Попробуйте еще раз.');
    }
});
// ==================== ОБРАБОТКА ЗАВЕРШЕНИЯ ДОБАВЛЕНИЯ ОБЪЕКТА ====================

bot.onText(/\/done/, async (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username;
    
    logAction(chatId, username, 'Завершение добавления объекта');
    
    if (!isAdmin(chatId)) {
        return sendAccessDenied(chatId);
    }
    
    const userState = userStates.get(chatId);
    
    if (!userState || userState.step !== 'additional_images') {
        bot.sendMessage(chatId, 'Нет активного процесса загрузки фото');
        return;
    }
    
    if (userState.data.images.length === 0) {
        bot.sendMessage(chatId, 'Главное изображение обязательно. Пожалуйста, отправьте главное изображение.');
        return;
    }
    
    // Запрашиваем подтверждение перед добавлением
    askConfirmation(
        chatId, 
        'addProperty', 
        { propertyData: userState.data }, 
        `❓ Вы уверены, что хотите добавить новый объект?\n\nЗаголовок: ${userState.data.title}\nЦена: ${userState.data.price} €\n\n✅ Да - подтвердить добавление\n❌ Нет - отменить`
    );
});

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================



// ==================== ФУНКЦИИ ДОБАВЛЕНИЯ ОБЪЕКТОВ ====================



function showTypeStep(chatId) {
    const options = {
        reply_markup: {
            keyboard: [[{ text: 'Аренда' }, { text: 'Покупка' }]],
            one_time_keyboard: true
        }
    };
    
    bot.sendMessage(chatId, 'Выберите тип сделки:', options);
}

async function handleTypeStep(chatId, text, userState) {
    const typeMap = {
        'аренда': 'rent',
        'покупка': 'buy'
    };
    
    const type = typeMap[text.toLowerCase()];
    if (!type) {
        bot.sendMessage(chatId, 'Пожалуйста, выберите "Аренда" или "Покупка"');
        return;
    }
    
    userState.data.type = type;
    userState.step = 'title';
    userStates.set(chatId, userState);
    
    bot.sendMessage(chatId, 'Введите заголовок объекта:');
}

async function handleTitleStep(chatId, text, userState) {
    userState.data.title = text;
    userState.step = 'price';
    userStates.set(chatId, userState);
    
    bot.sendMessage(chatId, 'Введите цену (только цифры):');
}

async function handlePriceStep(chatId, text, userState) {
    const price = parseInt(text);
    if (isNaN(price)) {
        bot.sendMessage(chatId, 'Пожалуйста, введите корректную цену (только цифры):');
        return;
    }
    
    userState.data.price = price;
    userState.step = 'address';
    userStates.set(chatId, userState);
    
    bot.sendMessage(chatId, 'Введите адрес объекта:');
}

async function handleAddressStep(chatId, text, userState) {
    userState.data.address = text;
    userState.step = 'district';
    userStates.set(chatId, userState);
    
    const options = {
        reply_markup: {
            keyboard: [
                [{ text: 'Mamaia' }, { text: 'Constanta' }],
                [{ text: 'Navodari' }, { text: 'Ovidiu' }],
                [{ text: 'Lumina' }]
            ],
            one_time_keyboard: true
        }
    };
    
    bot.sendMessage(chatId, 'Выберите район:', options);
}

async function handleDistrictStep(chatId, text, userState) {
    const districts = ['Mamaia', 'Constanta', 'Navodari', 'Ovidiu', 'Lumina'];
    if (!districts.includes(text)) {
        bot.sendMessage(chatId, 'Пожалуйста, выберите район из предложенных вариантов:');
        return;
    }
    
    userState.data.district = text;
    userState.step = 'floor';
    userStates.set(chatId, userState);
    
    bot.sendMessage(chatId, 'Введите этаж:');
}

async function handleFloorStep(chatId, text, userState) {
    const floor = parseInt(text);
    if (isNaN(floor)) {
        bot.sendMessage(chatId, 'Пожалуйста, введите корректный этаж (только цифры):');
        return;
    }
    
    userState.data.floor = floor;
    userState.step = 'rooms';
    userStates.set(chatId, userState);
    
    bot.sendMessage(chatId, 'Введите количество комнат:');
}

async function handleRoomsStep(chatId, text, userState) {
    const rooms = parseInt(text);
    if (isNaN(rooms)) {
        bot.sendMessage(chatId, 'Пожалуйста, введите корректное количество комнат (только цифры):');
        return;
    }
    
    userState.data.rooms = rooms;
    userState.step = 'has_lift';
    userStates.set(chatId, userState);
    
    const options = {
        reply_markup: {
            keyboard: [[{ text: 'Есть' }, { text: 'Нет' }]],
            one_time_keyboard: true
        }
    };
    
    bot.sendMessage(chatId, 'Есть ли лифт?', options);
}

async function handleLiftStep(chatId, text, userState) {
    const liftMap = {
        'есть': true,
        'нет': false
    };
    
    const hasLift = liftMap[text.toLowerCase()];
    if (hasLift === undefined) {
        bot.sendMessage(chatId, 'Пожалуйста, выберите "Есть" или "Нет"');
        return;
    }
    
    userState.data.has_lift = hasLift;
    userState.step = 'has_balcony';
    userStates.set(chatId, userState);
    
    const options = {
        reply_markup: {
            keyboard: [[{ text: 'Есть' }, { text: 'Нет' }]],
            one_time_keyboard: true
        }
    };
    
    bot.sendMessage(chatId, 'Есть ли балкон?', options);
}

async function handleBalconyStep(chatId, text, userState) {
    const balconyMap = {
        'есть': true,
        'нет': false
    };
    
    const hasBalcony = balconyMap[text.toLowerCase()];
    if (hasBalcony === undefined) {
        bot.sendMessage(chatId, 'Пожалуйста, выберите "Есть" или "Нет"');
        return;
    }
    
    userState.data.has_balcony = hasBalcony;
    userState.step = 'bathroom';
    userStates.set(chatId, userState);
    
    bot.sendMessage(chatId, 'Введите количество санузлов:');
}

async function handleBathroomStep(chatId, text, userState) {
    const bathroom = parseInt(text);
    if (isNaN(bathroom) || bathroom < 1) {
        bot.sendMessage(chatId, 'Пожалуйста, введите корректное количество санузлов (минимум 1):');
        return;
    }
    
    userState.data.bathroom = bathroom;
    userState.step = 'type_home';
    userStates.set(chatId, userState);
    
    const options = {
        reply_markup: {
            keyboard: [
                [{ text: 'Квартира' }, { text: 'Дом' }],
                [{ text: 'Вилла' }]
            ],
            one_time_keyboard: true
        }
    };
    
    bot.sendMessage(chatId, 'Выберите тип объекта:', options);
}

async function handleTypeHomeStep(chatId, text, userState) {
    const typeHomeMap = {
        'квартира': 'квартира',
        'дом': 'дом',
        'вилла': 'вилла'
    };
    
    const typeHome = typeHomeMap[text.toLowerCase()];
    if (!typeHome) {
        bot.sendMessage(chatId, 'Пожалуйста, выберите "Квартира", "Дом" или "Вилла"');
        return;
    }
    
    userState.data.type_home = typeHome;
    userState.step = 'nearbu';
    userStates.set(chatId, userState);
    
    bot.sendMessage(chatId, 'Введите что находится рядом:');
}

async function handleNearbuStep(chatId, text, userState) {
    userState.data.nearbu = text;
    userState.step = 'date_use';
    userStates.set(chatId, userState);
    
    bot.sendMessage(chatId, 'Введите дату сдачи:');
}

async function handleDateUseStep(chatId, text, userState) {
    userState.data.date_use = text;
    userState.step = 'apartment_area';
    userStates.set(chatId, userState);
    
    bot.sendMessage(chatId, 'Введите площадь квартиры:');
}

async function handleApartmentAreaStep(chatId, text, userState) {
    const area = parseInt(text);
    if (isNaN(area)) {
        bot.sendMessage(chatId, 'Пожалуйста, введите корректную площадь (только цифры):');
        return;
    }
    
    userState.data.apartment_area = area;
    userState.step = 'description';
    userStates.set(chatId, userState);
    
    bot.sendMessage(chatId, 'Введите описание:');
}

async function handleDescriptionStep(chatId, text, userState) {
    userState.data.description = text;
    userState.step = 'main_image';
    userStates.set(chatId, userState);
    
    bot.sendMessage(chatId, 'Отправьте главное изображение объекта (одно фото).');
}



function formatPropertyMessage(propertyData) {
    const typeMap = {
        'rent': 'Аренда',
        'buy': 'Продажа'
    };
    
    const typeHomeMap = {
        'квартира': 'Квартира',
        'дом': 'Дом',
        'вилла': 'Вилла'
    };
    
    let message = `🏠 НОВЫЙ ОБЪЕКТ НЕДВИЖИМОСТИ 🏠\n\n`;
    message += `📝 ${propertyData.title}\n\n`;
    message += `💰 Цена: ${propertyData.price} €\n`;
    message += `📌 Тип сделки: ${typeMap[propertyData.type] || propertyData.type}\n`;
    message += `🏡 Тип объекта: ${typeHomeMap[propertyData.type_home] || propertyData.type_home}\n`;
    message += `📍 Адрес: ${propertyData.address}\n`;
    message += `🏘️ Район: ${propertyData.district}\n`;
    message += `📏 Площадь: ${propertyData.apartment_area} м²\n`;
    message += `🛏️ Комнат: ${propertyData.rooms}\n`;
    message += `🏢 Этаж: ${propertyData.floor}\n`;
    message += `🚪 Санузлов: ${propertyData.bathroom}\n`;
    message += `🛗 Лифт: ${propertyData.has_lift ? '✅ Есть' : '❌ Нет'}\n`;
    message += `🌅 Балкон: ${propertyData.has_balcony ? '✅ Есть' : '❌ Нет'}\n`;

    
    if (propertyData.nearbu) {
        message += `📍 Рядом: ${propertyData.nearbu}\n`;
    }
    
    if (propertyData.date_use) {
        message += `📅 Дата сдачи: ${propertyData.date_use}\n`;
    }
    
    if (propertyData.description) {
        // Ограничиваем описание чтобы избежать слишком длинных сообщений
        const maxDescLength = 1000;
        const shortDesc = propertyData.description.length > maxDescLength 
            ? propertyData.description.substring(0, maxDescLength) + '...' 
            : propertyData.description;
        message += `\n📋 Описание: ${shortDesc}\n`;
    }
    
        message += `📩Контакты:\n`;
    message += `📱 Консультация с агентами : @Armonie_agentie_imobiliare \n`;
    message += `📞 +380682656442 - Сергей\n`;
    message += `🌐Наш сайт c квартирами 
                для аренды, покупки, юридической консультации - 
                жми на ссылку: 
                https://armonie-imobiliare.ro \n`;
    message += `НАШИ СОЦИАЛЬНЫЕ СЕТИ:\n`
    message += `✅Instagram:\n
                https://instagram.com/apartment_romania_mamaia\n`;
    message += `✅Facebook:\n
                https://www.facebook.com/housingromania\n`
    message += `✅Tik Tok:\n
                https://www.tiktok.com/@_armonie_imobiliare_?_t=8riSC0AuV30&_r=1\n`;
    message += `✅Youtube:\n
                https://www.youtube.com/@Armonie-Romania\n`;
    message += `НАШИ КАНАЛЫ:\n`
    message += `✅Продажа: https://t.me/harmony_invest\n`;
    message += `✅Юридическая консультация:\n`
    message += `Гражданство ЕС: https://t.me/armonie_consulting\n`;
    message += `Продление паспорта, (резерв +): https://t.me/armonie_consulting\n`;
    message += `Открытие фирмы в ЕС, ВНЖ, покупка земли в ЕС: https://t.me/armonie_consulting\n`;
    
    return message;
}

function formatNewsMessage(newsData) {
    let message = `📰 НОВАЯ НОВОСТЬ 📰\n\n`;
    message += `📝 ${newsData.title}\n\n`;
    
    // Ограничиваем текст новости чтобы избежать слишком длинных сообщений
    const maxTextLength = 2000;
    const shortText = newsData.blog_text.length > maxTextLength 
        ? newsData.blog_text.substring(0, maxTextLength) + '...' 
        : newsData.blog_text;
    
    message += `📖 ${shortText}\n\n`;
        message += `📩Контакты:\n`;
    message += `📱 Консультация с агентами : @Armonie_agentie_imobiliare \n`;
    message += `📞 +380682656442 - Сергей\n`;
    message += `🌐Наш сайт c квартирами 
                для аренды, покупки, юридической консультации - 
                жми на ссылку: 
                https://armonie-imobiliare.ro \n`;
    message += `НАШИ СОЦИАЛЬНЫЕ СЕТИ:\n`
    message += `✅Instagram:\n
                https://instagram.com/apartment_romania_mamaia\n`;
    message += `✅Facebook:\n
                https://www.facebook.com/housingromania\n`
    message += `✅Tik Tok:\n
                https://www.tiktok.com/@_armonie_imobiliare_?_t=8riSC0AuV30&_r=1\n`;
    message += `✅Youtube:\n
                https://www.youtube.com/@Armonie-Romania\n`;
    message += `НАШИ КАНАЛЫ:\n`
    message += `✅Продажа: https://t.me/harmony_invest\n`;
    message += `✅Юридическая консультация:\n`
    message += `Гражданство ЕС: https://t.me/armonie_consulting\n`;
    message += `Продление паспорта, (резерв +): https://t.me/armonie_consulting\n`;
    message += `Открытие фирмы в ЕС, ВНЖ, покупка земли в ЕС: https://t.me/armonie_consulting\n`;
    
    
    return message;
}


bot.onText(/\/test_format/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAdmin(chatId)) {
        return sendAccessDenied(chatId);
    }
    
    // Тестовые данные с потенциально проблемными символами
    const testData = {
        title: 'Квартира с _подчеркиванием_ и *звездочками* [в скобках]',
        price: '100_000',
        type: 'rent',
        type_home: 'квартира',
        address: 'ул. Тестовая (дом 123)',
        district: 'Constanta',
        apartment_area: '75',
        rooms: '3',
        floor: '5',
        bathroom: '2',
        has_lift: true,
        has_balcony: true,
        nearbu: 'Магазин ~супермаркет~',
        date_use: '2024-01-01',
        description: 'Описание с `обратными` кавычками и #хештегами + плюсами - минусами = равно | вертикальной чертой {фигурными} скобками.'
    };
    
    try {
        const formattedMessage = formatPropertyMessage(testData);
        
        // Сначала отправим в личку для проверки
        await bot.sendMessage(chatId, '🧪 *Тест форматирования:*', { parse_mode: 'Markdown' });
        await bot.sendMessage(chatId, formattedMessage, { parse_mode: 'Markdown' });
        
        // Затем попробуем отправить в группы
        const allGroups = [...new Set([...PROPERTY_GROUPS, ...ALL_GROUPS])];
        await sendToGroups(allGroups, formattedMessage);
        
        await bot.sendMessage(chatId, `✅ Тест форматирования завершен. Сообщение отправлено в ${allGroups.length} групп`);
        
    } catch (error) {
        console.error('Test format error:', error);
        await bot.sendMessage(chatId, `❌ Ошибка теста форматирования: ${error.message}`);
    }
});

const https = require('https');
const http = require('http');

// Функция для скачивания и отправки фото
async function downloadAndSendPhoto(groupId, imageUrl, caption) {
    return new Promise((resolve, reject) => {
        console.log(`🔄 Скачивание фото: ${imageUrl}`);
        
        const protocol = imageUrl.startsWith('https') ? https : http;
        
        const request = protocol.get(imageUrl, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`HTTP ${response.statusCode}`));
                return;
            }

            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', async () => {
                try {
                    const buffer = Buffer.concat(chunks);
                    
                    // Проверяем, что это действительно изображение
                    if (buffer.length === 0) {
                        reject(new Error('Пустой файл'));
                        return;
                    }
                    
                    // Отправляем как фото
                    await bot.sendPhoto(groupId, buffer, {
                        caption: caption.substring(0, 1024)
                    });
                    console.log(`✅ Фото отправлено в группу ${groupId}`);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
        });

        request.on('error', (error) => {
            reject(error);
        });
        
        // Таймаут 10 секунд
        request.setTimeout(10000, () => {
            request.destroy();
            reject(new Error('Timeout при скачивании фото'));
        });
    });
}
// Обновленная функция отправки фото
async function sendPhotoToGroups(groupIds, imageUrl, caption) {
    if (!groupIds || groupIds.length === 0) {
        console.log('❌ Нет групп для отправки фото');
        return;
    }
    
    console.log(`📤 Отправка фото в ${groupIds.length} групп`);
    console.log(`🖼️ URL фото: ${imageUrl}`);
    
    for (const groupId of groupIds) {
        try {
            // Пытаемся скачать и отправить фото
            await downloadAndSendPhoto(groupId, imageUrl, caption);
            console.log(`✅ Фото отправлено в группу ${groupId}`);
            
            await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
            console.error(`❌ Ошибка отправки фото в группу ${groupId}:`, error.message);
            
            // Если не удалось отправить фото, пробуем отправить текст
            try {
                console.log(`🔄 Попытка отправить текстовое сообщение в группу ${groupId}...`);
                await sendToGroups([groupId], caption);
            } catch (textError) {
                console.error(`❌ Ошибка отправки текста в группу ${groupId}:`, textError.message);
            }
        }
    }
}

const FormData = require('form-data');

// Альтернативный метод с использованием form-data
async function sendPhotoWithFormData(groupId, imageUrl, caption) {
    return new Promise((resolve, reject) => {
        const protocol = imageUrl.startsWith('https') ? https : http;
        
        protocol.get(imageUrl, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`HTTP ${response.statusCode}`));
                return;
            }

            const form = new FormData();
            form.append('chat_id', groupId);
            form.append('caption', caption.substring(0, 1024));
            form.append('photo', response, {
                filename: 'property.jpg',
                contentType: 'image/jpeg'
            });

            const request = https.request({
                hostname: 'api.telegram.org',
                port: 443,
                path: `/bot${TELEGRAM_TOKEN}/sendPhoto`,
                method: 'POST',
                headers: form.getHeaders()
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const result = JSON.parse(data);
                        if (result.ok) {
                            resolve();
                        } else {
                            reject(new Error(result.description));
                        }
                    } catch (error) {
                        reject(error);
                    }
                });
            });

            request.on('error', reject);
            form.pipe(request);
        }).on('error', reject);
    });
}

async function checkImageAvailability(url) {
    return new Promise((resolve) => {
        const protocol = url.startsWith('https') ? https : http;
        
        const request = protocol.get(url, (response) => {
            resolve({
                available: response.statusCode === 200,
                statusCode: response.statusCode,
                contentType: response.headers['content-type']
            });
        });
        
        request.on('error', () => {
            resolve({ available: false, error: 'Request failed' });
        });
        
        request.setTimeout(5000, () => {
            request.destroy();
            resolve({ available: false, error: 'Timeout' });
        });
    });
}

// Команда для проверки изображений
bot.onText(/\/check_images/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAdmin(chatId)) {
        return sendAccessDenied(chatId);
    }
    
    // Проверим последние добавленные изображения
    const userState = userStates.get(chatId);
    if (userState && userState.data && userState.data.images) {
        for (const imageUrl of userState.data.images) {
            const result = await checkImageAvailability(imageUrl);
            await bot.sendMessage(chatId, 
                `🔍 Проверка изображения:\n` +
                `URL: ${imageUrl}\n` +
                `Доступно: ${result.available ? '✅' : '❌'}\n` +
                `Статус: ${result.statusCode}\n` +
                `Тип: ${result.contentType || 'неизвестен'}`
            );
        }
    } else {
        await bot.sendMessage(chatId, '❌ Нет данных об изображениях для проверки');
    }
});

// Функция для обрезки длинных сообщений
function truncateMessage(message, maxLength = 4096) {
    if (message.length <= maxLength) {
        return message;
    }
    
    // Обрезаем сообщение и добавляем индикатор
    return message.substring(0, maxLength - 3) + '...';
}

// Функция для разделения очень длинных сообщений на части
function splitLongMessage(message, maxLength = 4096) {
    if (message.length <= maxLength) {
        return [message];
    }
    
    const parts = [];
    let currentPart = '';
    const lines = message.split('\n');
    
    for (const line of lines) {
        if ((currentPart + line + '\n').length <= maxLength) {
            currentPart += line + '\n';
        } else {
            if (currentPart) {
                parts.push(currentPart.trim());
            }
            currentPart = line + '\n';
            
            // Если одна строка слишком длинная, разбиваем её
            if (currentPart.length > maxLength) {
                while (currentPart.length > maxLength) {
                    parts.push(currentPart.substring(0, maxLength));
                    currentPart = currentPart.substring(maxLength);
                }
            }
        }
    }
    
    if (currentPart) {
        parts.push(currentPart.trim());
    }
    
    return parts;
}

// ✅ РАБОТАЮЩИЕ КОМАНДЫ ДЛЯ ДИАГНОСТИКИ

// Проверка подключения к API
bot.onText(/\/test_api/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAdmin(chatId)) {
        return sendAccessDenied(chatId);
    }
    
    try {
        console.log(`🧪 Запуск test_api для chatId: ${chatId}`);
        
        const apiUrl = 'https://armonie.onrender.com/api/debug-config';
        const response = await makeStatamicRequest('GET', apiUrl);
        
        const message = `✅ API подключено успешно!\n\n` +
                       `Supabase URL: ${response.supabase_url}\n` +
                       `Service Key: ${response.supabase_service_key}\n` +
                       `App Env: ${response.app_env}\n` +
                       `App Debug: ${response.app_debug}`;
        
        console.log(`📨 Отправка ответа: ${message}`);
        await bot.sendMessage(chatId, message);
        
    } catch (error) {
        console.error(`❌ Ошибка в test_api:`, error);
        
        const errorMessage = `❌ Ошибка подключения к API:\n\n` +
                            `Ошибка: ${error.message}\n` +
                            `Статус: ${error.status || 'unknown'}\n` +
                            `URL: https://armonie.onrender.com/api/debug-config`;
        
        await bot.sendMessage(chatId, errorMessage);
    }
});

// Проверка Supabase
bot.onText(/\/test_supabase/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAdmin(chatId)) {
        return sendAccessDenied(chatId);
    }
    
    try {
        console.log(`🧪 Запуск test_supabase для chatId: ${chatId}`);
        
        const apiUrl = 'https://armonie.onrender.com/api/supabase-test';
        const response = await makeStatamicRequest('GET', apiUrl);
        
        const message = `✅ Supabase подключен!\n\n` +
                       `Статус: ${response.status}\n` +
                       `Подключение: ${response.supabase_connected ? '✅' : '❌'}\n` +
                       `Бакет: ${response.bucket_exists ? '✅' : '❌'}\n` +
                       `Файлов: ${response.files_count}`;
        
        console.log(`📨 Отправка ответа: ${message}`);
        await bot.sendMessage(chatId, message);
        
    } catch (error) {
        console.error(`❌ Ошибка в test_supabase:`, error);
        
        const errorMessage = `❌ Ошибка подключения к Supabase:\n\n` +
                            `Ошибка: ${error.message}\n` +
                            `Статус: ${error.status || 'unknown'}\n` +
                            `URL: https://armonie.onrender.com/api/supabase-test`;
        
        await bot.sendMessage(chatId, errorMessage);
    }
});

// Проверка загрузки изображений
bot.onText(/\/test_upload/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAdmin(chatId)) {
        return sendAccessDenied(chatId);
    }
    
    try {
        console.log(`🧪 Запуск test_upload для chatId: ${chatId}`);
        
        // Используем разные тестовые URL
        const testImageUrls = [
            'https://picsum.photos/600/400', // Альтернативный сервис
            'https://armonie.onrender.com/api/test-image' // Наш собственный endpoint
        ];
        
        const apiUrl = 'https://armonie.onrender.com/api/test-upload';
        
        // Пробуем первый URL
        let response;
        let usedUrl = testImageUrls[0];
        
        try {
            response = await makeStatamicRequest('POST', apiUrl, {
                image_url: testImageUrls[0]
            });
        } catch (firstError) {
            console.log('🔄 Первый URL не сработал, пробуем второй...');
            usedUrl = testImageUrls[1];
            response = await makeStatamicRequest('POST', apiUrl, {
                image_url: testImageUrls[1]
            });
        }
        
        if (response.success) {
            const message = `✅ Тест загрузки успешен!\n\n` +
                           `URL: ${response.url}\n` +
                           `File: ${response.file_name}\n` +
                           `Source: ${usedUrl}`;
            
            console.log(`📨 Отправка ответа: ${message}`);
            await bot.sendMessage(chatId, message);
        } else {
            const message = `❌ Ошибка загрузки: ${response.message}`;
            console.log(`📨 Отправка ответа: ${message}`);
            await bot.sendMessage(chatId, message);
        }
        
    } catch (error) {
        console.error(`❌ Ошибка в test_upload:`, error);
        
        const errorMessage = `❌ Ошибка теста загрузки:\n\n` +
                            `Ошибка: ${error.message}\n` +
                            `Статус: ${error.status || 'unknown'}\n` +
                            `Детали: ${error.data?.message || 'Нет дополнительной информации'}`;
        
        await bot.sendMessage(chatId, errorMessage);
    }
});
bot.onText(/\/test_main_endpoint/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAdmin(chatId)) {
        return sendAccessDenied(chatId);
    }
    
    try {
        const apiUrl = 'https://armonie.onrender.com/api/telegram-property';
        
        // Простой GET запрос для проверки доступности
        const response = await makeStatamicRequest('GET', apiUrl);
        
        await bot.sendMessage(chatId, 
            `✅ Основной endpoint доступен!\n\n` +
            `Статус: ${response.status || 'unknown'}\n` +
            `Сообщение: ${response.message || 'Endpoint работает'}`
        );
        
    } catch (error) {
        // GET может не поддерживаться, проверяем по статусу ошибки
        if (error.response?.status === 405) {
            // Method Not Allowed - это нормально, значит endpoint существует
            await bot.sendMessage(chatId, 
                `✅ Основной endpoint доступен! (возвращает 405 - метод не разрешен, что ожидаемо для POST endpoint'а)`
            );
        } else {
            await bot.sendMessage(chatId, 
                `❌ Ошибка основного endpoint'а:\n\n` +
                `Ошибка: ${error.message}\n` +
                `Статус: ${error.response?.status}\n` +
                `URL: https://armonie.onrender.com/api/telegram-property`
            );
        }
    }
});

bot.onText(/\/ping/, async (msg) => {
    const chatId = msg.chat.id;
    const startTime = Date.now();
    
    try {
        await bot.sendMessage(chatId, '🏓 Pong! Бот работает...');
        const endTime = Date.now();
        await bot.sendMessage(chatId, `⏱ Время ответа: ${endTime - startTime}ms`);
    } catch (error) {
        console.error('❌ Ошибка в ping команде:', error);
    }
});
bot.onText(/\/bot_status/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAdmin(chatId)) {
        return sendAccessDenied(chatId);
    }
    
    try {
        const statusMessage = `🤖 Статус бота:\n\n` +
                            `👑 Админы: ${ADMIN_CHAT_IDS.join(', ')}\n` +
                            `🏠 Группы объектов: ${PROPERTY_GROUPS.length}\n` +
                            `📰 Группы новостей: ${NEWS_GROUPS.length}\n` +
                            `🌐 Все группы: ${ALL_GROUPS.length}\n` +
                            `💾 Состояния пользователей: ${userStates.size}\n` +
                            `⏳ Ожидают подтверждения: ${pendingConfirmations.size}\n` +
                            `🔄 Polling: активен\n` +
                            `📡 API Token: ${API_TOKEN ? '✅' : '❌'}\n` +
                            `🤵 Bot Token: ${TELEGRAM_TOKEN ? '✅' : '❌'}`;
        
        await bot.sendMessage(chatId, statusMessage);
    } catch (error) {
        console.error('❌ Ошибка в bot_status:', error);
        await bot.sendMessage(chatId, `❌ Ошибка получения статуса: ${error.message}`);
    }
});
// ==================== ЗАПУСК СЕРВЕРА ====================

app.use(express.json());
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`👑 Администраторы: ${ADMIN_CHAT_IDS.join(', ')}`);
    console.log('✅ Бот готов к работе с системой подтверждений');
    console.log('API Token:', API_TOKEN ? '✅ Установлен' : '❌ Отсутствует');
});

process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled promise rejection:', error);
});

bot.onText(/\/test_photo_download/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAdmin(chatId)) {
        return sendAccessDenied(chatId);
    }
    
    try {
        // Тестовые URL с разными типами изображений
        const testUrls = [
            
            'https://picsum.photos/600/400',
            'https://httpbin.org/image/jpeg'
        ];
        
        const testCaption = '🧪 Тест отправки фото через скачивание\n\nПроверка разных методов отправки';
        
        const allGroups = [...new Set([...PROPERTY_GROUPS, ...ALL_GROUPS])];
        
        for (let i = 0; i < testUrls.length; i++) {
            const testUrl = testUrls[i];
            await bot.sendMessage(chatId, `🔄 Тестирование URL ${i + 1}: ${testUrl}`);
            
            try {
                await sendPhotoToGroups(allGroups, testUrl, `${testCaption}\n\nТест ${i + 1}`);
                await bot.sendMessage(chatId, `✅ Тест ${i + 1} завершен успешно`);
            } catch (error) {
                await bot.sendMessage(chatId, `❌ Тест ${i + 1} не удался: ${error.message}`);
            }
            
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
    } catch (error) {
        console.error('Test photo download error:', error);
        await bot.sendMessage(chatId, '❌ Ошибка при тестировании отправки фото');
    }
});