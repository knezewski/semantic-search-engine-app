# Сценарий ручного тестирования — Semantic Document Retrieval Engine

Документ описывает ручное (manual) тестирование backend-системы семантического поиска документов.
Проверяются: публичный контракт API, асинхронный ingestion-пайплайн, dense/hybrid/rerank-поиск,
надёжность (retry, replay, idempotency), персистентность и инструменты оценки качества.

- Тестируемая система: `semantic-search-engine` (Bun + Hono + BullMQ/Redis + Qdrant + SQLite)
- Опорные документы: `README.md`, `semantic_document_retrieval_engine.md`
- Формат: тест-кейсы с ID, предусловиями, шагами и ожидаемым результатом

---

## 1. Область и цель

Цель — убедиться, что система:

1. принимает документы через HTTP API и асинхронно доводит их до статуса `ready`;
2. корректно валидирует входные данные и возвращает осмысленные ошибки;
3. выполняет семантический (`dense`), гибридный (`hybrid`) и rerank-поиск;
4. переживает сбои Redis/Qdrant, поддерживает retry и ручной replay;
5. идемпотентна при повторной обработке;
6. сохраняет данные между перезапусками инфраструктуры;
7. предоставляет harness'ы оценки качества (eval) и производительности (bench).

Вне области ручного тестирования (покрывается автотестами `bun test src`): внутренние unit-тесты chunking, sparse, RRF, метрик, кэша эмбеддингов.

---

## 2. Тестируемые интерфейсы

| Метод | Путь | Назначение | Успешный ответ |
| --- | --- | --- | --- |
| GET | `/health` | Liveness процесса | `200 { "status": "ok" }` |
| GET | `/ready` | Готовность: Qdrant collection + Redis | `200 { "status": "ok", "qdrant": true, "redis": true, "collection": "document_chunks" }` |
| GET | `/metrics` | Счётчики BullMQ по очередям | `200 { "status": "ok", "queues": [...] }` |
| POST | `/documents` | Постановка документа в ingestion | `202 { "id": "<uuid>", "status": "queued" }` |
| GET | `/documents/:id` | Статус обработки документа | `200 { id, title, source, status, createdAt, updatedAt, lastError }` |
| POST | `/search` | Семантический поиск | `200 { "results": [ { chunkId, documentId, text, score, title, source, position } ] }` + заголовок `Server-Timing` |

Очереди BullMQ (префикс `sse`): `document-ingest`, `chunk-generation`, `embedding-generation`, `vector-indexing`.

Статусы пайплайна: `queued` → `chunking` → `embedding` → `indexing` → `ready` | `failed` (см. `GET /documents/:id`).

Коды ошибок: `VALIDATION_ERROR` (400), `NOT_FOUND` (404), `NOT_READY` (503), `INTERNAL_ERROR` (500).

---

## 3. Окружение и предусловия

### 3.1 Требования

- Bun установлен;
- Docker установлен и запущен;
- свободны порты `3000` (API), `6379` (Redis), `6333`/`6334` (Qdrant).

### 3.2 Подготовка

```sh
cd semantic-search-engine
cp .env.example .env
bun install
bun run infra:up
```

Затем в двух отдельных терминалах:

```sh
bun run dev          # терминал 1 — API (http://localhost:3000)
bun run dev:worker   # терминал 2 — воркеры пайплайна
```

При старте API ожидается:

- проверка Qdrant и коллекции `document_chunks` (создана/готова);
- `Embedding model warmed up`;
- `Rerank model warmed up (Xenova/ms-marco-MiniLM-L-6-v2)` (при `RERANK_ENABLED=true`);
- `Server running on http://localhost:3000`.

Воркеры должны вывести `Workers started: document-ingest, chunk-generation, embedding-generation, vector-indexing`.

Проверка окружения:

```sh
export BASE=http://localhost:3000
docker compose -f docker/docker-compose.yml ps
```

> `jq` использовать необязательно; ниже команды с `jq` можно заменить на `python3 -m json.tool`.

### 3.3 Общие предусловия для тест-кейсов

