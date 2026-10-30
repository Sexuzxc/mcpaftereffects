#!/usr/bin/env python3
"""Generate registry/tools.json - the single source of truth for every MCP tool
exposed by the After Effects MCP server (Python and TypeScript editions).

Run from the repository root:  python registry/generate_registry.py

The generated file is consumed by:
  - python/ae_mcp/server.py   (low-level mcp Server)
  - typescript/src/server.ts  (@modelcontextprotocol/sdk Server)

Keep tool names, argument names and enum values in sync with bridge/ae_bridge.jsx.
"""
import json
import os
import sys

# --------------------------------------------------------------------------
# Compact schema DSL
# --------------------------------------------------------------------------

def P(t, d, **kw):
    """Scalar / any property."""
    o = {"type": t, "description": d}
    o.update(kw)
    return o


def NA(d, t="number", **kw):
    """Array of numbers (vectors, colors, vertex lists)."""
    return P("array", d, items={"type": t}, **kw)


def NM(d, **kw):
    """Array of strings or numbers (name-or-index selectors)."""
    return P("array", d, items={"type": ["string", "number"]}, **kw)


def SN(d, **kw):
    """String or number (name-or-index selector)."""
    return P(["string", "number"], d, **kw)


def OBJ(d, props, req=None, **kw):
    """Object property with nested properties."""
    o = P("object", d, properties=props, additionalProperties=True, **kw)
    if req:
        o["required"] = list(req)
    return o


TOOLS = []


def T(name, title, desc, domain, mutating=True, props=None, req=None):
    props = props or {}
    schema = {"type": "object", "properties": props, "additionalProperties": False}
    if req:
        schema["required"] = list(req)
    TOOLS.append({
        "name": name,
        "title": title,
        "description": desc,
        "domain": domain,
        "mutating": mutating,
        "inputSchema": schema,
    })


# ==========================================================================
# DOMAIN: system - connection, status, escape hatches
# ==========================================================================

T("ping", "Ping the bridge",
  "Check that the After Effects bridge is alive and responding. Returns AE "
  "version, open project, bridge uptime and round-trip latency in ms. Use this "
  "first when unsure whether After Effects is reachable.",
  "system", mutating=False,
  props={"timeout_s": P("number", "Wait timeout in seconds (default 15).")})

T("ae_info", "AE capabilities info",
  "Read-only environment report: AE version and build, bridge version, whether "
  "the security preference 'Allow Scripts to Write Files and Access Network' is "
  "on, number of open items, available AE features (saveFrameToPng, app.effects, "
  "app.fonts), and paths (bridge runtime dir, project file).",
  "system", mutating=False)

T("get_active_item", "Active item and selection",
  "Return the currently active item (comp or footage), selected layers in the "
  "active comp and selected properties. Useful to discover what the user is "
  "looking at before mutating anything.",
  "system", mutating=False)

T("menu_command", "Execute menu command",
  "Execute an After Effects menu command by numeric id (app.findMenuCommandId / "
  "app.executeCommand). Try name first ('Purge All Memory & Disk Cache'); the "
  "bridge falls back to the numeric id. Use for commands with no dedicated tool.",
  "system",
  props={"command": SN("Menu command name or numeric id."), },
  req=["command"])

T("run_script", "Run ExtendScript",
  "Execute arbitrary ExtendScript code inside After Effects and return the "
  "serialized result. Wrap the value you want back in a return statement; the "
  "code runs inside (function(){ ... })() so 'return' is legal. Only plain "
  "JSON-safe values (numbers, strings, booleans, null, arrays, objects) are "
  "returned. DANGEROUS: gated behind AE_MCP_ENABLE_EVAL=1 on the MCP server.",
  "system",
  props={"code": P("string", "ExtendScript source to evaluate."),
         "timeout_s": P("number", "Wait timeout in seconds (default 120).")},
  req=["code"])

T("help_bridge", "Bridge help",
  "Return installation and troubleshooting instructions for the ae_bridge.jsx "
  "resident bridge (no After Effects round-trip, always available). Read this "
  "when ping fails to understand how to recover.",
  "system", mutating=False)

# ==========================================================================
# DOMAIN: project
# ==========================================================================

T("project_info", "Project info",
  "Full project overview: file path, dirty flag, bits per channel, time display "
  "type, item census by type, folder tree and the active item.",
  "project", mutating=False,
  props={"include_folders": P("boolean", "Include the folder tree (default true).")})

T("project_list_items", "List project items",
  "List items in the project panel with id, name, type, folder, path and "
  "summary. Filter by type ('comp' | 'folder' | 'footage' | 'solid'), by name "
  "substring, or by parent folder id/name.",
  "project", mutating=False,
  props={"type": P("string", "Filter by item type.", enum=["comp", "folder", "footage", "solid"]),
         "name_contains": P("string", "Case-insensitive substring filter on item name."),
         "folder": SN("Only items directly inside this folder (id or name; 'root' = project root)."),
         "limit": P("integer", "Max items to return (default 200).")})

T("project_new", "New project",
  "Create a new empty project. If the current project has unsaved changes it is "
  "saved first (never discarded silently).",
  "project",
  props={"save_current": P("boolean", "Save the current project first if dirty (default true).")})

T("project_open", "Open project",
  "Open an .aep project file. Missing-footage and save dialogs are suppressed "
  "by the bridge; missing footage is reported in the response.",
  "project",
  props={"path": P("string", "Absolute path to the .aep file."),
         "timeout_s": P("number", "Load timeout in seconds (default 180).")},
  req=["path"])

T("project_save", "Save project",
  "Save the current project. With 'path' performs Save As (returns the new "
  "path); without it saves in place (errors if the project was never saved).",
  "project",
  props={"path": P("string", "Absolute target path for Save As.")})

T("project_close", "Close project",
  "Close the current project. By default unsaved changes are saved first; "
  "set save=false to discard them.",
  "project",
  props={"save": P("boolean", "Save changes before closing (default true).")})

T("project_import_file", "Import footage",
  "Import a file into the project: image, video, audio, layered PSD/AI (set "
  "psd_mode to choose which layers), or an image sequence (set sequence=true "
  "and pass the first frame path). Returns the new footage item.",
  "project",
  props={"path": P("string", "Absolute path to the file (or first frame of a sequence)."),
         "sequence": P("boolean", "Import as an image sequence."),
         "psd_mode": P("string", "Layered file import mode.", enum=["footage", "comp", "comp_cropped", "sequence_layers"]),
         "folder": SN("Project-panel folder to place the item in (id or name)."),
         "timeout_s": P("number", "Import timeout in seconds (default 120).")},
  req=["path"])

