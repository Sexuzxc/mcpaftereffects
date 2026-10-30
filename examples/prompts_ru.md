# Готовые промпты для ИИ-агента (After Effects MCP)

Скопируйте любой блок в чат с агентом, у которого подключён этот MCP-сервер.
Перед первым запуском полезно спросить: «вызови ping и покажи статус After Effects».

---

## 1. Диагностика подключения

```
Проверь связь с After Effects: вызови ping, ae_info и project_info.
Скажи: какая версия AE, открыт ли проект, включена ли галка
"Allow Scripts to Write Files and Access Network".
```

## 2. Интро-заставка «с нуля»

```
Создай комп "Intro" 1920x1080, 30fps, 5 секунд, тёмно-синий фон [16,18,34].
Добавь текст "YOUR LOGO" (Arial-Black, 120px, белый, по центру).
Анимирай: scale 40% → 108% → 100% за 1.2 секунды (bezier, ease 85%),
opacity 0→100 за первые 0.5с. Добавь Glow и Drop Shadow.
Поставь комп-маркеры "in" на 0с и "out" на 4.5с.
В конце отрисуй превью-кадры на 0.3с, 0.8с и 2с через frame_render
и скажи, куда сохранились PNG.
```

## 3. Слайд-шоу из папки с фото

```
Импортируй все jpg из папки C:/Users/USER/Pictures/vacation как
image sequence не надо — по одному файлу (project_import_file для каждого).
Создай комп Slideshow 1920x1080, 30fps, длительность = количество_фото * 3с.
Добавь каждое фото слоем, каждому слою: in_point = (i-1)*3, out_point = i*3+1,
scale подгон под комп (fit_to_comp), и прозрачность 100 на входе с keyframe
0→100 за 0.4с. Отсортируй слои как надо и перечисли итог layer_list.
```

## 4. Аудит и чистка проекта

```
Сделай ревизию проекта (только чтение): project_info, comp_list,
project_list_items. Найди: дубликаты футажей, футаж вне использования,
компы-пустышки без слоёв. Покажи таблицу и предложи, что удалить.
Ничего не удаляй без моего подтверждения.
```

## 5. Массовая анимация через layers_batch

```
В компе "Titles" для КАЖДОГО текстового слоя (найди их через layer_list):
- in_point = 0.5 * (индекс слоя), out_point = in_point + 2
- opacity keyframes: 0 на in_point, 100 через 0.4с
- position сдвиг на 40px вверх между этими же ключами
Сделай всё ОДНИМ вызовом layers_batch (перечисли операции заранее),
потом проверь результат expression_scan_errors и frame_render на середину.
```

## 6. Экспрешен-контроллер

```
Создай комп ControllerTest: null-слой "CTRL" и 3 шейп-слоя "Ball 1..3".
Каждому Ball добавь expression на Position с вялым следованием за CTRL:
  w = thisComp.layer("CTRL").transform.position;
  delay = 0.12 * (index - 1);
  wiggle(0,0) // заглушка
  ... лучше: add + valueAtTime(time - delay)
CTRL поставь keyframes позиции по кругу (4 точки, bezier).
Проверь expression_scan_errors, что ошибок нет.
```

## 7. Рендер через очередь

```
Комп "Final" добавь в render queue: output
D:/Renders/final_####.png, формат png, диапазон 0–5 секунд.
Потом запусти render_start с timeout 900 и доложи статус, путь
файлов и сколько секунд длился рендер.
```

## 8. Headless-рендер aerender (пока AE открыт)

```
Сохрани текущий проект (project_save), затем вызови aerender_render
с comp "Final" и output D:/Renders/aerender_####.png.
Доложи exit code и хвост stdout.
```

## 9. Замена исходников (relink)

```
Футаж "old_shot_v1.mov" замени на D:/Footage/old_shot_v2.mov
(footage_replace), проверь footage_info нового пути и перечисли
все слои, которые используют этот футаж (project_list_items +
layer_list по компам).
```

## 10. Титры с аниматором

```
Создай текстовый слой "ЭПИЗОД 01" (Montserrat-Bold, если есть —
проверь через text_list_fonts). Добавь text_add_animator: opacity 0,
range selector ramp_up. Анимирай Range Selector.Start keyframes
0% → 100% за 1 секунду. Сверху добавь tracking-аниматор от 50 к 0.
```

## 11. Режим «только чтение» (аудит чужого проекта)

```
(сервер запущен с AE_MCP_READONLY=1)
Разбери проект: все компы, слои, эффекты, кейфреймы, маркеры.
Составь отчёт: структура, потенциальные проблемы (выключенные слои,
ошибки экспрешенов через expression_scan_errors, огромные компы).
```

## 12. Продакшен-пайплайн

```
1) project_new (сохранив текущий), 2) folder_create "Assets" и "Comps",
3) импорт футажей из D:/Shots/, 4) комп "Master" 3840x2160 25fps 60с,
5) подкомпы по секциям, 6) маркеры по таймлайну, 7) project_save_as
D:/Projects/master_v001.aep. Делай шаги через layers_batch где можно,
докладывай прогресс после каждого шага.
```

---

### Советы агенту (можно скопировать в начало системного промпта)

- Перед мутациями всегда `ping` + `project_info`; работайте с активным компом осознанно.
- Много операций — через `layers_batch` (один undo-групп, один round-trip).
- Точные matchName эффектов — через `effect_list_installed`, шрифтов — `text_list_fonts`.
- Свойства по пути: `Transform.Position`, `Effects.Gaussian Blur.Blurriness` — сначала `prop_list`.
- Превью изменений — `frame_render` (PNG), финальный вывод — `render_start`/`aerender_render`.
- Ошибки моста: читайте `error.hint`, в `/tmp` (или `%TEMP%`) лежит `ae-mcp-bridge/bridge.log`.