- API и воркеры запущены (разделы 3.1–3.2);
- инфраструктура (Redis + Qdrant) доступна;
- при необходимости детерминированного количества результатов коллекцию `document_chunks` можно очистить:

```sh
curl -s -X DELETE http://localhost:6333/collections/document_chunks
# затем перезапустить API, чтобы ensureCollection пересоздал коллекцию
```

---

## 4. Тестовые данные

Для предсказуемости фильтров использовать уникальные значения `source`.

| ID | title | source | text (суть) | Назначение |
| --- | --- | --- | --- | --- |
| D1 | Authentication Guide | `docs/auth.md` | 4–6 абзацев про JWT, OAuth, refresh-токены, истечение сессии | Позитив, много чанков, фильтр по source |
| D2 | Payments API | `docs/payments.md` | 4–6 абзацев про платежи, идемпотентность, вебхуки | Позитив, второй source для фильтра |
| D3 | Release Notes | (не задан) | Короткий текст про релиз | Проверка отсутствия `source` |
| D4 | Whitespace | `docs/ws.md` | строка из пробелов/`\n` | Негатив: пустой после trim текст |
| D5 | Huge | `docs/huge.md` | > 100 000 символов | Негатив: превышение лимита |

Длинные тексты D1/D2 при `CHUNK_SIZE=500`/`CHUNK_OVERLAP=50` должны давать ≥ 3–5 чанков.

---

## 5. Тест-кейсы

### 5.1 Smoke: health / ready / metrics

| ID | Название | Приоритет | Шаги | Ожидаемый результат |
| --- | --- | --- | --- | --- |
| SM-01 | Liveness | High | `curl -i $BASE/health` | `200`, тело `{"status":"ok"}` |
| SM-02 | Readiness | High | `curl -i $BASE/ready` | `200`, `qdrant:true`, `redis:true`, `collection:"document_chunks"` |
| SM-03 | Метрики очередей | High | `curl -s $BASE/metrics` | `status:"ok"`; массив `queues` из 4 элементов с именами `document-ingest`, `chunk-generation`, `embedding-generation`, `vector-indexing`; у каждого поля `waiting/active/completed/failed/delayed/paused` (числа ≥ 0) |
| SM-04 | Неизвестный маршрут | Medium | `curl -i $BASE/nope` | `404`, `{"error":{"code":"NOT_FOUND","message":"No route for GET /nope"}}` |

### 5.2 Приём документов: позитивные сценарии

| ID | Название | Приоритет | Шаги | Ожидаемый результат |
| --- | --- | --- | --- | --- |
| DOC-01 | Успешный приём D1 | High | `curl -i -X POST $BASE/documents -H 'content-type: application/json' -d '{"title":"Authentication Guide","text":"<D1 text>","source":"docs/auth.md"}'` | `202`, тело `{"id":"<uuid>","status":"queued"}`; сохранить `id` для дальнейших шагов |
| DOC-02 | Приём без `source` (D3) | Medium | POST с `title` и `text`, без `source` | `202`, `status:"queued"` |
| DOC-03 | `id` — валидный UUID | Low | проверить формат `id` из ответа | соответствует UUID v4 |

### 5.3 Приём документов: валидация (негатив)

Все ожидания — HTTP `400` с `code:"VALIDATION_ERROR"`.

| ID | Название | Тело запроса (суть) | Ожидаемый результат |
| --- | --- | --- | --- |
| VAL-01 | Нет `title` | `{"text":"abc"}` | `400 VALIDATION_ERROR` |
| VAL-02 | Пустой `title` | `{"title":"","text":"abc"}` | `400 VALIDATION_ERROR` (нужно `0 < title <= 300`) |
| VAL-03 | `title` > 300 символов | title из 301 символа | `400 VALIDATION_ERROR` |
| VAL-04 | Нет `text` | `{"title":"t"}` | `400 VALIDATION_ERROR` |
| VAL-05 | Пустой `text` | `{"title":"t","text":""}` | `400 VALIDATION_ERROR` |
| VAL-06 | `text` > 100 000 символов (D5) | text из 100 001 символа | `400 VALIDATION_ERROR` |
| VAL-07 | `source` > 500 символов | source из 501 символа | `400 VALIDATION_ERROR` |
| VAL-08 | Битый JSON | тело `{` (невалидный JSON) | `400`, `{"error":{"code":"VALIDATION_ERROR","message":"Invalid JSON body"}}` |
| VAL-09 | Пробельный `text` (D4) | `{"title":"Whitespace","text":"   \n  ","source":"docs/ws.md"}` | API принимает `202` (схема проверяет длину строки, не trim); ошибка проявляется на этапе ingest-воркера — см. REL-05 |

