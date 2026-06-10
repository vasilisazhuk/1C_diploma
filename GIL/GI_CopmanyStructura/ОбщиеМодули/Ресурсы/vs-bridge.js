window.VSUIBridge = (function () {
    // 📦 Очередь исходящих событий/запросов от приложения к Элементу
    const outboundQueue = [];
    
    // 🗃 Хранилище активных промисов: id → { resolve, reject }
    const pendingRequests = {};
    
    // ⏱ Таймаут ожидания ответа от Элемента (мс)
    const DEFAULT_TIMEOUT = 30000;

    /**
     * Генерирует уникальный ID запроса
     * @returns {string}
     */
    function generateId() { 
        return 'req_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9); 
    }

    /**
     * МЕТОД ДЛЯ ПРИЛОЖЕНИЯ (VS / Vibe-coding API)
     * Отправляет запрос к бекенду через Элемент.
     * @param {string} action - Действие (например, 'get_user', 'save_data')
     * @param {object|string} payload - Данные запроса (объект или JSON-строка)
     * @returns {Promise} - Промис с результатом от бекенда
     */
    function request(action, payload = {}) {
        return new Promise((resolve, reject) => {
            const id = generateId();
            
            // Сохраняем колбэки промиса по ID
            pendingRequests[id] = { resolve, reject };
            
            // ⏰ Страховка: если Элемент не ответит — реджектим
            setTimeout(() => {
                if (pendingRequests[id]) {
                    delete pendingRequests[id];
                    reject(new Error(`VSUIBridge Timeout: ${action}`));
                }
            }, DEFAULT_TIMEOUT);

            // 🔁 Нормализуем payload: если объект → строка, если строка → оставляем
            const pStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
            
            // Кладем запрос в очередь на выгрузку
            outboundQueue.push({ id, action, payload: pStr });
        });
    }

    /**
     * МЕТОД ДЛЯ ЭЛЕМЕНТА (1С)
     * Забирает накопленные запросы из очереди.
     * @returns {string|null} JSON-строка с массивом запросов или null, если очередь пуста
     */
    function getUpdates() {
        if (outboundQueue.length === 0) return null;
        
        // Вынимаем всё сразу и очищаем очередь
        const batch = outboundQueue.splice(0, outboundQueue.length);
        
        // 📤 Логируем сырые данные для отладки (можно убрать в продакшене)
        console.log('📤 RAW JSON для 1C:', JSON.stringify(batch));
        
        // Возвращаем строку — так удобнее парсить на стороне 1С
        return JSON.stringify(batch);
    }

    /**
     * Внутренний обработчик одного ответа
     * @param {string} id - ID запроса
     * @param {*} data - Данные ответа
     * @param {string} [error] - Текст ошибки (если есть)
     */
    function _resolveSingle(id, data, error) {
        const requestRecord = pendingRequests[id];
        if (!requestRecord) {
            console.warn(`Bridge: unknown ID: ${id}`);
            return; // Запрос уже истёк или не существовал
        }
        delete pendingRequests[id];

        // 🔁 Если данные пришли строкой — пробуем распарсить в объект
        let result = data;
        if (typeof data === 'string') {
            try { result = JSON.parse(data); } catch { result = data; }
        }

        // Резолвим или реджектим исходный промис
        if (error) {
            requestRecord.reject(new Error(error));
        } else {
            requestRecord.resolve(result);
        }
    }

    /**
     * 🔥 ПУБЛИЧНЫЙ МЕТОД ДЛЯ ЭЛЕМЕНТА (1С)
     * Передаёт ответы от бекенда обратно в приложение.
     * Гибкий вход: поддерживает строку-массив, массив объектов или одиночный ответ.
     * 
     * Варианты вызова:
     * 1. _resolve('[{"id":"req_1","data":{}}]') — строка с массивом ответов
     * 2. _resolve([{id:"req_1", {}}]) — нативный массив
     * 3. _resolve("req_1", {result}, null) — одиночный ответ (id, data, error)
     * 
     * Поддерживаемые поля в ответе: id/Идентификатор, data/dataJson/Данные/Результат, error/Ошибка
     */
    function _resolve(arg1, arg2, arg3) {
        // 📦 Вариант 1: пришла строка, начинающаяся с '[' — парсим как массив ответов
        if (typeof arg1 === 'string' && arg1.trim().startsWith('[')) {
            try {
                const parsed = JSON.parse(arg1);
                if (Array.isArray(parsed)) {
                    parsed.forEach(resp => {
                        const id = resp.id || resp.Идентификатор;
                        const data = resp.dataJson || resp.data || resp.Данные || resp.Результат;
                        const error = resp.error || resp.Ошибка;
                        _resolveSingle(id, data, error);
                    });
                    return;
                }
            } catch (e) {
                console.warn('Bridge: failed to parse responses string', e);
            }
        }
        
        // 📦 Вариант 2: нативный массив (для отладки или прямого вызова из 1С)
        if (Array.isArray(arg1)) {
            arg1.forEach(resp => {
                const id = resp.id || resp.Идентификатор;
                const data = resp.dataJson || resp.data || resp.Данные || resp.Результат;
                const error = resp.error || resp.Ошибка;
                _resolveSingle(id, data, error);
            });
            return;
        }
        
        // ✨ Вариант 3: одиночный ответ — передаём в базовый обработчик
        _resolveSingle(arg1, arg2, arg3);
    }

    /**
     * МЕТОД ДЛЯ ПРИЛОЖЕНИЯ
     * Отправляет событие без ожидания ответа (fire-and-forget).
     * Подходит для логов, аналитики, телеметрии.
     * @param {string} eventName - Имя события
     * @param {object|string} payload - Данные (объект или JSON-строка)
     */
    function sendEvent(eventName, payload = {}) {
        const pStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
        outboundQueue.push({ id: null, action: 'event_' + eventName, payload: pStr});
    }

    // 🎯 Публичный API: что доступно приложению
    // ⚠️ Используем явное сопоставление ключ:значение для методов с префиксом _
    return { 
        request,                    // Запрос с ожиданием ответа
        sendEvent,                  // Событие без ответа
        _getUpdates: getUpdates,    // Только для Элемента: выгрузка очереди (исправлено!)
        _resolve                    // Только для Элемента: доставка ответов
    };
})();