T("project_consolidate", "Consolidate footage",
  "Merge duplicate footage items pointing at the same file "
  "(app.project.consolidateFootage). Returns the number of items removed.",
  "project")

T("project_remove_unused", "Remove unused footage",
  "Delete all footage items that are not used in any composition "
  "(app.project.removeUnusedFootage). Returns the number removed.",
  "project")

T("project_reduce", "Reduce project",
  "Reduce the project to only what is used by the given compositions "
  "(app.project.reduceProject). Everything unrelated is deleted - save first!",
  "project",
  props={"keep_comps": NM("Comps to keep (names or ids); everything used by them stays.")},
  req=["keep_comps"])

T("project_set_bit_depth", "Set color depth",
  "Set project bits per channel (8/16/32) via the Project Settings command.",
  "project",
  props={"bits": P("integer", "Bits per channel.", enum=[8, 16, 32])},
  req=["bits"])

# ==========================================================================
# DOMAIN: items & folders
# ==========================================================================

T("item_rename", "Rename item",
  "Rename any project item (comp, footage, folder) by id or current name.",
  "items",
  props={"item": SN("Item id or name."),
         "new_name": P("string", "New name.")},
  req=["item", "new_name"])

T("item_delete", "Delete item",
  "Delete a project item. Comps delete only themselves; footage in use may "
  "still be deleted (check usages first with project_list_items if unsure).",
  "items",
  props={"item": SN("Item id or name.")},
  req=["item"])

T("folder_create", "Create folder",
  "Create a folder in the project panel, optionally inside another folder.",
  "items",
  props={"name": P("string", "Folder name."),
         "parent": SN("Parent folder id or name (default: project root).")},
  req=["name"])

T("item_move", "Move item to folder",
  "Move an item into a folder (or to the project root with folder='root').",
  "items",
  props={"item": SN("Item id or name."),
         "folder": SN("Target folder id or name, or 'root'.")},
  req=["item", "folder"])

# ==========================================================================
# DOMAIN: compositions
# ==========================================================================

T("comp_create", "Create composition",
  "Create a new composition. Returns its summary (id, name, size, duration, "
  "fps, background color).",
  "comps",
  props={"name": P("string", "Composition name (unique in project)."),
         "width": P("integer", "Width in pixels (default 1920)."),
         "height": P("integer", "Height in pixels (default 1080)."),
         "pixel_aspect": P("number", "Pixel aspect ratio (default 1.0)."),
         "duration": P("number", "Duration in seconds (default 5)."),
         "frame_rate": P("number", "Frames per second (default 30)."),
         "background_color": NA("Background color, RGB. Use 0-255 values (e.g. [10,20,30]) or 0-1 floats (all <=1)."),
         "folder": SN("Project-panel folder to place the comp in (id or name).")},
  req=["name"])

T("comp_list", "List compositions",
  "List every composition in the project with id, name, size, duration, fps "
  "and layer count.",
  "comps", mutating=False)

T("comp_info", "Composition details",
  "Detailed info about one composition: settings, work area, motion blur, "
  "markers, and a layer summary list (index, name, type, enabled, timing).",
  "comps", mutating=False,
  props={"comp": SN("Comp id or name (default: active comp)."),
         "include_layers": P("boolean", "Include the layer summary (default true).")})

T("comp_set_settings", "Set composition settings",
  "Change composition settings: width/height (pair only), pixel aspect, "
  "duration, frame rate, background color, motion blur, shutter angle/phase, "
  "and the work area.",
  "comps",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "width": P("integer", "New width in pixels."),
         "height": P("integer", "New height in pixels."),
         "pixel_aspect": P("number", "New pixel aspect ratio."),
         "duration": P("number", "New duration in seconds."),
         "frame_rate": P("number", "New frame rate."),
         "background_color": NA("Background color, RGB 0-255 or 0-1 floats."),
         "motion_blur": P("boolean", "Enable/disable motion blur."),
         "shutter_angle": P("number", "Motion blur shutter angle in degrees (1-720)."),
         "shutter_phase": P("number", "Motion blur shutter phase in degrees."),
         "work_area_start": P("number", "Work area start in seconds."),
         "work_area_duration": P("number", "Work area duration in seconds.")})

T("comp_duplicate", "Duplicate composition",
  "Duplicate a composition. The duplicate gets '-copy' in its name unless "
  "new_name is given. Duplicate layers keep their sources (not shared).",
  "comps",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "new_name": P("string", "Name for the duplicate.")})

T("comp_delete", "Delete composition",
  "Delete a composition from the project.",
  "comps",
  props={"comp": SN("Comp id or name (default: active comp).")})

T("comp_precompose", "Pre-compose layers",
  "Pre-compose the given layers into a new composition "
  "(layer indices or names, 1-based). By default all attributes move "
  "(equivalent of 'Move all attributes').",
  "comps",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layers": NM("Layers to precompose: 1-based indices or names."),
         "name": P("string", "Name of the new precomp."),
         "move_all_attributes": P("boolean", "Move all attributes (default true).")},
  req=["layers", "name"])

# ==========================================================================
# DOMAIN: layers
# ==========================================================================

T("layer_add_solid", "Add solid layer",
  "Add a solid to a composition. Set adjustment=true to create an adjustment "
  "layer instead (color is irrelevant then).",
  "layers",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "name": P("string", "Layer name."),
         "color": NA("Solid color RGB 0-255 or 0-1 floats.", default=[128, 128, 128]),
         "width": P("integer", "Solid width in pixels (default: comp width)."),
         "height": P("integer", "Solid height in pixels (default: comp height)."),
         "adjustment": P("boolean", "Make it an adjustment layer."),
         "folder": SN("Project-panel folder for the solid item (id or name).")})

T("layer_add_null", "Add null layer",
  "Add a null object layer (100x100 by default) to a composition.",
  "layers",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "name": P("string", "Layer name (default 'Null')."),
         "width": P("integer", "Null size in pixels (default 100)."),
         "height": P("integer", "Null size in pixels (default 100).")})