### 5.4 Пайплайн и статусы документа

| ID | Название | Приоритет | Шаги | Ожидаемый результат |
| --- | --- | --- | --- | --- |
| PIPE-01 | Документ доходит до `ready` | High | после DOC-01 опрашивать: `for i in $(seq 1 30); do curl -s $BASE/documents/$ID; echo; sleep 2; done` | статус последовательно проходит `queued`/`chunking`/`embedding`/`indexing` и финально `ready`; `lastError:null` |
| PIPE-02 | Ответ не содержит `text` | Medium | посмотреть JSON `GET /documents/:id` | поля `text` в ответе нет (публичный контракт не отдаёт исходный текст); есть `title`, `source`, `status`, `createdAt`, `updatedAt`, `lastError` |
| PIPE-03 | `updatedAt` растёт | Low | сравнить `createdAt` и `updatedAt` после `ready` | `updatedAt >= createdAt` |
| PIPE-04 | Новый документ обрабатывается | Medium | отправить D2, дождаться `ready` | `202` → `ready`; в `/metrics` счётчик `completed` соответствующих очередей увеличивается |
| PIPE-05 | Неизвестный документ | Medium | `curl -i $BASE/documents/00000000-0000-0000-0000-000000000000` | `404`, `{"error":{"code":"NOT_FOUND","message":"Document ... not found"}}` |

### 5.5 Поиск

Предусловие: D1 и D2 в статусе `ready`.

| ID | Название | Приоритет | Шаги | Ожидаемый результат |
| --- | --- | --- | --- | --- |
| SRCH-01 | Базовый поиск (режим по умолчанию) | High | `curl -i -X POST $BASE/search -H 'content-type: application/json' -d '{"query":"How does JWT authentication work?","limit":5}'` | `200`, `{results:[...]}`; при `RERANK_ENABLED=true` режим по умолчанию — `rerank`; в топе — чанки D1; присутствует заголовок `Server-Timing` с `embed`, `qdrant`, `rerank`, `total` |
| SRCH-02 | Поля результата | High | разобрать первый элемент `results` | присутствуют `chunkId`, `documentId`, `text`, `score`, `title`, `source`, `position` |
| SRCH-03 | Дефолтный `limit` | Low | POST только с `query` | количество результатов ≤ 5 (по умолчанию 5) |
| SRCH-04 | `mode=dense` | Medium | `{"query":"...","limit":5,"mode":"dense"}` | `200`, результаты отсортированы по `score` (косинус) убыв.; `Server-Timing` содержит `rerank;dur=0.0` |
| SRCH-05 | `mode=hybrid` | Medium | `{"query":"...","limit":5,"mode":"hybrid"}` | `200`, `rerank;dur=0.0`; результаты — результат RRF-слияния dense+sparse |
| SRCH-06 | `mode=rerank` явно | Medium | `{"query":"...","limit":5,"mode":"rerank"}` | `200`, `rerank;dur>0` (reranker работал) |
| SRCH-07 | Релевантность запроса про платежи | High | `{"query":"How do payments and webhooks work?","limit":5}` | в топе присутствуют чанки D2 (`documentId` соответствует D2) |
| SRCH-08 | Фильтр по `source` | High | `{"query":"authentication","limit":10,"source":"docs/auth.md"}` | все `source` в результатах равны `docs/auth.md`; документов с другим source нет |
| SRCH-09 | Фильтр исключает чужой source | Medium | `{"query":"webhooks","limit":10,"source":"docs/auth.md"}` | результаты не содержат чанков D2 |
| SRCH-10 | `scoreThreshold` (только dense) | Medium | `{"query":"...","limit":10,"mode":"dense","scoreThreshold":0.95}` | число результатов уменьшается/может стать 0 по сравнению с тем же запросом без порога |
| SRCH-11 | `scoreThreshold` игнорируется вне dense | Low | тот же запрос с `"mode":"hybrid", "scoreThreshold":0.95` | результаты сопоставимы с SRCH-05 (порог не применяется — задокументировать поведение) |
| SRCH-12 | Пустой результат | Low | запрос на уникальной «мусорной» строке, напр. `{"query":"zxqwv unmatched token 9987"}` | `200`, `results:[]` (или мало результатов) без ошибки |
| SRCH-13 | `Server-Timing` присутствует всегда | Medium | `curl -i` для SRCH-01..06 | заголовок есть в каждом ответе `POST /search` |

