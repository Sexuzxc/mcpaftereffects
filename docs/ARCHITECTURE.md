# Архитектура и протокол моста (RU)

## Компоненты

```
after-effects-mcp-server/
├─ bridge/ae_bridge.jsx      резидентный ExtendScript-мост (ES3) внутри AE
├─ registry/tools.json       единый реестр инструментов (JSON Schema)
├─ python/ae_mcp/            MCP-сервер №1 (Python, официальный mcp SDK)
│   ├─ server.py             MCP: list_tools/call_tool, stdio + streamable HTTP
│   ├─ bridge.py             клиент почтового ящика + aerender-субпроцесс
│   └─ launcher.py           поиск AfterFX.exe, heartbeat, пуш моста (-r)
└─ typescript/src/           MCP-сервер №2 (TypeScript, @modelcontextprotocol/sdk)
    ├─ index.ts              CLI (--http --port --read-only --enable-eval --status)
    ├─ server.ts             MCP-обвязка реестра (та же семантика, что в Python)
    ├─ bridge.ts             клиент почтового ящика (цепочка вызовов = сериализация)
    └─ launcher.ts           то же, что launcher.py
```

Оба сервера — **тонкие транспорты**: реализации инструментов живут в
`ae_bridge.jsx`, схемы — в `tools.json`. Добавить новый инструмент =
функция в мосте + запись в `registry/generate_registry.py` + перегенерация.

## Почтовый ящик

Корень: `%TEMP%\ae-mcp-bridge\` (переопределяется `AE_MCP_RUNTIME_DIR`
на обеих сторонах; мост читает её через `$.getenv`).

```
ae-mcp-bridge/
├─ heartbeat.json                 раз в 1 c + при смене состояния
├─ bridge.log                     ролируемый лог AE-стороны (128 KB)
├─ commands/request-<ts>-<id>.json   <- пишет сервер, стирает мост ДО исполнения
└─ results/response-<id>.json        <- пишет мост, читает и стирает сервер
```

### Запрос

```json
{
  "tool": "comp_create",
  "args": { "name": "Intro", "width": 1920 },
  "ts": 1730000000.123,
  "undo_group": true,
  "suppress_dialogs": true
}
```

Имя файла `request-<epoch_ms>-<uuid>.json`: сортировка по имени = хронология,
ID коррелирует ответ даже при битом теле.

### Ответ

```json
{
  "id": "1730000000123-ab12cd34",
  "ok": true,
  "result": { "...": "..." },
  "meta": { "ae_version": "25.2.0", "duration_ms": 41, "served": 7 }
}
```

Ошибка: `{ "ok": false, "error": { "code": "TOOL_ERROR|BAD_ARGS|NOT_FOUND|...",
"message": "..." } }`. Огромные результаты (>8 MB) обрезаются с
`RESULT_TOO_LARGE` вместо зависания канала.

### Гарантии

- **Consume-on-read**: мост удаляет запрос до исполнения — падение AE не
  перезапускает команду.
- **Correlation**: ответ ищется строго по `response-<id>.json`; «чужие» и
  устаревшие ответы невозможны.
- **Сериализация**: на стороне сервера вызовы выстраиваются в цепочку
  (thread-lock в Python, promise-chain в TS) — AE исполняет один скрипт за раз.
- **Атомарная запись**: обе стороны пишут через `.tmp` + rename.
- **Undo-группа и подавление диалогов** на каждый запрос
  (`app.beginUndoGroup` / `app.beginSuppressDialogs`), отключается полями
  `undo_group` / `suppress_dialogs`.
- **Heartbeat**: сервер различает «мост не жив» (пробует пуш
  `AfterFX.exe -r ae_bridge.jsx`), «AE занят» (busy=true в heartbeat) и
  «мёртвый таймстемп при busy» (долгая операция, ждём дальше).

## Таймауты по умолчанию

| Инструменты | Секунды |
|---|---|
| большинство | 30 |
| `run_script`, `project_import_file`, `project_new` | 120 |
| `frame_render` | 120 |
| `project_open` | 180 |
| `render_start` | 1800 |
| `aerender_render` | 3600 (субпроцесс) |

Переопределение: аргумент `timeout_s` инструмента или `AE_MCP_TIMEOUT`.

## Политики

- `AE_MCP_READONLY=1` — мутирующие инструменты исключаются из `list_tools`
  и блокируются в `call_tool` (23 read-only остаются).
- `run_script` — двойной гейт: скрыт из списка и отвергается при вызове без
  `AE_MCP_ENABLE_EVAL=1`.
- Реестр имён инструментов строгий (`additionalProperties: false`); незнакомое
  имя отклоняется сервером ещё до записи в ящик.
- Граница доверия — папка ящика: кто может писать в неё, тот исполняет код в
  AE. Она лежит в профиле пользователя.

## Почему ExtendScript, а не CEP/UXP

`app.scheduleTask` + файловый IPC не требуют установки расширений, прав
администратора, не ломаются между версиями AE (CEP-движок менялся) и работают
в AE 2021–2026 одинаково. Латентность ~250–400 мс на вызов — незаметно для
агента, зато нулевой порог входа: один jsx-файл, как и задумано.