T("layer_add_text", "Add text layer",
  "Add a text layer with content and optional style. 'font' must be the "
  "PostScript font name (e.g. 'Montserrat-Bold'); use text_list_fonts to look "
  "it up. Supports box text with a fixed box size.",
  "layers",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "text": P("string", "Text content (\\n for new lines)."),
         "name": P("string", "Layer name (default: the text itself)."),
         "font": P("string", "PostScript font name."),
         "font_size": P("number", "Font size in pixels."),
         "fill_color": NA("Fill color RGB 0-255 or 0-1 floats."),
         "stroke_color": NA("Stroke color RGB 0-255 or 0-1 floats."),
         "stroke_width": P("number", "Stroke width in pixels (0 = no stroke)."),
         "tracking": P("number", "Character tracking."),
         "leading": P("number", "Line leading (0 = auto)."),
         "justification": P("string", "Paragraph justification.",
                            enum=["left", "center", "right", "full_justify", "full_force"]),
         "box_text": P("boolean", "Create paragraph (box) text instead of point text."),
         "box_width": P("number", "Box text width in pixels (with box_text)."),
         "box_height": P("number", "Box text height in pixels (with box_text)."),
         "position": NA("Layer position [x, y] (or [x, y, z])."),
         "start_time": P("number", "Layer start time in seconds.")},
  req=["text"])

T("layer_add_shape", "Add shape layer",
  "Add a shape layer with one shape group: rectangle, ellipse, star or "
  "polygon, with fill and optional stroke.",
  "layers",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "shape_type": P("string", "Shape kind.", enum=["rect", "ellipse", "star", "polygon"], default="rect"),
         "name": P("string", "Layer name."),
         "size": NA("Shape size [width, height] in pixels (default [200,200]).", default=[200, 200]),
         "position": NA("Layer position [x, y] (default comp center)."),
         "roundness": P("number", "Rectangle corner roundness in pixels."),
         "points": P("integer", "Star/polygon point count (default 5)."),
         "outer_radius": P("number", "Star/polygon outer radius (overrides size height/2)."),
         "inner_radius": P("number", "Star inner radius (star only)."),
         "fill_color": NA("Fill color RGB 0-255 or 0-1 floats."),
         "fill_opacity": P("number", "Fill opacity percent 0-100 (default 100)."),
         "stroke_color": NA("Stroke color RGB 0-255 or 0-1 floats."),
         "stroke_width": P("number", "Stroke width in pixels (0 = no stroke, default 0)."),
         "start_time": P("number", "Layer start time in seconds."),
         "three_d": P("boolean", "Make the layer 3D.")},
  req=["shape_type"])

T("layer_add_camera", "Add camera layer",
  "Add a camera to a composition and return its layer info. Point of interest "
  "defaults to comp center when two_node is used.",
  "layers",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "name": P("string", "Camera name."),
         "position": NA("Camera position [x, y, z] (default centered, -comp height)."),
         "point_of_interest": NA("Point of interest [x, y, z] (two-node cameras)."),
         "zoom": P("number", "Zoom in pixels (default 1400)."),
         "two_node": P("boolean", "Two-node camera driven by Point of Interest."),
         "depth_of_field": P("boolean", "Enable depth of field."),
         "focus_distance": P("number", "Focus distance in pixels."),
         "aperture": P("number", "Aperture in pixels."),
         "blur_level": P("number", "DOF blur level percent (default 100).")})

T("layer_add_light", "Add light layer",
  "Add a light to a composition: point, spot, parallel or ambient.",
  "layers",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "name": P("string", "Light name."),
         "light_type": P("string", "Light kind.", enum=["point", "spot", "parallel", "ambient"], default="point"),
         "color": NA("Light color RGB 0-255 or 0-1 floats."),
         "intensity": P("number", "Intensity percent (default 100)."),
         "position": NA("Position [x, y, z] (default comp center)."),
         "falloff": P("number", "Falloff radius in pixels (spot/point)."),
         "casts_shadows": P("boolean", "Casts shadows."),
         "shadow_darkness": P("number", "Shadow darkness percent."),
         "shadow_diffusion": P("number", "Shadow diffusion in pixels.")})

T("layer_add_footage", "Add footage layer",
  "Add an existing project item (footage, solid, or another comp) as a layer "
  "into a composition.",
  "layers",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "item": SN("Project item id or name to add as a layer."),
         "position": NA("Layer position [x, y] (default comp center)."),
         "start_time": P("number", "Layer start time in seconds."),
         "fit_to_comp": P("boolean", "Scale the layer to fit the comp frame.")})

T("layer_duplicate", "Duplicate layer",
  "Duplicate a layer; the copy sits directly above the original. Optionally "
  "rename it and offset its start time.",
  "layers",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name (default: first selected)."),
         "new_name": P("string", "Name for the duplicate."),
         "shift_s": P("number", "Shift the duplicate start time by this many seconds.")})

T("layer_delete", "Delete layer",
  "Delete one or more layers from a composition.",
  "layers",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": NM("Layers to delete: 1-based indices or names.")},
  req=["layer"])

T("layer_list", "List layers",
  "List layers of a composition: index, name, type, enabled/solo/lock/shy, "
  "3D flag, parent, timing (start/in/out), label color.",
  "layers", mutating=False,
  props={"comp": SN("Comp id or name (default: active comp)."),
         "only_matching_type": P("string", "Return only layers of this type.",
                                 enum=["text", "shape", "solid", "null", "camera", "light", "footage", "adjustment", "audio"])})

T("layer_info", "Layer details",
  "Everything about one layer: type, source dimensions/fps, transform values, "
  "flags, timing, parenting, effects list (with matchNames), masks summary, "
  "markers, text document, keyframe counts per animated property.",
  "layers", mutating=False,
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name (default: first selected).")})

T("layer_set_flags", "Set layer flags",
  "Toggle layer flags: enabled, solo, shy, locked, three_d (3D layer), "
  "guide, audio_enabled, motion_blur, adjustment, auto_orient, environment_layer.",
  "layers",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name (default: first selected)."),
         "enabled": P("boolean", "Video/eye switch."),
         "solo": P("boolean", "Solo switch."),
         "shy": P("boolean", "Shy switch."),
         "locked": P("boolean", "Lock switch."),
         "three_d": P("boolean", "3D layer."),
         "guide": P("boolean", "Guide layer."),
         "audio_enabled": P("boolean", "Audio switch."),
         "motion_blur": P("boolean", "Per-layer motion blur."),
         "adjustment": P("boolean", "Adjustment layer (only valid for solids)."),
         "auto_orient": P("string", "Auto-orient mode.",
                          enum=["none", "along_path", "toward_poi", "each_frame"])})