Негативная валидация поиска (ожидается `400 VALIDATION_ERROR`):

| ID | Название | Тело | Ожидание |
| --- | --- | --- | --- |
| SRCH-V01 | Нет `query` | `{"limit":5}` | `400` |
| SRCH-V02 | Пустой `query` | `{"query":""}` | `400` |
| SRCH-V03 | `query` > 2000 символов | query из 2001 символа | `400` |
| SRCH-V04 | `limit` = 0 | `{"query":"a","limit":0}` | `400` |
| SRCH-V05 | `limit` = 51 | `{"query":"a","limit":51}` | `400` |
| SRCH-V06 | `limit` не целое | `{"query":"a","limit":2.5}` | `400` |
| SRCH-V07 | `scoreThreshold` вне [0,1] | `{"query":"a","scoreThreshold":1.5}` | `400` |
| SRCH-V08 | Некорректный `mode` | `{"query":"a","mode":"bm25"}` | `400` |

### 5.6 Обработка ошибок и деградация инфраструктуры

| ID | Название | Приоритет | Шаги | Ожидаемый результат |
| --- | --- | --- | --- | --- |
| ERR-01 | Qdrant недоступен → `/ready` | High | `docker compose -f docker/docker-compose.yml stop qdrant`; `curl -i $BASE/ready` | `503`, `{"error":{"code":"NOT_READY","message":"Qdrant collection is not reachable"}}`; вернуть Qdrant обратно |
| ERR-02 | Redis недоступен → `/ready` | High | остановить контейнер `redis`; `curl -i $BASE/ready` | `503`, `NOT_READY`, сообщение про Redis; вернуть Redis обратно |
| ERR-03 | Отсутствие тихого подавления ошибок | Medium | проанализировать коды ошибок API | ошибки имеют контекст (код + сообщение), не «глотаются»; общий error handler возвращает структуру `{"error":{code,message}}` |
| ERR-04 | Redis недоступен при приёме | High | остановить Redis, затем `POST /documents` | запрос завершается ошибкой; документ не «зависает» в `queued` (при недоступности enqueue статус переводится в `failed` согласно логике `submitDocument`) |

### 5.7 Надёжность: retry, failed, replay

| ID | Название | Приоритет | Шаги | Ожидаемый результат |
| --- | --- | --- | --- | --- |
| REL-01 | Задача ждёт воркера | High | остановить воркеры (Ctrl+C в терминале 2); отправить D2 | `GET /documents/:id` → `queued`; `/metrics` показывает рост `waiting` в `document-ingest` |
| REL-02 | Воркер разгребает очередь | High | запустить `bun run dev:worker` | документ из REL-01 переходит в `ready`; `waiting` уменьшается |
| REL-03 | Retry-политика | Medium | наблюдать за пайплайном | при сбое job повторяется до 3 попыток с экспоненциальной задержкой (базовая 1 c); неуспешные job остаются в `failed` (`removeOnFail:false`) |
| REL-04 | Ручной replay | High | `bun run jobs:replay -- $ID` (воркеры должны быть запущены) | в консоли `Re-queued ingest for <id>`; статус документа возвращается в `queued` и снова доходит до `ready` |
| REL-05 | Пустой (пробельный) текст → failed | High | отправить D4 (см. VAL-09) | после исчерпания попыток статус `failed`, `lastError` содержит сообщение об пустом тексте (из ingest-воркера); `/metrics` фиксирует `failed` в `document-ingest` |
| REL-06 | Статус `failed` доступен для диагностики | Medium | `curl -s $BASE/documents/$ID` → `lastError` | непустой `lastError` объясняет причину сбоя |

