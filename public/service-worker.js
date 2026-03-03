const CACHE_NAME = 'plapser-v1';
const STATIC_CACHE = 'plapser-static-v1';
const API_CACHE = 'plapser-api-v1';
const CACHE_TTL = 15 * 60 * 60 * 1000; // 15 часов в миллисекундах
const DB_NAME = 'plapser-cache-metadata';
const DB_VERSION = 1;

// Файлы для кэширования при установке
const STATIC_FILES = [
  '/gui',
  '/searchStudent',
  '/searchTeacher',
  '/searchAuditory',
  '/stylesheet.css',
  '/gen.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// Инициализация IndexedDB
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('cacheMetadata')) {
        db.createObjectStore('cacheMetadata', { keyPath: 'url' });
      }
    };
  });
}

// Сохранение метаданных кэша
async function saveCacheMetadata(url, timestamp) {
  try {
    const db = await openDB();
    const tx = db.transaction('cacheMetadata', 'readwrite');
    const store = tx.objectStore('cacheMetadata');
    await store.put({ url, timestamp, updatedAt: Date.now() });
  } catch (error) {
    console.error('[SW] Error saving cache metadata:', error);
  }
}

// Получение метаданных кэша
async function getCacheMetadata(url) {
  try {
    const db = await openDB();
    const tx = db.transaction('cacheMetadata', 'readonly');
    const store = tx.objectStore('cacheMetadata');
    return new Promise((resolve, reject) => {
      const request = store.get(url);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error('[SW] Error getting cache metadata:', error);
    return null;
  }
}

// Получение всех метаданных
async function getAllCacheMetadata() {
  try {
    const db = await openDB();
    const tx = db.transaction('cacheMetadata', 'readonly');
    const store = tx.objectStore('cacheMetadata');
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error('[SW] Error getting all cache metadata:', error);
    return [];
  }
}

// Очистка старых записей (FIFO)
async function cleanupOldCache(limitGroups, limitTeachers, limitAuditories = 10) {
  try {
    const allMetadata = await getAllCacheMetadata();
    const groups = allMetadata.filter(m => m.url.includes('/gen?group=') && !m.url.includes('/gen_teach') && !m.url.includes('/gen_auditory'));
    const teachers = allMetadata.filter(m => m.url.includes('/gen_teach?teacher='));
    const auditories = allMetadata.filter(m => m.url.includes('/gen_auditory?auditory='));
    
    groups.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    teachers.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    auditories.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    
    const groupsToDelete = groups.slice(0, Math.max(0, groups.length - limitGroups));
    const teachersToDelete = teachers.slice(0, Math.max(0, teachers.length - limitTeachers));
    const auditoriesToDelete = auditories.slice(0, Math.max(0, auditories.length - limitAuditories));
    
    const db = await openDB();
    const tx = db.transaction('cacheMetadata', 'readwrite');
    const store = tx.objectStore('cacheMetadata');
    const cache = await caches.open(API_CACHE);
    
    for (const item of [...groupsToDelete, ...teachersToDelete, ...auditoriesToDelete]) {
      store.delete(item.url);
      cache.delete(item.url);
    }
  } catch (error) {
    console.error('[SW] Error cleaning up cache:', error);
  }
}

// Установка Service Worker
self.addEventListener('install', (event) => {
  console.log('[Service Worker] Installing...');
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      console.log('[Service Worker] Caching static files');
      // Кэшируем файлы, игнорируя ошибки для несуществующих
      return Promise.allSettled(
        STATIC_FILES.map(url => {
          return fetch(url, { credentials: 'same-origin' })
            .then(response => {
              if (response.ok) {
                return cache.put(url, response);
              }
            })
            .catch(err => {
              console.log(`[SW] Failed to cache ${url}:`, err);
              return null;
            });
        })
      );
    })
  );
  self.skipWaiting();
});

