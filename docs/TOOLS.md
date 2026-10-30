# Справочник инструментов (95 шт.)

Сгенерировано из `registry/tools.json` — единого контракта для Python- и TypeScript-серверов.

Колонка **Мутирует** — инструмент меняет проект (в режиме `AE_MCP_READONLY=1` такие скрыты).

Селекторы `comp` / `layer` / `item` / `effect` / `mask` — это **id (число) или имя (строка)**.
Цвета — RGB `[r,g,b]` в 0–255 **или** 0–1 (сервер распознаёт автоматически).


## Система и мост (`system`)

| Инструмент | Описание | Мутирует |
|---|---|---|
| `ping` | Check that the After Effects bridge is alive and responding. Returns AE version, open project, bridge uptime and round-trip latency in ms. Use this first when unsure whether After Effects is reachable. | нет |
| `ae_info` | Read-only environment report: AE version and build, bridge version, whether the security preference 'Allow Scripts to Write Files and Access Network' is on, number of open items, available AE features (saveFrameToPng, app.effects, app.fonts), and paths (bridge runtime dir, project file). | нет |
| `get_active_item` | Return the currently active item (comp or footage), selected layers in the active comp and selected properties. Useful to discover what the user is looking at before mutating anything. | нет |
| `menu_command` | Execute an After Effects menu command by numeric id (app.findMenuCommandId / app.executeCommand). Try name first ('Purge All Memory & Disk Cache'); the bridge falls back to the numeric id. Use for commands with no dedicated tool. | да |
| `run_script` | Execute arbitrary ExtendScript code inside After Effects and return the serialized result. Wrap the value you want back in a return statement; the code runs inside (function(){ ... })() so 'return' is legal. Only plain JSON-safe values (numbers, strings, booleans, null, arrays, objects) are returned. DANGEROUS: gated behind AE_MCP_ENABLE_EVAL=1 on the MCP server. | да |
| `help_bridge` | Return installation and troubleshooting instructions for the ae_bridge.jsx resident bridge (no After Effects round-trip, always available). Read this when ping fails to understand how to recover. | нет |

## Проект (`project`)

| Инструмент | Описание | Мутирует |
|---|---|---|
| `project_info` | Full project overview: file path, dirty flag, bits per channel, time display type, item census by type, folder tree and the active item. | нет |
| `project_list_items` | List items in the project panel with id, name, type, folder, path and summary. Filter by type ('comp' \| 'folder' \| 'footage' \| 'solid'), by name substring, or by parent folder id/name. | нет |
| `project_new` | Create a new empty project. If the current project has unsaved changes it is saved first (never discarded silently). | да |
| `project_open` | Open an .aep project file. Missing-footage and save dialogs are suppressed by the bridge; missing footage is reported in the response. | да |
| `project_save` | Save the current project. With 'path' performs Save As (returns the new path); without it saves in place (errors if the project was never saved). | да |
| `project_close` | Close the current project. By default unsaved changes are saved first; set save=false to discard them. | да |
| `project_import_file` | Import a file into the project: image, video, audio, layered PSD/AI (set psd_mode to choose which layers), or an image sequence (set sequence=true and pass the first frame path). Returns the new footage item. | да |
| `project_consolidate` | Merge duplicate footage items pointing at the same file (app.project.consolidateFootage). Returns the number of items removed. | да |
| `project_remove_unused` | Delete all footage items that are not used in any composition (app.project.removeUnusedFootage). Returns the number removed. | да |
| `project_reduce` | Reduce the project to only what is used by the given compositions (app.project.reduceProject). Everything unrelated is deleted - save first! | да |
| `project_set_bit_depth` | Set project bits per channel (8/16/32) via the Project Settings command. | да |

## Элементы и папки (`items`)

| Инструмент | Описание | Мутирует |
|---|---|---|
| `item_rename` | Rename any project item (comp, footage, folder) by id or current name. | да |
| `item_delete` | Delete a project item. Comps delete only themselves; footage in use may still be deleted (check usages first with project_list_items if unsure). | да |
| `folder_create` | Create a folder in the project panel, optionally inside another folder. | да |
| `item_move` | Move an item into a folder (or to the project root with folder='root'). | да |

## Композиции (`comps`)