### 5.8 Идемпотентность

| ID | Название | Приоритет | Шаги | Ожидаемый результат |
| --- | --- | --- | --- | --- |
| IDEM-01 | Повторный replay не создаёт дубликатов | High | для `ready`-документа: зафиксировать `points_count` (`curl -s http://localhost:6333/collections/document_chunks`); выполнить `bun run jobs:replay -- $ID`; дождаться `ready`; снова прочитать `points_count` | число точек не возрастает (детерминированные id чанков + upsert); дубликатов нет |
| IDEM-02 | Стабильные id чанков | Medium | проверить `chunkId` в результатах поиска | имеют вид `<documentId>:chunk-<position>` |
| IDEM-03 | Повторный ingest того же документа | Low | отправить тот же текст ещё раз | создаётся новый `documentId` (каждый POST = новый документ); дубликатов «внутри одного документа» нет |

### 5.9 Персистентность

| ID | Название | Приоритет | Шаги | Ожидаемый результат |
| --- | --- | --- | --- | --- |
| PERS-01 | Данные Qdrant переживают перезапуск | High | `docker compose -f docker/docker-compose.yml restart qdrant`; дождаться готовности; повторить SRCH-07 | поиск снова возвращает релевантные чанки (volume `qdrant_data` сохранён) |
| PERS-02 | Повторный полный `down`/`up` | Medium | `bun run infra:down && bun run infra:up`; дождаться; повторить SRCH-01 | результаты поиска сохраняются |
| PERS-03 | SQLite-стор документов | Medium | перезапустить API; `GET /documents/$ID` | запись о документе сохраняется (файл `SQLITE_PATH`, по умолчанию `./data/semantic-search.sqlite`) |

### 5.10 Качество и производительность (harness'ы)

| ID | Название | Приоритет | Шаги | Ожидаемый результат |
| --- | --- | --- | --- | --- |
| QL-01 | Retrieval evaluation | High | `bun run eval` | выводит метрики для `dense`, `hybrid`, `rerank`; создаёт `eval-results.json`; содержит `recallAt5/10`, `mrr`, `ndcgAt10` (сравнить режимы) |
| QL-02 | Chunking experiments | Medium | `bun run eval:chunks` | прогон вариантов размера чанка (250/25, 500/50, 800/80) с выводом метрик |
| QL-03 | Embedding bake-off | Low | `bun run eval:models` | сравнение моделей эмбеддингов по качеству/латентности |
| QL-04 | Qdrant sweep | Low | `bun run eval:qdrant` | сравнение параметров HNSW / квантования |
| PF-01 | Search benchmark | Medium | `bun run bench` | выводятся перцентили задержки (P50/P95/P99); создаётся `bench-results.json` |
| PF-02 | Ingest throughput | Medium | `bun run bench:ingest` | выводятся показатели пропускной способности ingestion |

### 5.11 Сборка и статический анализ (acceptance-предусловие)

| ID | Название | Шаги | Ожидаемый результат |
| --- | --- | --- | --- |
| BLD-01 | Типы | `bun run type-check` | без ошибок |
| BLD-02 | Линт | `bun run lint` | без ошибок |
| BLD-03 | Unit-тесты | `bun test src` | все тесты проходят |

---

## 6. Матрица трассируемости (Definition of Done)

