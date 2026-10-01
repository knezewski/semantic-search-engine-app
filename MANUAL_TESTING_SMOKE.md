# Smoke-чек-лист — Semantic Document Retrieval Engine

Короткий прогон для быстрой проверки, что система жива и основной сценарий работает.
Полный сценарий — в `MANUAL_TESTING.md`.

## Подготовка

```sh
cd semantic-search-engine
cp .env.example .env
bun install
bun run infra:up
bun run dev          # терминал 1
bun run dev:worker   # терминал 2
export BASE=http://localhost:3000
```

---

## Чек-лист

| # | Проверка | Команда | Ожидание | ✓ |
| --- | --- | --- | --- | --- |
| 1 | API жив | `curl -s $BASE/health` | `{"status":"ok"}` | |
| 2 | Готовность | `curl -s $BASE/ready` | `qdrant:true`, `redis:true` | |
| 3 | Метрики | `curl -s $BASE/metrics` | 4 очереди (`document-ingest`, `chunk-generation`, `embedding-generation`, `vector-indexing`) | |
| 4 | Приём документа | `curl -s -X POST $BASE/documents -H 'content-type: application/json' -d '{"title":"Auth","text":"JWT authentication allows stateless sessions.","source":"docs/auth.md"}'` | `202`, `{"id":"<uuid>","status":"queued"}` | |
| 5 | Статус доходит до `ready` | `curl -s $BASE/documents/<id>` (повторить через 10–30 c) | финально `"status":"ready"` | |
| 6 | Поиск находит документ | `curl -s -X POST $BASE/search -H 'content-type: application/json' -d '{"query":"JWT authentication","limit":5}'` | в `results` есть чанк с `documentId` из шага 4 | |
| 7 | Фильтр по source | добавить `"source":"docs/auth.md"` в запрос шага 6 | все `source == docs/auth.md` | |
| 8 | Ошибка валидации | `curl -s -X POST $BASE/documents -H 'content-type: application/json' -d '{}'` | `400`, `code:"VALIDATION_ERROR"` | |
| 9 | 404 документа | `curl -s $BASE/documents/00000000-0000-0000-0000-000000000000` | `404 NOT_FOUND` | |

---

## Результат прогона

- **Дата / исполнитель:**
- **Статус:** PASS / FAIL
- **Замечания:**

При любом FAIL — идти в `MANUAL_TESTING.md`, соответствующий тест-кейс (PIPE-01, SRCH-01, VAL-*, SM-*).