| Инструмент | Описание | Мутирует |
|---|---|---|
| `comp_create` | Create a new composition. Returns its summary (id, name, size, duration, fps, background color). | да |
| `comp_list` | List every composition in the project with id, name, size, duration, fps and layer count. | нет |
| `comp_info` | Detailed info about one composition: settings, work area, motion blur, markers, and a layer summary list (index, name, type, enabled, timing). | нет |
| `comp_set_settings` | Change composition settings: width/height (pair only), pixel aspect, duration, frame rate, background color, motion blur, shutter angle/phase, and the work area. | да |
| `comp_duplicate` | Duplicate a composition. The duplicate gets '-copy' in its name unless new_name is given. Duplicate layers keep their sources (not shared). | да |
| `comp_delete` | Delete a composition from the project. | да |
| `comp_precompose` | Pre-compose the given layers into a new composition (layer indices or names, 1-based). By default all attributes move (equivalent of 'Move all attributes'). | да |

## Слои (`layers`)

| Инструмент | Описание | Мутирует |
|---|---|---|
| `layer_add_solid` | Add a solid to a composition. Set adjustment=true to create an adjustment layer instead (color is irrelevant then). | да |
| `layer_add_null` | Add a null object layer (100x100 by default) to a composition. | да |
| `layer_add_text` | Add a text layer with content and optional style. 'font' must be the PostScript font name (e.g. 'Montserrat-Bold'); use text_list_fonts to look it up. Supports box text with a fixed box size. | да |
| `layer_add_shape` | Add a shape layer with one shape group: rectangle, ellipse, star or polygon, with fill and optional stroke. | да |
| `layer_add_camera` | Add a camera to a composition and return its layer info. Point of interest defaults to comp center when two_node is used. | да |
| `layer_add_light` | Add a light to a composition: point, spot, parallel or ambient. | да |
| `layer_add_footage` | Add an existing project item (footage, solid, or another comp) as a layer into a composition. | да |
| `layer_duplicate` | Duplicate a layer; the copy sits directly above the original. Optionally rename it and offset its start time. | да |
| `layer_delete` | Delete one or more layers from a composition. | да |
| `layer_list` | List layers of a composition: index, name, type, enabled/solo/lock/shy, 3D flag, parent, timing (start/in/out), label color. | нет |
| `layer_info` | Everything about one layer: type, source dimensions/fps, transform values, flags, timing, parenting, effects list (with matchNames), masks summary, markers, text document, keyframe counts per animated property. | нет |
| `layer_set_flags` | Toggle layer flags: enabled, solo, shy, locked, three_d (3D layer), guide, audio_enabled, motion_blur, adjustment, auto_orient, environment_layer. | да |
| `layer_set_parent` | Parent/unparent a layer. keep_transform=true adjusts the child transform so the layer does not jump (pick-whip style parenting). | да |
| `layer_reorder` | Move a layer within the stacking order: to top/bottom, before/after another layer, or to a specific index. | да |
| `layer_trim` | Set a layer's in/out points and/or start time. All values are seconds in comp time. | да |
| `layer_split` | Split a layer at a given comp time (like Edit > Split Layer): the part before the cut keeps the original timing, the part after is a duplicate. | да |
| `layer_set_quality` | Set layer quality (draft/best) and per-layer motion blur sampling. | да |
| `transform_set` | Set transform values on a layer in one call: position, scale (percent), rotation (degrees), opacity (percent), anchor point, orientation and per-axis X/Y/Z rotation for 3D layers. Values may be scalars or [x,y]/[x,y,z] arrays as appropriate for the property. | да |
| `prop_get` | Read a property's value at a time, its keyframe count, expression, unit and dimension. Path examples: 'Transform.Position', 'Opacity', 'Effects.Gaussian Blur.Blurriness', 'Source Text', 'Marker'. | нет |
| `prop_set` | Set any property by path. Creates a keyframe at 'time_s' if keyframe=true (the property is animated automatically). For Source Text pass a string or {...} TextDocument-like object; for colors pass [r,g,b]. | да |
| `prop_list` | Dump the property tree of a layer (or of a single property subtree): matchName, display name, type, dimension, animated/keyframe counts, current value. Cap depth to keep responses small. | нет |
| `prop_clear` | Remove the expression and/or all keyframes from a property. | да |
| `blend_mode_set` | Set a layer's blending mode: normal, multiply, screen, overlay, add, dissolve, dancing_dissolve, darken, lighten, classic_color_burn, classic_color_dodge, color_burn, color_dodge, hard_light, soft_light, vivid_light, linear_light, pin_light, hard_mix, difference, exclusion, hue, saturation, color, luminosity, stencil_alpha, stencil_luma, silhouette_alpha, silhouette_luma, alpha_add, luminescent_premultiply. | да |
| `track_matte_set` | Set the track matte of a layer: none, alpha, alpha_inverted, luma, luma_inverted. The matte is the layer DIRECTLY ABOVE the target layer. | да |