// Активация Service Worker
self.addEventListener('activate', (event) => {
  console.log('[Service Worker] Activating...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== STATIC_CACHE && cacheName !== API_CACHE) {
            console.log('[Service Worker] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => cleanupOldCache(10, 20, 10))
      .then(() => self.clients.claim())
      .then(() => backgroundUpdate())
  );
});

// Перехват запросов
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  const requestUrl = request.url;

  // API запросы - кэшируем с проверкой сети
  const isGenApi = url.pathname === '/gen' || url.pathname.startsWith('/gen_teach') || url.pathname.startsWith('/gen_auditory') || url.pathname.startsWith('/api/');
  if (isGenApi) {
    event.respondWith(
      caches.open(API_CACHE).then((cache) => {
        return fetch(request)
          .then(async (response) => {
            if (response.status === 200) {
              const responseClone = response.clone();
              await cache.put(request, responseClone);
              await saveCacheMetadata(requestUrl, Date.now());
              await cleanupOldCache(10, 20, 10);
            }
            return response;
          })
          .catch(async () => {
            // Если сеть недоступна, возвращаем из кэша
            const cachedResponse = await cache.match(request);
            if (cachedResponse) {
              // Получаем метаданные
              const metadata = await getCacheMetadata(requestUrl);
              const modifiedHeaders = new Headers(cachedResponse.headers);
              modifiedHeaders.set('X-Offline-Cache', 'true');
              if (metadata && metadata.timestamp) {
                modifiedHeaders.set('X-Cache-Timestamp', metadata.timestamp.toString());
              } else {
                // Если метаданных нет, используем текущее время как fallback
                modifiedHeaders.set('X-Cache-Timestamp', Date.now().toString());
              }
              return new Response(cachedResponse.body, {
                status: cachedResponse.status,
                statusText: cachedResponse.statusText,
                headers: modifiedHeaders
              });
            }
            // Если нет в кэше, возвращаем ошибку
            return new Response(
              JSON.stringify({ error: 'Нет подключения к интернету и данные не найдены в кэше' }),
              {
                status: 503,
                headers: { 'Content-Type': 'application/json' }
              }
            );
          });
      })
    );
    return;
  }

  // Статические файлы и HTML страницы - стратегия "Cache First"
  if (url.origin === location.origin) {
    const isHTMLPage = url.pathname === '/gui' ||
                       url.pathname === '/searchStudent' ||
                       url.pathname === '/searchTeacher' ||
                       url.pathname === '/searchAuditory';
    
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(request).then((response) => {
          // Кэшируем HTML страницы и статические файлы
          if (response.status === 200 && (
            isHTMLPage ||
            url.pathname.endsWith('.css') ||
            url.pathname.endsWith('.js') ||
            url.pathname.endsWith('.json') ||
            url.pathname.endsWith('.png') ||
            url.pathname.endsWith('.ico')
          )) {
            const responseClone = response.clone();
            caches.open(STATIC_CACHE).then((cache) => {
              cache.put(request, responseClone);
              console.log(`[SW] Cached: ${url.pathname}`);
            });
          }
          return response;
        }).catch(() => {
          // Если сеть недоступна, пытаемся вернуть из кэша
          return caches.match(request).then((cached) => {
            if (cached) {
              return cached;
            }
            // Если это HTML страница и нет в кэше, пробуем найти любую HTML страницу
            if (isHTMLPage) {
              return caches.match('/gui').then(gui => {
                if (gui) return gui;
                return caches.match('/searchStudent').then(student => {
                  if (student) return student;
                  return caches.match('/searchTeacher').then(teacher => {
                    if (teacher) return teacher;
                    return caches.match('/searchAuditory');
                  });
                });
              });
            }
            return new Response('Нет подключения к интернету', {
              status: 503,
              headers: { 'Content-Type': 'text/plain' }
            });
          });
        });
      })
    );
  }
});