T("layer_set_parent", "Set layer parent",
  "Parent/unparent a layer. keep_transform=true adjusts the child transform so "
  "the layer does not jump (pick-whip style parenting).",
  "layers",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name."),
         "parent": SN("Parent layer 1-based index or name, or 'none' to unparent."),
         "keep_transform": P("boolean", "Adjust child transform so nothing jumps (default true).")})

T("layer_reorder", "Reorder layer",
  "Move a layer within the stacking order: to top/bottom, before/after "
  "another layer, or to a specific index.",
  "layers",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name."),
         "where": P("string", "Where to move it.",
                    enum=["top", "bottom", "before", "after", "index"], default="top"),
         "reference": SN("Reference layer for before/after."),
         "index": P("integer", "Target 1-based index for where=index.")})

T("layer_trim", "Trim layer",
  "Set a layer's in/out points and/or start time. All values are seconds in "
  "comp time.",
  "layers",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name."),
         "in_point": P("number", "New in point in seconds."),
         "out_point": P("number", "New out point in seconds."),
         "start_time": P("number", "New start time in seconds.")})

T("layer_split", "Split layer",
  "Split a layer at a given comp time (like Edit > Split Layer): the part "
  "before the cut keeps the original timing, the part after is a duplicate.",
  "layers",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name (default: first selected)."),
         "time_s": P("number", "Split time in seconds (default: current time indicator).")})

T("layer_set_quality", "Set layer quality",
  "Set layer quality (draft/best) and per-layer motion blur sampling.",
  "layers",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": NM("Layers: 1-based indices or names."),
         "quality": P("string", "Quality.", enum=["draft", "best"]),
         "motion_blur_samples": P("integer", "Per-layer motion blur samples (2-64).")})

# ==========================================================================
# DOMAIN: transform & properties
# ==========================================================================

T("transform_set", "Set transform",
  "Set transform values on a layer in one call: position, scale (percent), "
  "rotation (degrees), opacity (percent), anchor point, orientation and "
  "per-axis X/Y/Z rotation for 3D layers. Values may be scalars or [x,y]/[x,y,z] "
  "arrays as appropriate for the property.",
  "layers",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name (default: first selected)."),
         "position": NA("Position [x, y] or [x, y, z]."),
         "scale": NA("Scale percent [x, y] or [x, y, z] (100 = 100%)."),
         "rotation": P("number", "2D rotation in degrees (3D: Z rotation)."),
         "x_rotation": P("number", "X rotation degrees (3D)."),
         "y_rotation": P("number", "Y rotation degrees (3D)."),
         "opacity": P("number", "Opacity percent 0-100."),
         "anchor_point": NA("Anchor point [x, y] or [x, y, z]."),
         "orientation": NA("Orientation degrees [x, y, z] (3D)."),
         "set_keyframe": P("boolean", "Also create a keyframe at the current time for each changed property.")})

T("prop_get", "Get property value",
  "Read a property's value at a time, its keyframe count, expression, unit and "
  "dimension. Path examples: 'Transform.Position', 'Opacity', 'Effects.Gaussian "
  "Blur.Blurriness', 'Source Text', 'Marker'.",
  "layers", mutating=False,
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name (default: first selected)."),
         "path": P("string", "Property path from the layer, '.'-separated (matchName or display name segments)."),
         "time_s": P("number", "Time in seconds (default: current time).")},
  req=["path"])

T("prop_set", "Set property value",
  "Set any property by path. Creates a keyframe at 'time_s' if keyframe=true "
  "(the property is animated automatically). For Source Text pass a string or "
  "{...} TextDocument-like object; for colors pass [r,g,b].",
  "layers",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name (default: first selected)."),
         "path": P("string", "Property path from the layer ('.'-separated)."),
         "value": P(["number", "string", "boolean", "array", "object", "null"], "Value to set."),
         "time_s": P("number", "Keyframe time in seconds (default: current time)."),
         "keyframe": P("boolean", "Create a keyframe instead of setting a static value.")},
  req=["path", "value"])

T("prop_list", "List property tree",
  "Dump the property tree of a layer (or of a single property subtree): "
  "matchName, display name, type, dimension, animated/keyframe counts, current "
  "value. Cap depth to keep responses small.",
  "layers", mutating=False,
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name (default: first selected)."),
         "path": P("string", "Optional subtree root path (e.g. 'Effects' or 'Transform')."),
         "depth": P("integer", "Maximum recursion depth (default 4)."),
         "include_values": P("boolean", "Include current values (default true).")})

T("prop_clear", "Clear property",
  "Remove the expression and/or all keyframes from a property.",
  "layers",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name."),
         "path": P("string", "Property path ('.'-separated)."),
         "remove_expression": P("boolean", "Remove the expression (default true)."),
         "remove_keyframes": P("boolean", "Remove all keyframes.")},
  req=["path"])

T("blend_mode_set", "Set blend mode",
  "Set a layer's blending mode: normal, multiply, screen, overlay, add, "
  "dissolve, dancing_dissolve, darken, lighten, classic_color_burn, "
  "classic_color_dodge, color_burn, color_dodge, hard_light, soft_light, "
  "vivid_light, linear_light, pin_light, hard_mix, difference, exclusion, hue, "
  "saturation, color, luminosity, stencil_alpha, stencil_luma, silhouette_alpha, "
  "silhouette_luma, alpha_add, luminescent_premultiply.",
  "layers",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name."),
         "mode": P("string", "Blend mode name.")},
  req=["mode"])

T("track_matte_set", "Set track matte",
  "Set the track matte of a layer: none, alpha, alpha_inverted, luma, "
  "luma_inverted. The matte is the layer DIRECTLY ABOVE the target layer.",
  "layers",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name."),
         "matte": P("string", "Track matte kind.",
                    enum=["none", "alpha", "alpha_inverted", "luma", "luma_inverted"])},
  req=["matte"])

# ---- PART 2 CONTINUES IN registry_p2.py ----

# ==========================================================================
# DOMAIN: keyframes & animation
# ==========================================================================

