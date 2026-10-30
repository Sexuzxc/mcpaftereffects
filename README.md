# After Effects MCP Server

**Полноценный MCP-сервер, через который ИИ-агент управляет Adobe After Effects:** создание композиций и слоёв, эффекты, кейфреймы, экспрешены, маски, маркеры, шейпы, текст, 3D-камеры и свет, рендер-очередь, preview-кадры, headless-рендер через aerender.

- **95 MCP-инструментов** в 16 доменах — один из самых больших наборов среди AE-MCP-серверов
- **Два сервера на выбор** (или оба): Python и TypeScript — с идентичным набором инструментов
- **Оба транспорта**: `stdio` (Claude Desktop / Cursor / Windsurf / Cline / Claude Code) и streamable HTTP (`--http`)
- **Мост-архитектура «jsx + лаунчер»**: резидентный ExtendScript-скрипт внутри AE + лаунчер на стороне сервера
- Windows · After Effects 2021–2026 · Python 3.10+ / Node 18+

> ⚠️ **Безопасность.** Агент напрямую меняет проект AE. Информация проекта (имена, пути, экспрешены) уходит в ИИ-сервис. Для NDA-проектов проверьте политику сервиса. Первый запуск — на копии проекта. Режим `AE_MCP_READONLY=1` полностью блокирует мутации.

---

## Как это работает

```
┌──────────────┐   stdio / HTTP    ┌───────────────────┐   папка-почтовый ящик   ┌─────────────────────┐
│  MCP-клиент  │ ◄───────────────► │  MCP-сервер        │ ──────────────────────► │ After Effects       │
│ (Claude etc.)│   JSON-RPC 2.0    │  (python | node)   │  commands/request-*.json│  ae_bridge.jsx      │
└──────────────┘                   │  + лаунчер AE      │ ◄────────────────────── │ (app.scheduleTask,  │
                                    └───────────────────┘  results/response-*.json  │  тик 250 мс)        │
                                                                                     └─────────────────────┘
```

1. Сервер пишет `request-<ts>-<id>.json` в `%TEMP%\ae-mcp-bridge\commands\`.
2. Резидентный мост `ae_bridge.jsx` внутри AE (запущен через `Scripts\Startup` либо подкинут лаунчером через `AfterFX.exe -r ae_bridge.jsx`) опрашивает папку каждые 250 мс, **consume-on-read**, исполняет инструмент в **одной undo-группе** с подавленными диалогами и пишет `response-<id>.json`.
3. Сервер ждёт ответ по correlation-ID (таймауты по категориям инструментов) и возвращает результат агенту.

Каждый вызов = одна команда Undo в AE. Ничего не теряется: ID живёт в имени файла, битый запрос всё равно получает коррелированный ответ-ошибку. Сердцебиение (`heartbeat.json` раз в секунду) позволяет серверу отличить «мост не запущен» от «AE занят» и **автоматически поднять мост**.

---

## Требования

| Что | Версия |
|---|---|
| Windows 10/11 | x64 |
| Adobe After Effects | 2021–2026 (frame_render и список эффектов/шрифтов — AE 2023/2024+) |
| Python-сервер | Python 3.10+, `pip install mcp` |
| TypeScript-сервер | Node 18+, `npm install && npm run build` |

**Обязательно** в AE: `Edit > Preferences > Scripting & Expressions > ✅ Allow Scripts to Write Files and Access Network` (установщик пытается включить сам и перезапускает AE).

---

## Установка

```bat
:: 1. клонировать/распаковать проект, затем:
install.bat            :: или: python install.py
```

Установщик без прав администратора:
- копирует `bridge/ae_bridge.jsx` в `%APPDATA%\Adobe\After Effects <ver>\Scripts\Startup\` (автостарт) и в `Scripts\` (ручной запуск),
- включает защитную галку в префах AE (с бэкапом файла),
- ставит Python-зависимости (`mcp`),
- с флагом `--with-node` собирает TypeScript-версию,
- печатает готовые блоки конфигов для клиентов.

## Подключение MCP-клиента

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "after-effects": {
      "command": "python",
      "args": ["C:\\path\\to\\after-effects-mcp-server\\python\\ae_mcp\\server.py"]
    }
  }
}
```

**Claude Code**:

```bash
claude mcp add after-effects -- python "C:\path\to\after-effects-mcp-server\python\ae_mcp\server.py"
```

**Cursor / Windsurf / Cline** (`mcp.json`) — тот же блок `{"command": "python", "args": [...]}`.

**TypeScript-издание:**

```json
{ "command": "node", "args": ["C:\\path\\to\\after-effects-mcp-server\\typescript\\dist\\index.js"] }
```

**HTTP-режим** (удалённые агенты, веб-клиенты):

```bash
python python/ae_mcp/server.py --http --port 8678     # endpoint /mcp, health /health
node typescript/dist/index.js --http --port 8678
```

**Переменные окружения:**

| Переменная | Значение |
|---|---|
| `AE_MCP_READONLY=1` | режим аудита: все мутирующие инструменты скрыты (остаётся 23 read-only) |
| `AE_MCP_ENABLE_EVAL=1` | включить `run_script` — произвольный ExtendScript (по умолчанию выключен!) |
| `AE_MCP_EXE` | путь к `AfterFX.exe`, если AE установлен нестандартно |
| `AE_MCP_RUNTIME_DIR` | свой корень почтового ящика (должен совпадать на обеих сторонах) |
| `AE_MCP_TIMEOUT` | таймаут по умолчанию, сек (30) |
| `AE_AERENDER` | путь к `aerender.exe` |

---

## Каталог инструментов (95)

Полные схемы аргументов — в `registry/tools.json` (генерируется `registry/generate_registry.py`, единый источник для обоих серверов).