| Критерий из `semantic_document_retrieval_engine.md` §20 | Тест-кейсы |
| --- | --- |
| Документ принимается через API | DOC-01, DOC-02, VAL-01..VAL-09 |
| Документ попадает в BullMQ | DOC-01, REL-01 |
| Ingest worker обрабатывает задачу | PIPE-01, REL-02 |
| Документ разбивается на chunks | PIPE-01, IDEM-02 |
| Chunks получают embeddings | PIPE-01 (статус `embedding`) |
| Embeddings индексируются в Qdrant | PIPE-01 (статус `indexing`), IDEM-01 |
| Qdrant хранит metadata | SRCH-02 (`title`, `source`, `position`) |
| Semantic search возвращает top-K | SRCH-01..SRCH-13 |
| Pipeline поддерживает retries | REL-03, REL-05 |
| Операции idempotent | IDEM-01..IDEM-03 |
| Failed jobs диагностируемы | REL-05, REL-06 |
| Базовые logs/metrics | SM-03, ERR-03, `Server-Timing` |
| Retrieval evaluation | QL-01..QL-04 |
| Performance benchmark | PF-01, PF-02 |

---

## 7. Критерии завершения прогона (Exit criteria)

Прогон считается успешным, если:

- все тест-кейсы приоритета **High** пройдены (или дефекты по ним заведены и согласованы);
- нет открытых дефектов уровня **Critical/Blocker**;
- раздел 5.11 (сборка, линт, unit-тесты) — зелёный;
- метрики `eval` получены и сохранены в `eval-results.json`.

---

## 8. Классификация дефектов и шаблон отчёта

Severity:

- **Blocker** — система не запускается, данные теряются, пайплайн не работает.
- **Critical** — неверный результат поиска, «зависание» статуса, необработанная ошибка 500 на штатных сценариях.
- **Major** — нарушение контракта/валидации, некорректный код ошибки.
- **Minor** — неточность в метаданных, форматировании, незначительные расхождения.
- **Trivial** — косметика.

Шаблон отчёта о дефекте:

- **ID:** BUG-___
- **Связанный тест-кейс:** TC-___
- **Severity / Priority:**
- **Окружение:** ОС, версия Bun, состояние контейнеров
- **Шаги воспроизведения:**
- **Фактический результат:**
- **Ожидаемый результат:**
- **Логи / скриншоты:** (вывод API, `/metrics`, логи воркеров)
- **Комментарий:**

---

## 9. Приложение: вспомогательные команды

```sh
# базовый URL
export BASE=http://localhost:3000

# приём документа
curl -i -X POST "$BASE/documents" \
  -H 'content-type: application/json' \
  -d '{"title":"Authentication Guide","text":"JWT authentication allows...","source":"docs/auth.md"}'

# статус документа
curl -s "$BASE/documents/<id>" | python3 -m json.tool

# поиск
curl -i -X POST "$BASE/search" \
  -H 'content-type: application/json' \
  -d '{"query":"How does JWT authentication work?","limit":5}'

# метрики очередей
curl -s "$BASE/metrics" | python3 -m json.tool

# количество точек в коллекции Qdrant
curl -s "http://localhost:6333/collections/document_chunks" | python3 -m json.tool

# replay неуспешного документа (воркеры должны быть запущены)
bun run jobs:replay -- <documentId>
```

---

## 10. Результаты прогона (2026-10-04)

Полный прогон по всем разделам выполнен, все High-приоритетные кейсы проходят. После исправления двух дефектов:

- **SRCH-06** — PASS: режим `rerank` возвращает реальные score (сырые логиты cross-encoder, `src/services/rerank/index.ts`) и изменяет порядок выдачи относительно `hybrid`.
- **ERR-04** — PASS: при недоступном Redis `POST /documents` отвечает `503 NOT_READY`, документ переводится в `failed` (`src/services/document/submit.ts`, `src/utils/timeout.ts`), а не зависает в `queued`.

См. также `README.md`: `RERANK_CANDIDATES` теперь задаёт потолок пула кандидатов (дефолт 15) для контроля латентности rerank.