T("keyframe_set", "Set keyframes",
  "Create or update keyframes on a property. Pass a single time+value or "
  "parallel arrays 'times' and 'values' for multi-keyframe animation in one "
  "call. Times are seconds; values are scalars, [x,y]/[x,y,z] arrays, or "
  "[r,g,b] colors depending on the property.",
  "keyframes",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name (default: first selected)."),
         "path": P("string", "Property path ('.'-separated)."),
         "time_s": P("number", "Keyframe time in seconds (single-keyframe form)."),
         "value": P(["number", "string", "boolean", "array", "object", "null"], "Keyframe value (single-keyframe form)."),
         "times": NA("Array of keyframe times in seconds (multi form)."),
         "values": P("array", "Array of values, same length as times (multi form)."),
         "interpolation": P("string", "Interpolation for all created keys.",
                            enum=["linear", "bezier", "hold", "auto_bezier"])},
  req=["path"])

T("keyframe_remove", "Remove keyframes",
  "Remove keyframes from a property by 1-based index, by time, by time range, "
  "or all of them.",
  "keyframes",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name."),
         "path": P("string", "Property path ('.'-separated)."),
         "indices": NM("1-based keyframe indices to remove."),
         "time_s": P("number", "Remove the keyframe nearest this time (within 1 frame)."),
         "range": NA("Remove keys with time inside [start, end]."),
         "remove_all": P("boolean", "Remove every keyframe.")},
  req=["path"])

T("keyframe_list", "List keyframes",
  "List all keyframes of a property: index, time, value, interpolation in/out, "
  "temporal ease (speed/influence), hold flag and spatial tangents where "
  "applicable.",
  "keyframes", mutating=False,
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name."),
         "path": P("string", "Property path ('.'-separated).")},
  req=["path"])

T("keyframe_set_interpolation", "Set keyframe interpolation/easing",
  "Set interpolation type and temporal easing of existing keyframes. Interp: "
  "linear, bezier, hold, auto_bezier. Ease arrays: per-key [in_speed, "
  "in_influence, out_speed, out_influence] or a single value applied to all "
  "selected keys. Influences are percent 0.1-100.",
  "keyframes",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name."),
         "path": P("string", "Property path ('.'-separated)."),
         "indices": NM("1-based keyframe indices (default: all keys)."),
         "interpolation": P("string", "Interpolation type.",
                            enum=["linear", "bezier", "hold", "auto_bezier"]),
         "ease_in": NA("Incoming ease: [speed, influence%] per key or flat for all."),
         "ease_out": NA("Outgoing ease: [speed, influence%] per key or flat for all.")},
  req=["path"])

T("keyframe_set_spatial", "Set spatial interpolation",
  "Set spatial auto-bezier/linear/tangent behavior of keyframes on spatial "
  "properties (Position, Anchor Point, mask paths).",
  "keyframes",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name."),
         "path": P("string", "Property path ('.'-separated)."),
         "indices": NM("1-based keyframe indices (default: all keys)."),
         "spatial_auto_bezier": P("boolean", "Smooth (roving) spatial interpolation."),
         "tangent_in": NA("Incoming spatial tangent offset [x, y] (single key only)."),
         "tangent_out": NA("Outgoing spatial tangent offset [x, y] (single key only).")},
  req=["path"])

T("keyframe_shift", "Shift keyframes",
  "Shift all keyframes of a property (or a time range of them) by a delta in "
  "seconds. Negative delta moves earlier.",
  "keyframes",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name."),
         "path": P("string", "Property path ('.'-separated)."),
         "delta_s": P("number", "Shift amount in seconds."),
         "range": NA("Only shift keys with time inside [start, end].")},
  req=["path", "delta_s"])

# ==========================================================================
# DOMAIN: expressions
# ==========================================================================

T("expression_set", "Set expression",
  "Set (or replace) an expression on a property. The response reports the "
  "expression error text if AE rejected it. Set expression='' to remove.",
  "expressions",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name (default: first selected)."),
         "path": P("string", "Property path ('.'-separated)."),
         "expression": P("string", "Expression source; '' removes the expression.")},
  req=["path", "expression"])

T("expression_get", "Get expression",
  "Read the expression source of a property and its current error text "
  "(empty string when the expression evaluates cleanly).",
  "expressions", mutating=False,
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name."),
         "path": P("string", "Property path ('.'-separated).")},
  req=["path"])

T("expression_remove", "Remove expression",
  "Remove the expression from a property.",
  "expressions",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name."),
         "path": P("string", "Property path ('.'-separated).")},
  req=["path"])

T("expression_scan_errors", "Scan expression errors",
  "Scan a composition (or the whole project) for properties whose expression "
  "has errors and return the list with paths and error texts.",
  "expressions", mutating=False,
  props={"comp": SN("Comp id or name (default: scan whole project)."),
         "limit": P("integer", "Max errors to report (default 50).")})

# ==========================================================================
# DOMAIN: effects
# ==========================================================================

T("effect_add", "Add effect",
  "Add an effect to a layer by matchName (e.g. 'ADBE Gaussian Blur 2') or by "
  "display name substring (e.g. 'Gaussian Blur'). Optionally set parameters "
  "right away: {'Blurriness': 25, 'Repeat Edge Pixels': true}.",
  "effects",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name (default: first selected)."),
         "match_name": P("string", "Exact effect matchName (preferred, e.g. 'ADBE Gaussian Blur 2')."),
         "name": P("string", "Effect display name substring (used when match_name is not given)."),
         "params": OBJ("Parameters to set after adding: {name or matchName: value}.", {}),
         "index": P("integer", "Insert position in the effect stack (1-based; default: top of stack).")},
  req=[])

T("effect_remove", "Remove effect",
  "Remove one or all effects from a layer by 1-based index or name.",
  "effects",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name."),
         "effect": SN("Effect 1-based index or name; omit with all=true."),
         "all": P("boolean", "Remove every effect from the layer.")})

T("effect_list_installed", "List installed effects",
  "List effects available in this AE build with their matchNames and "
  "categories (from app.effects on AE 2024+; falls back to a curated common "
  "list). Filter by category or name substring.",
  "effects", mutating=False,
  props={"name_contains": P("string", "Case-insensitive substring filter."),
         "category_contains": P("string", "Case-insensitive category filter."),
         "limit": P("integer", "Max rows (default 200).")})

T("effect_get_params", "Get effect parameters",
  "Dump the parameter tree of an effect instance on a layer: each parameter's "
  "matchName, display name, type, dimension, value and keyframe count.",
  "effects", mutating=False,
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name."),
         "effect": SN("Effect 1-based index or name (default: 1).")})