**system (6)** — `ping`, `ae_info`, `get_active_item`, `menu_command`, `run_script`*, `help_bridge`
**project (11)** — `project_info`, `project_list_items`, `project_new`, `project_open`, `project_save`, `project_close`, `project_import_file`, `project_consolidate`, `project_remove_unused`, `project_reduce`, `project_set_bit_depth`
**items (4)** — `item_rename`, `item_delete`, `folder_create`, `item_move`
**comps (7)** — `comp_create`, `comp_list`, `comp_info`, `comp_set_settings`, `comp_duplicate`, `comp_delete`, `comp_precompose`
**layers (24)** — `layer_add_solid/null/text/shape/camera/light/footage`, `layer_duplicate/delete/list/info`, `layer_set_flags`, `layer_set_parent`, `layer_reorder`, `layer_trim`, `layer_split`, `layer_set_quality`, `transform_set`, `prop_get/set/list/clear`, `blend_mode_set`, `track_matte_set`
**keyframes (6)** — `keyframe_set` (в т.ч. пачкой times+values), `keyframe_remove`, `keyframe_list`, `keyframe_set_interpolation` (easing), `keyframe_set_spatial`, `keyframe_shift` (с сохранением интерполяции и ease)
**expressions (4)** — `expression_set/get/remove`, `expression_scan_errors`
**effects (5)** — `effect_add` (matchName или поиск по имени + параметры сразу), `effect_remove`, `effect_list_installed` (из `app.effects`, AE 2024+), `effect_get_params`, `effect_set_params`
**text (4)** — `text_set_content`, `text_set_style`, `text_list_fonts` (`app.fonts`, AE 2024+), `text_add_animator`
**shapes (4)** — `shape_add`, `shape_set_fill`, `shape_set_stroke` (в т.ч. дэши), `shape_add_modifier` (trim/repeater/wiggle/…)
**masks (3)** — `mask_add`, `mask_update`, `mask_remove`
**markers (3)** — `marker_add`, `marker_list`, `marker_remove`
**time (2)** — `time_remap_enable`, `time_stretch`
**render (6)** — `render_queue_add/list/control`, `render_start` (блокирующий, до 30 мин), `frame_render` (PNG-превью через `saveFrameToPng`), `aerender_render` (headless-subprocess)
**footage (4)** — `footage_info`, `footage_replace`, `footage_reload`, `footage_interpret`
**batch (2)** — `layers_batch` (пачка вызовов = один undo-групп и один round-trip), `undo`

\* `run_script` появляется в списке только при `AE_MCP_ENABLE_EVAL=1` и дополнительно блокируется на стороне сервера при вызове.

---

## Проверка без After Effects и с ним

```bash
# Эмулятор моста + реальный MCP-клиент (Linux/macOS/Windows):
python tests/test_smoke.py          # Python-сервер, E2E по stdio
cd typescript && npm test           # TypeScript-сервер, E2E по stdio

# Диагностика окружения (пути, heartbeat, exe):
cd python && python -m ae_mcp --status

# Сценарий на РЕАЛЬНОМ AE: создаёт комп с анимацией, эффектами, маркерами
# и рендерит 3 превью-PNG:
cd python && python ../examples/test_scenario.py
```

## Что взято и что исправлено по сравнению с референсами

Проект изучал [Dakkshin/after-effects-mcp](https://github.com/Dakkshin/after-effects-mcp) и [kumoproductions/mcp-aftereffects](https://github.com/kumoproductions/mcp-aftereffects). Оттуда взяты идеи файлового почтового ящика и резидентного агента, но:

| Проблема референсов | Здесь |
|---|---|
| Команды терялись (один слот, статус по длине файла) | correlation-ID в именах файлов, consume-on-read, очередь |
| Большинство вызовов fire-and-forget («вызовите get-results через 5 сек») | каждый вызов ждёт свой ответ по ID |
| `~/Documents` ломался OneDrive | `%TEMP%\ae-mcp-bridge` + `AE_MCP_RUNTIME_DIR` |
| Нет undo-групп, удаление кейфреймов Position при set | undo-группа на вызов, setValue без сноса ключей, update-or-create по полукадру |
| 13 инструментов / 11 инструментов | 95 инструментов с полными JSON-схемами |
| README ≠ код | реестр генерируется и сверяется тестом (95 = 94 в мосте + 1 серверный) |
| Панель с UI (ломается в AE 2025) | без UI: автостарт из Scripts\Startup + пуш лаунчером |
| `eval()` на контенте команды | `JSON.parse` + строгий реестр имён инструментов; произвольный код — только `run_script` за двумя гейтами |

## Структура репозитория

```
after-effects-mcp-server/
├── install.py / install.bat / uninstall.bat   установщик (user-level, без админа)
├── bridge/ae_bridge.jsx          резидентный мост (ES3, ~3500 строк, 94 инструмента)
├── registry/tools.json           единый реестр 95 инструментов + generate_registry.py
├── python/ae_mcp/                Python-сервер: server.py, bridge.py, launcher.py
├── typescript/src/               TypeScript-сервер: index.ts, server.ts, bridge.ts, launcher.ts
├── tests/test_smoke.py           E2E-тест Python-сервера (без AE)
├── typescript/test/smoke.mjs     E2E-тест TS-сервера (без AE)
├── examples/test_scenario.py     сценарий на реальном AE
├── examples/prompts_ru.md        12 готовых промптов для агента
└── docs/TROUBLESHOOTING.md       решения типовых проблем
```

## Лицензия и товарные знаки

MIT. Adobe® и After Effects® — товарные знаки Adobe Inc.; проект не связан с Adobe.