## Кейфреймы (`keyframes`)

| Инструмент | Описание | Мутирует |
|---|---|---|
| `keyframe_set` | Create or update keyframes on a property. Pass a single time+value or parallel arrays 'times' and 'values' for multi-keyframe animation in one call. Times are seconds; values are scalars, [x,y]/[x,y,z] arrays, or [r,g,b] colors depending on the property. | да |
| `keyframe_remove` | Remove keyframes from a property by 1-based index, by time, by time range, or all of them. | да |
| `keyframe_list` | List all keyframes of a property: index, time, value, interpolation in/out, temporal ease (speed/influence), hold flag and spatial tangents where applicable. | нет |
| `keyframe_set_interpolation` | Set interpolation type and temporal easing of existing keyframes. Interp: linear, bezier, hold, auto_bezier. Ease arrays: per-key [in_speed, in_influence, out_speed, out_influence] or a single value applied to all selected keys. Influences are percent 0.1-100. | да |
| `keyframe_set_spatial` | Set spatial auto-bezier/linear/tangent behavior of keyframes on spatial properties (Position, Anchor Point, mask paths). | да |
| `keyframe_shift` | Shift all keyframes of a property (or a time range of them) by a delta in seconds. Negative delta moves earlier. | да |

## Экспрешены (`expressions`)

| Инструмент | Описание | Мутирует |
|---|---|---|
| `expression_set` | Set (or replace) an expression on a property. The response reports the expression error text if AE rejected it. Set expression='' to remove. | да |
| `expression_get` | Read the expression source of a property and its current error text (empty string when the expression evaluates cleanly). | нет |
| `expression_remove` | Remove the expression from a property. | да |
| `expression_scan_errors` | Scan a composition (or the whole project) for properties whose expression has errors and return the list with paths and error texts. | нет |

## Эффекты (`effects`)

| Инструмент | Описание | Мутирует |
|---|---|---|
| `effect_add` | Add an effect to a layer by matchName (e.g. 'ADBE Gaussian Blur 2') or by display name substring (e.g. 'Gaussian Blur'). Optionally set parameters right away: {'Blurriness': 25, 'Repeat Edge Pixels': true}. | да |
| `effect_remove` | Remove one or all effects from a layer by 1-based index or name. | да |
| `effect_list_installed` | List effects available in this AE build with their matchNames and categories (from app.effects on AE 2024+; falls back to a curated common list). Filter by category or name substring. | нет |
| `effect_get_params` | Dump the parameter tree of an effect instance on a layer: each parameter's matchName, display name, type, dimension, value and keyframe count. | нет |
| `effect_set_params` | Set parameters of an effect instance in one call: {'Blurriness': 25, 'Checkbox Control': true, 'Color Control': [255,0,0]} - keys may be display names or matchNames. Values may include {'value': v, 'time_s': t, 'keyframe': true} for keyframed setting. | да |

## Текст (`text`)

| Инструмент | Описание | Мутирует |
|---|---|---|
| `text_set_content` | Replace the content of a text layer (Source Text). Supports multi-line strings. | да |
| `text_set_style` | Update the style of a text layer's Source Text document: font (PostScript name), size, fill/stroke colors, stroke width, tracking, leading, justification, box text size, and baseline shift. | да |
| `text_list_fonts` | List installed fonts (family, style, PostScript name) available to AE. AE 2024+ reads app.fonts; older builds return a common curated list. Filter by family or PostScript name substring. | нет |
| `text_add_animator` | Add an animator group to a text layer: animates one or more of opacity, position, rotation, scale, tracking, fill color, stroke color, blur. A range selector is added with start/end/offset (percent) which can be keyframed afterwards with keyframe_set on path '<animator>.Range Selector.Start'. | да |

## Шейпы (`shapes`)