T("effect_set_params", "Set effect parameters",
  "Set parameters of an effect instance in one call: "
  "{'Blurriness': 25, 'Checkbox Control': true, 'Color Control': [255,0,0]} - "
  "keys may be display names or matchNames. Values may include "
  "{'value': v, 'time_s': t, 'keyframe': true} for keyframed setting.",
  "effects",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name."),
         "effect": SN("Effect 1-based index or name (default: 1)."),
         "params": OBJ("Parameters to set.", {})},
  req=["params"])

# ==========================================================================
# DOMAIN: text
# ==========================================================================

T("text_set_content", "Set text content",
  "Replace the content of a text layer (Source Text). Supports multi-line "
  "strings.",
  "text",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Text layer 1-based index or name (default: first selected)."),
         "text": P("string", "New text content."),
         "set_keyframe": P("boolean", "Keyframe the Source Text at the current time.")},
  req=["text"])

T("text_set_style", "Set text style",
  "Update the style of a text layer's Source Text document: font (PostScript "
  "name), size, fill/stroke colors, stroke width, tracking, leading, "
  "justification, box text size, and baseline shift.",
  "text",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Text layer 1-based index or name."),
         "font": P("string", "PostScript font name."),
         "font_size": P("number", "Font size in pixels."),
         "fill_color": NA("Fill color RGB 0-255 or 0-1 floats."),
         "stroke_color": NA("Stroke color RGB 0-255 or 0-1 floats."),
         "apply_fill": P("boolean", "Enable/disable fill."),
         "apply_stroke": P("boolean", "Enable/disable stroke."),
         "stroke_width": P("number", "Stroke width in pixels."),
         "stroke_over_fill": P("boolean", "Paint stroke over fill."),
         "tracking": P("number", "Character tracking."),
         "leading": P("number", "Line leading (0 = auto)."),
         "justification": P("string", "Paragraph justification.",
                            enum=["left", "center", "right", "full_justify", "full_force"]),
         "baseline_shift": P("number", "Baseline shift in pixels."),
         "box_width": P("number", "Box text width (box text only)."),
         "box_height": P("number", "Box text height (box text only)."),
         "set_keyframe": P("boolean", "Keyframe Source Text at the current time after styling.")})

T("text_list_fonts", "List fonts",
  "List installed fonts (family, style, PostScript name) available to AE. "
  "AE 2024+ reads app.fonts; older builds return a common curated list. Filter "
  "by family or PostScript name substring.",
  "text", mutating=False,
  props={"name_contains": P("string", "Case-insensitive substring filter."),
         "limit": P("integer", "Max rows (default 100).")})

T("text_add_animator", "Add text animator",
  "Add an animator group to a text layer: animates one or more of opacity, "
  "position, rotation, scale, tracking, fill color, stroke color, blur. A "
  "range selector is added with start/end/offset (percent) which can be "
  "keyframed afterwards with keyframe_set on path '<animator>.Range "
  "Selector.Start'.",
  "text",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Text layer 1-based index or name."),
         "properties": NM("Animated properties.",
                          enum=["opacity", "position", "rotation", "scale", "tracking",
                                "fill_color", "stroke_color", "blur"]),
         "values": OBJ("Start values for the chosen properties "
                       "({'opacity': 0, 'tracking': 50, ...}).", {}),
         "animator_name": P("string", "Name of the animator group (default 'Animator 1')."),
         "range_start": P("number", "Range selector start percent (default 0)."),
         "range_end": P("number", "Range selector end percent (default 100)."),
         "range_offset": P("number", "Range selector offset percent (default 0)."),
         "shape": P("string", "Range selector shape.", enum=["square", "ramp_up", "ramp_down", "triangle", "round", "smooth"], default="square")},
  req=["properties"])

# ==========================================================================
# DOMAIN: shapes
# ==========================================================================

T("shape_add", "Add shape group",
  "Add a shape group to an existing shape layer (or create the layer if "
  "'layer' is omitted). rect | ellipse | star | polygon with fill/stroke.",
  "shapes",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Shape layer 1-based index or name (default: first shape layer, else new layer)."),
         "shape_type": P("string", "Shape kind.", enum=["rect", "ellipse", "star", "polygon"], default="rect"),
         "group_name": P("string", "Group name (default 'Group N')."),
         "size": NA("Shape size [width, height] in pixels (default [200,200]).", default=[200, 200]),
         "position": NA("Group position [x, y] within the layer (default [0,0])."),
         "roundness": P("number", "Rectangle corner roundness in pixels."),
         "points": P("integer", "Star/polygon point count."),
         "outer_radius": P("number", "Star/polygon outer radius."),
         "inner_radius": P("number", "Star inner radius."),
         "fill_color": NA("Fill color RGB 0-255 or 0-1 floats (omit to keep no fill on this group)."),
         "fill_opacity": P("number", "Fill opacity percent 0-100."),
         "stroke_color": NA("Stroke color RGB 0-255 or 0-1 floats."),
         "stroke_width": P("number", "Stroke width (0 = no stroke).")},
  req=["shape_type"])

T("shape_set_fill", "Set shape fill",
  "Change the fill of a shape layer group (or of all groups when group is "
  "omitted): color and/or opacity. Creates the fill if the group has none.",
  "shapes",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Shape layer 1-based index or name."),
         "group": SN("Group 1-based index or name (default: all groups)."),
         "color": NA("Fill color RGB 0-255 or 0-1 floats."),
         "opacity": P("number", "Fill opacity percent 0-100.")})

T("shape_set_stroke", "Set shape stroke",
  "Change the stroke of a shape layer group (or all groups): color, width, "
  "opacity, line cap and line join. Creates the stroke if missing.",
  "shapes",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Shape layer 1-based index or name."),
         "group": SN("Group 1-based index or name (default: all groups)."),
         "color": NA("Stroke color RGB 0-255 or 0-1 floats."),
         "width": P("number", "Stroke width in pixels."),
         "opacity": P("number", "Stroke opacity percent 0-100."),
         "line_cap": P("string", "Line cap.", enum=["butt", "round", "projecting"]),
         "line_join": P("string", "Line join.", enum=["miter", "round", "bevel"]),
         "dashes": NA("Dash pattern in pixels (e.g. [20, 14]; empty = solid).")})