// Фоновое обновление кэша
async function backgroundUpdate() {
  if (!self.navigator || !self.navigator.onLine) {
    console.log('[SW] Background update skipped - offline');
    return;
  }

  try {
    const clients = await self.clients.matchAll();
    if (clients.length === 0) {
      const allMetadata = await getAllCacheMetadata();
      const groups = allMetadata.filter(m => m.url.includes('/gen?group=') && !m.url.includes('/gen_teach') && !m.url.includes('/gen_auditory')).slice(0, 12);
      const teachers = allMetadata.filter(m => m.url.includes('/gen_teach?teacher=')).slice(0, 12);
      const auditories = allMetadata.filter(m => m.url.includes('/gen_auditory?auditory=')).slice(0, 12);
      const groupNames = groups.map(g => new URL(g.url, self.location.origin).searchParams.get('group')).filter(Boolean);
      const teacherNames = teachers.map(t => new URL(t.url, self.location.origin).searchParams.get('teacher')).filter(Boolean);
      const auditoryNames = auditories.map(a => new URL(a.url, self.location.origin).searchParams.get('auditory')).filter(Boolean);
      await updateRecentItems(groupNames, teacherNames, auditoryNames);
      return;
    }
    clients[0].postMessage({ type: 'GET_RECENT_ITEMS' });
  } catch (error) {
    console.error('[SW] Error in background update:', error);
  }
}

// Обработка сообщений от клиента
self.addEventListener('message', async (event) => {
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    await caches.delete(API_CACHE);
    if (event.ports && event.ports[0]) {
      event.ports[0].postMessage({ success: true });
    }
  }
  
  if (event.data && event.data.type === 'GET_RECENT_ITEMS_RESPONSE') {
    const { recentGroups, recentTeachers, recentAuditories } = event.data;
    await updateRecentItems(recentGroups || [], recentTeachers || [], recentAuditories || []);
  }
  
  if (event.data && event.data.type === 'START_BACKGROUND_UPDATE') {
    await updateRecentItems(event.data.recentGroups || [], event.data.recentTeachers || [], event.data.recentAuditories || []);
  }
});

// Обновление недавних элементов
async function updateRecentItems(recentGroups, recentTeachers, recentAuditories = []) {
  const cache = await caches.open(API_CACHE);
  const today = new Date().toISOString().split('T')[0];
  const clients = await self.clients.matchAll();
  const totalItems = recentGroups.length + recentTeachers.length + recentAuditories.length;

  for (const group of recentGroups.slice(0, 12)) {
    try {
      const url = `/gen?group=${encodeURIComponent(group)}&type=json&date=${today}`;
      const response = await fetch(url);
      if (response.ok) {
        await cache.put(url, response.clone());
        await saveCacheMetadata(url, Date.now());
        clients.forEach(c => c.postMessage({ type: 'CACHE_UPDATED', item: group, itemType: 'group', total: totalItems }));
      }
    } catch (e) {
      console.error(`[SW] Error updating group ${group}:`, e);
    }
  }

  for (const teacher of recentTeachers.slice(0, 12)) {
    try {
      const url = `/gen_teach?teacher=${encodeURIComponent(teacher)}&type=json&date=${today}`;
      const response = await fetch(url);
      if (response.ok) {
        await cache.put(url, response.clone());
        await saveCacheMetadata(url, Date.now());
        clients.forEach(c => c.postMessage({ type: 'CACHE_UPDATED', item: teacher, itemType: 'teacher', total: totalItems }));
      }
    } catch (e) {
      console.error(`[SW] Error updating teacher ${teacher}:`, e);
    }
  }

  for (const auditory of recentAuditories.slice(0, 12)) {
    try {
      const url = `/gen_auditory?auditory=${encodeURIComponent(auditory)}&type=json&date=${today}`;
      const response = await fetch(url);
      if (response.ok) {
        await cache.put(url, response.clone());
        await saveCacheMetadata(url, Date.now());
        clients.forEach(c => c.postMessage({ type: 'CACHE_UPDATED', item: auditory, itemType: 'auditory', total: totalItems }));
      }
    } catch (e) {
      console.error(`[SW] Error updating auditory ${auditory}:`, e);
    }
  }

  clients.forEach(c => c.postMessage({ type: 'CACHE_UPDATE_COMPLETE' }));
  await cleanupOldCache(10, 20, 10);
}

// Обновление каждый час через таймер (работает пока Service Worker активен)
let updateTimer = null;

function startPeriodicUpdate() {
  if (updateTimer) clearInterval(updateTimer);
  
  // Обновление каждый час
  updateTimer = setInterval(() => {
    backgroundUpdate();
  }, 60 * 60 * 1000);
  
  // Также обновляем при активации
  backgroundUpdate();
}

// Запускаем периодическое обновление
startPeriodicUpdate();