| Инструмент | Описание | Мутирует |
|---|---|---|
| `shape_add` | Add a shape group to an existing shape layer (or create the layer if 'layer' is omitted). rect \| ellipse \| star \| polygon with fill/stroke. | да |
| `shape_set_fill` | Change the fill of a shape layer group (or of all groups when group is omitted): color and/or opacity. Creates the fill if the group has none. | да |
| `shape_set_stroke` | Change the stroke of a shape layer group (or all groups): color, width, opacity, line cap and line join. Creates the stroke if missing. | да |
| `shape_add_modifier` | Add a path modifier to a shape layer group or layer: trim_paths, round_corners, repeater, wiggle_paths, zig_zag, offset_paths, pucker_bloat, twist, merge_paths. | да |

## Маски (`masks`)

| Инструмент | Описание | Мутирует |
|---|---|---|
| `mask_add` | Add a mask to a layer: rectangle/ellipse from bounds, or a custom Bezier path from vertex + in/out-tangent lists (pixels, layer coordinates). | да |
| `mask_update` | Update an existing mask: mode, inverted, feather, opacity, expansion, bounds (regenerates the path) or vertices/tangents. | да |
| `mask_remove` | Remove one or all masks from a layer. | да |

## Маркеры (`markers`)

| Инструмент | Описание | Мутирует |
|---|---|---|
| `marker_add` | Add a comp marker or a layer marker with comment, chapter, URL, duration and cue-point name. | да |
| `marker_list` | List all markers of a composition (and optionally of its layers): time, duration, comment, chapter, URL, cue point. | нет |
| `marker_remove` | Remove markers by 1-based index, by time (within half a frame) or by comment match - from a comp or a layer. | да |

## Время (`time`)

| Инструмент | Описание | Мутирует |
|---|---|---|
| `time_remap_enable` | Enable Time Remapping on a footage/video layer, optionally seeding it with two keyframes (full duration linear) or an expression. | да |
| `time_stretch` | Change the playback speed of a layer: pass stretch_percent (100 = normal speed, 50 = twice as fast, 200 = half speed) and optionally a new in_point; the out point follows automatically. | да |

## Рендер (`render`)

| Инструмент | Описание | Мутирует |
|---|---|---|
| `render_queue_add` | Add a composition to the Render Queue with an output file. 'format' picks an installed Output Module template by format ('PNG', 'ProRes', 'H264', 'Lossless'...) or set 'output_template' to use it verbatim. | да |
| `render_queue_list` | List render queue items with status, comp, elapsed time and output paths. | нет |
| `render_queue_control` | Start/pause/stop the render queue, or remove items by index. | да |
| `render_start` | Queue a comp with output settings and render it to completion (blocking; the MCP call returns when the render finishes, with per-item status and timing). This is the main 'export a file' tool. | да |
| `frame_render` | Render one or more frames of a composition to PNG for quick visual verification (uses comp.saveFrameToPng; AE 2023+). Returns absolute file paths the agent can open/read. | нет |
| `aerender_render` | Render a project/comp headlessly with aerender.exe (runs OUTSIDE the open AE instance as a subprocess, so it works even while the user keeps editing). Returns the aerender exit code, stdout tail and output paths. | да |

## Футаж (`footage`)

| Инструмент | Описание | Мутирует |
|---|---|---|
| `footage_info` | Details of a footage item: path, dimensions, fps, duration (or still flag), alpha interpretation, audio/video presence, usage count across comps. | нет |
| `footage_replace` | Point a footage item at a different file (relink/swap source) - all layers using it update automatically. | да |
| `footage_reload` | Reload a footage item from disk (after the file changed on disk). | да |
| `footage_interpret` | Set interpretation of a footage item: conform frame rate, loop count, alpha mode and premultiplied color, field order, and 'guess' presets. | да |

## Пакетные операции (`batch`)

| Инструмент | Описание | Мутирует |
|---|---|---|
| `layers_batch` | Execute several tool calls in ONE round-trip and ONE undo group - far faster than N separate calls. Each entry: {'tool': '<tool name>', 'args': {...}}. Every entry runs; per-entry ok/error is returned. Use for building whole scenes (add 10 layers, keyframe 5 properties, ...). | да |
| `undo` | Trigger AE's Undo command (Edit > Undo). Note: each bridge tool call is already one undo group, so this undoes the last tool call as a whole. | да |