T("shape_add_modifier", "Add shape modifier",
  "Add a path modifier to a shape layer group or layer: trim_paths, "
  "round_corners, repeater, wiggle_paths, zig_zag, offset_paths, pucker_bloat, "
  "twist, merge_paths.",
  "shapes",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Shape layer 1-based index or name."),
         "group": SN("Group 1-based index or name (default: layer level)."),
         "modifier": P("string", "Modifier kind.",
                       enum=["trim_paths", "round_corners", "repeater", "wiggle_paths",
                             "zig_zag", "offset_paths", "pucker_bloat", "twist", "merge_paths"]),
         "params": OBJ("Modifier parameters, e.g. {'Start':0,'End':50,'Offset':25} for "
                       "trim_paths, {'Copies':3,'Offset Position':[50,0]} for repeater.", {})},
  req=["modifier"])

# ==========================================================================
# DOMAIN: masks
# ==========================================================================

T("mask_add", "Add mask",
  "Add a mask to a layer: rectangle/ellipse from bounds, or a custom Bezier "
  "path from vertex + in/out-tangent lists (pixels, layer coordinates).",
  "masks",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name (default: first selected)."),
         "shape_type": P("string", "Mask kind.", enum=["rect", "ellipse"], default="rect"),
         "bounds": NA("Bounding box [left, top, width, height] in layer coordinates."),
         "vertices": P("array", "Custom path: array of [x, y] vertices."),
         "in_tangents": P("array", "Array of [x, y] in-tangents (same length as vertices)."),
         "out_tangents": P("array", "Array of [x, y] out-tangents (same length as vertices)."),
         "closed": P("boolean", "Close the path (default true)."),
         "mask_mode": P("string", "Mask mode.",
                        enum=["add", "subtract", "intersect", "lighten", "darken", "difference", "none"], default="add"),
         "inverted": P("boolean", "Invert the mask."),
         "feather": NA("Feather [x, y] in pixels."),
         "opacity": P("number", "Mask opacity percent 0-100 (default 100)."),
         "expansion": P("number", "Mask expansion in pixels."),
         "mask_name": P("string", "Mask name (default 'Mask N').")},
  req=[])

T("mask_update", "Update mask",
  "Update an existing mask: mode, inverted, feather, opacity, expansion, "
  "bounds (regenerates the path) or vertices/tangents.",
  "masks",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name."),
         "mask": SN("Mask 1-based index or name (default: 1)."),
         "bounds": NA("New bounding box [left, top, width, height]."),
         "vertices": P("array", "New vertices [[x, y], ...]."),
         "in_tangents": P("array", "New in-tangents [[x, y], ...]."),
         "out_tangents": P("array", "New out-tangents [[x, y], ...]."),
         "mask_mode": P("string", "Mask mode.",
                        enum=["add", "subtract", "intersect", "lighten", "darken", "difference", "none"]),
         "inverted": P("boolean", "Invert."),
         "feather": NA("Feather [x, y] in pixels."),
         "opacity": P("number", "Opacity percent 0-100."),
         "expansion": P("number", "Expansion in pixels."),
         "mask_name": P("string", "Rename the mask.")})

T("mask_remove", "Remove mask",
  "Remove one or all masks from a layer.",
  "masks",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name."),
         "mask": SN("Mask 1-based index or name; omit with all=true."),
         "all": P("boolean", "Remove every mask.")})

# ==========================================================================
# DOMAIN: markers
# ==========================================================================

T("marker_add", "Add marker",
  "Add a comp marker or a layer marker with comment, chapter, URL, duration "
  "and cue-point name.",
  "markers",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "target": P("string", "Where to put the marker.", enum=["comp", "layer"], default="comp"),
         "layer": SN("Layer 1-based index or name (target=layer only)."),
         "time_s": P("number", "Marker time in seconds (default 0)."),
         "comment": P("string", "Marker comment."),
         "chapter": P("string", "Chapter name."),
         "url": P("string", "URL."),
         "duration_s": P("number", "Marker duration in seconds."),
         "cue_point_name": P("string", "Cue point name.")})

T("marker_list", "List markers",
  "List all markers of a composition (and optionally of its layers): time, "
  "duration, comment, chapter, URL, cue point.",
  "markers", mutating=False,
  props={"comp": SN("Comp id or name (default: active comp)."),
         "include_layers": P("boolean", "Also list layer markers (default false).")})

T("marker_remove", "Remove marker",
  "Remove markers by 1-based index, by time (within half a frame) or by "
  "comment match - from a comp or a layer.",
  "markers",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "target": P("string", "Where to remove from.", enum=["comp", "layer"], default="comp"),
         "layer": SN("Layer 1-based index or name (target=layer only)."),
         "indices": NM("1-based marker indices."),
         "time_s": P("number", "Remove the marker nearest this time."),
         "comment_contains": P("string", "Remove every marker whose comment contains this substring.")})

# ==========================================================================
# DOMAIN: time
# ==========================================================================

T("time_remap_enable", "Enable time remap",
  "Enable Time Remapping on a footage/video layer, optionally seeding it with "
  "two keyframes (full duration linear) or an expression.",
  "time",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name."),
         "seed_keyframes": P("boolean", "Add a 2-keyframe linear map over the layer (default true)."),
         "expression": P("string", "Expression to set on Time Remap instead of keyframes.")})

T("time_stretch", "Stretch layer time",
  "Change the playback speed of a layer: pass stretch_percent (100 = normal "
  "speed, 50 = twice as fast, 200 = half speed) and optionally a new "
  "in_point; the out point follows automatically.",
  "time",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "layer": SN("Layer 1-based index or name."),
         "stretch_percent": P("number", "Stretch percent (default 100)."),
         "new_in_point": P("number", "Where the layer starts after stretching (seconds).")})

# ==========================================================================
# DOMAIN: render & preview
# ==========================================================================

T("render_queue_add", "Add comp to render queue",
  "Add a composition to the Render Queue with an output file. 'format' picks "
  "an installed Output Module template by format ('PNG', 'ProRes', 'H264', "
  "'Lossless'...) or set 'output_template' to use it verbatim.",
  "render",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "output_path": P("string", "Absolute output file path (extension sets the container)."),
         "output_template": P("string", "Exact Output Module template name."),
         "format": P("string", "Preferred format family for template lookup.",
                     enum=["png", "exr", "jpg", "tiff", "prores", "h264", "lossless"]),
         "start_time_s": P("number", "Override render start (seconds)."),
         "end_time_s": P("number", "Override render end (seconds)."),
         "sound": P("boolean", "Render audio."),
         "start_render": P("boolean", "Immediately queue + start rendering (default false).")},
  req=["output_path"])

T("render_queue_list", "List render queue",
  "List render queue items with status, comp, elapsed time and output paths.",
  "render", mutating=False)

T("render_queue_control", "Control render queue",
  "Start/pause/stop the render queue, or remove items by index.",
  "render",
  props={"action": P("string", "What to do.", enum=["start", "pause", "stop", "remove_item"]),
         "item_index": P("integer", "Queue item index (1-based) for remove_item.")},
  req=["action"])

T("render_start", "Render now",
  "Queue a comp with output settings and render it to completion (blocking; "
  "the MCP call returns when the render finishes, with per-item status and "
  "timing). This is the main 'export a file' tool.",
  "render",
  props={"comp": SN("Comp id or name (default: active comp)."),
         "output_path": P("string", "Absolute output file path."),
         "output_template": P("string", "Exact Output Module template name."),
         "format": P("string", "Preferred format family for template lookup.",
                     enum=["png", "exr", "jpg", "tiff", "prores", "h264", "lossless"]),
         "start_time_s": P("number", "Override render start (seconds)."),
         "end_time_s": P("number", "Override render end (seconds)."),
         "sound": P("boolean", "Render audio."),
         "timeout_s": P("number", "Render timeout in seconds (default 1800).")},
  req=["output_path"])

T("frame_render", "Render preview frame",
  "Render one or more frames of a composition to PNG for quick visual "
  "verification (uses comp.saveFrameToPng; AE 2023+). Returns absolute file "
  "paths the agent can open/read.",
  "render", mutating=False,
  props={"comp": SN("Comp id or name (default: active comp)."),
         "times_s": NA("Frame times in seconds (default: [current time])."),
         "output_dir": P("string", "Directory for PNGs (default: <runtime>/previews)."),
         "scale_percent": P("number", "Reserved for future use; frames render at comp size.")},
  req=[])

T("aerender_render", "Render via aerender",
  "Render a project/comp headlessly with aerender.exe (runs OUTSIDE the open "
  "AE instance as a subprocess, so it works even while the user keeps "
  "editing). Returns the aerender exit code, stdout tail and output paths.",
  "render",
  props={"project_path": P("string", "Absolute .aep path (default: the open project file, saved first)."),
         "comp": SN("Comp name or index inside the project ('-comp')."),
         "output_path": P("string", "Output file path pattern ('-output')."),
         "output_template": P("string", "Output module template ('-OMtemplate')."),
         "render_settings_template": P("string", "Render settings template ('-RStemplate')."),
         "start_frame": P("integer", "First frame number."),
         "end_frame": P("integer", "Last frame number."),
         "timeout_s": P("number", "Kill aerender after this many seconds (default 3600).")})

# ==========================================================================
# DOMAIN: footage
# ==========================================================================

T("footage_info", "Footage details",
  "Details of a footage item: path, dimensions, fps, duration (or still flag), "
  "alpha interpretation, audio/video presence, usage count across comps.",
  "footage", mutating=False,
  props={"item": SN("Footage item id or name.")},
  req=["item"])

T("footage_replace", "Replace footage",
  "Point a footage item at a different file (relink/swap source) - all layers "
  "using it update automatically.",
  "footage",
  props={"item": SN("Footage item id or name."),
         "path": P("string", "Absolute path of the new file."),
         "sequence": P("boolean", "Treat the new file as an image sequence.")},
  req=["item", "path"])

T("footage_reload", "Reload footage",
  "Reload a footage item from disk (after the file changed on disk).",
  "footage",
  props={"item": SN("Footage item id or name.")},
  req=["item"])

T("footage_interpret", "Interpret footage",
  "Set interpretation of a footage item: conform frame rate, loop count, "
  "alpha mode and premultiplied color, field order, and 'guess' presets.",
  "footage",
  props={"item": SN("Footage item id or name."),
         "conform_fps": P("number", "Conform frame rate (0 = keep)."),
         "loops": P("integer", "Loop count (0 = keep)."),
         "alpha_mode": P("string", "Alpha interpretation.",
                         enum=["ignore", "straight", "premultiplied", "guess"]),
         "premultiplied_color": NA("Matte color RGB 0-255 or 0-1 floats (premultiplied mode)."),
         "field_order": P("string", "Separate fields order.",
                          enum=["off", "upper_first", "lower_first"]),
         "guess_frame_rate": P("boolean", "Try 'Guess' frame rate before applying conform_fps.")},
  req=["item"])

# ==========================================================================
# DOMAIN: batch & convenience
# ==========================================================================

T("layers_batch", "Batch operations (one undo group)",
  "Execute several tool calls in ONE round-trip and ONE undo group - far "
  "faster than N separate calls. Each entry: {'tool': '<tool name>', 'args': "
  "{...}}. Every entry runs; per-entry ok/error is returned. Use for building "
  "whole scenes (add 10 layers, keyframe 5 properties, ...).",
  "batch",
  props={"operations": P("array", "List of {'tool', 'args'} entries.",
                          items=OBJ("Operation entry.", {"tool": P("string", "Tool name."),
                                                         "args": OBJ("Tool arguments.", {})}, ["tool"])),
         "continue_on_error": P("boolean", "Keep running after a failed entry (default true).")},
  req=["operations"])

T("undo", "Undo last operation",
  "Trigger AE's Undo command (Edit > Undo). Note: each bridge tool call is "
  "already one undo group, so this undoes the last tool call as a whole.",
  "batch")

# ==========================================================================
# Emit
# ==========================================================================

def main(out_path):
    # sanity checks
    names = [t["name"] for t in TOOLS]
    if len(names) != len(set(names)):
        dupes = sorted({n for n in names if names.count(n) > 1})
        raise SystemExit("duplicate tool names: %s" % dupes)
    for t in TOOLS:
        req = t["inputSchema"].get("required", [])
        props = t["inputSchema"]["properties"]
        missing = [r for r in req if r not in props]
        if missing:
            raise SystemExit("tool %s: required args not declared: %s" % (t["name"], missing))
    doc = {
        "server": "after-effects-mcp",
        "version": "1.0.0",
        "bridge_version": 1,
        "count": len(TOOLS),
        "tools": TOOLS,
    }
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("wrote %s: %d tools" % (out_path, len(TOOLS)))
    by_domain = {}
    for t in TOOLS:
        by_domain.setdefault(t["domain"], []).append(t["name"])
    for d in sorted(by_domain):
        print("  %-12s %2d  %s" % (d, len(by_domain[d]), ", ".join(by_domain[d])))


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here) if os.path.basename(here) == "registry" else here
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(root, "registry", "tools.json")
    out = os.path.abspath(out)
    main(out)
