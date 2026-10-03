"""ModalForge -> Unreal Engine 5 importer.

Run inside the Unreal Editor (Python Editor Script Plugin enabled):
    Tools -> Execute Python Script... -> this file
    or, in the Output Log (Python):  py "C:/path/to/ModalForge_UE_<Surface>_<Shoe>/import_modalforge.py"

It reads manifest.json next to it and, re-runnable at any time:
  1. imports every WAV as a Sound Wave into <contentRoot>/<Surface>/<Shoe>/<Action>/ (replacing older ones),
  2. sets the pack's calibrated Volume and a shared attenuation (ATT_ModalForge_Footstep) on every wave,
  3. creates the Physical Material PM_ModalForge_<Surface> and links it to the Physical Surface of the
     same name if Project Settings -> Physics -> Physical Surface lists one,
  4. if the row struct <contentRoot>/Core/S_ModalForgeFootstepSet exists, creates or updates the DataTable
     <contentRoot>/DT_ModalForge_Footsteps. Rows of earlier packs are kept (merged by row name).
"""

import csv
import io
import json
import os
import sys

import unreal

CONTENT_ROOT = None  # e.g. "/Game/MyGame/Audio/Footsteps"; None = the path stored in manifest.json
ATTENUATION_INNER_CM = 50.0
ATTENUATION_FALLOFF_CM = 2500.0
PITCH_RANGE = (0.96, 1.04)
DT_COLUMNS = ["---", "Surface", "Shoe", "Action", "Sounds", "VolumeMultiplier", "PitchMin", "PitchMax"]


def log(msg):
    unreal.log("[ModalForge] " + msg)


def warn(msg):
    unreal.log_warning("[ModalForge] " + msg)


def pack_dir():
    if "__file__" in globals():
        return os.path.dirname(os.path.abspath(__file__))
    if len(sys.argv) > 1:
        return os.path.abspath(sys.argv[1])
    raise RuntimeError("Run this file with Execute Python Script, or pass the pack folder as an argument.")


def ensure_asset(name, folder, asset_class, factory):
    path = folder + "/" + name
    if unreal.EditorAssetLibrary.does_asset_exist(path):
        return unreal.EditorAssetLibrary.load_asset(path), False
    asset = unreal.AssetToolsHelpers.get_asset_tools().create_asset(name, folder, asset_class, factory)
    return asset, True


def ensure_attenuation(root):
    att, created = ensure_asset("ATT_ModalForge_Footstep", root + "/Core", unreal.SoundAttenuation, unreal.SoundAttenuationFactory())
    if created:  # only on creation: never overwrite the user's tuning
        s = att.get_editor_property("attenuation")
        for prop, value in (("spatialize", True), ("attenuate", True),
                            ("attenuation_shape_extents", unreal.Vector(ATTENUATION_INNER_CM, 0.0, 0.0)),
                            ("falloff_distance", ATTENUATION_FALLOFF_CM)):
            try:
                s.set_editor_property(prop, value)
            except Exception as e:  # property names differ slightly between engine versions
                warn("attenuation: could not set %s (%s)" % (prop, e))
        att.set_editor_property("attenuation", s)
        unreal.EditorAssetLibrary.save_loaded_asset(att)
        log("created " + att.get_path_name())
    return att


def import_waves(pack, manifest, root):
    tasks = []
    for f in manifest["files"]:
        folder, name = f["ue_asset"].rsplit("/", 1)
        if root != manifest["contentRoot"]:
            folder = root + folder[len(manifest["contentRoot"]):]
        t = unreal.AssetImportTask()
        t.set_editor_property("filename", os.path.join(pack, f["file"]).replace("\\", "/"))
        t.set_editor_property("destination_path", folder)
        t.set_editor_property("destination_name", name)
        t.set_editor_property("automated", True)
        t.set_editor_property("replace_existing", True)
        t.set_editor_property("save", False)
        tasks.append((f, folder + "/" + name, t))
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([t for _, _, t in tasks])
    return [(f, path) for f, path, _ in tasks]


def surface_type_named(name):
    try:
        settings = unreal.get_default_object(unreal.PhysicsSettings)
        for entry in settings.get_editor_property("physical_surfaces"):
            if str(entry.get_editor_property("name")) == name:
                return entry.get_editor_property("type")
    except Exception as e:
        warn("could not read Physical Surfaces (%s)" % e)
    return None


def ensure_physical_material(root, surface):
    pm, created = ensure_asset("PM_ModalForge_" + surface, root + "/Core", unreal.PhysicalMaterial, unreal.PhysicalMaterialFactoryNew())
    st = surface_type_named(surface)
    if st is not None:
        pm.set_editor_property("surface_type", st)
        unreal.EditorAssetLibrary.save_loaded_asset(pm)
        log("%s -> Physical Surface '%s'" % (pm.get_path_name(), surface))
    else:
        warn("No Physical Surface named '%s'. Add it in Project Settings -> Physics -> Physical Surface, "
             "then run this script again to link %s." % (surface, pm.get_path_name()))
    if created:
        unreal.EditorAssetLibrary.save_loaded_asset(pm)


def dt_rows(manifest, imported):
    groups = {}
    for f, path in imported:
        groups.setdefault(f["group"], []).append(path + "." + path.rsplit("/", 1)[1])
    s, sh = manifest["surfaceName"], manifest["shoeName"]
    rows = {}
    for group, refs in groups.items():
        key = "%s_%s_%s" % (s, sh, group)
        sounds = "(" + ",".join('"%s"' % r for r in refs) + ")"
        rows[key] = [key, s, sh, group, sounds, "1.0", str(PITCH_RANGE[0]), str(PITCH_RANGE[1])]
    return rows


def update_datatable(root, manifest, imported):
    struct_path = root + "/Core/S_ModalForgeFootstepSet"
    if not unreal.EditorAssetLibrary.does_asset_exist(struct_path):
        warn("Row struct %s not found: DataTable skipped (see README_Unreal.txt)." % struct_path)
        return
    factory = unreal.DataTableFactory()
    factory.set_editor_property("struct", unreal.EditorAssetLibrary.load_asset(struct_path))
    dt, _ = ensure_asset("DT_ModalForge_Footsteps", root, unreal.DataTable, factory)

    # Merged rows live in Saved/ModalForge: every imported pack adds or replaces its own rows.
    store = os.path.join(unreal.Paths.project_saved_dir(), "ModalForge", "DT_ModalForge_Footsteps.csv")
    rows = {}
    if os.path.exists(store):
        with open(store, newline="", encoding="utf-8") as fh:
            for r in list(csv.reader(fh))[1:]:
                if r:
                    rows[r[0]] = r
    rows.update(dt_rows(manifest, imported))
    out = io.StringIO()
    w = csv.writer(out, lineterminator="\n")
    w.writerow(DT_COLUMNS)
    for key in sorted(rows):
        w.writerow(rows[key])
    os.makedirs(os.path.dirname(store), exist_ok=True)
    with open(store, "w", newline="", encoding="utf-8") as fh:
        fh.write(out.getvalue())
    if not unreal.DataTableFunctionLibrary.fill_data_table_from_csv_string(dt, out.getvalue()):
        warn("DataTable import reported problems: check the struct's field names against README_Unreal.txt.")
    unreal.EditorAssetLibrary.save_loaded_asset(dt)
    log("%s: %d rows" % (dt.get_path_name(), len(rows)))


def main():
    pack = pack_dir()
    with open(os.path.join(pack, "manifest.json"), encoding="utf-8") as fh:
        manifest = json.load(fh)
    root = (CONTENT_ROOT or manifest["contentRoot"]).rstrip("/")
    log("importing %s / %s (%d waves) into %s" % (manifest["surface"], manifest["shoe"], len(manifest["files"]), root))

    with unreal.ScopedSlowTask(4, "ModalForge import") as task:
        task.make_dialog()
        task.enter_progress_frame(1, "Attenuation")
        att = ensure_attenuation(root)
        task.enter_progress_frame(1, "Importing waves")
        imported = import_waves(pack, manifest, root)
        volume = float(manifest.get("volume", 1.0))
        missing = 0
        for _, path in imported:
            wave = unreal.EditorAssetLibrary.load_asset(path)
            if wave is None:
                missing += 1
                continue
            wave.set_editor_property("volume", volume)
            wave.set_editor_property("attenuation_settings", att)
            unreal.EditorAssetLibrary.save_loaded_asset(wave)
        if missing:
            warn("%d waves did not import." % missing)
        task.enter_progress_frame(1, "Physical material")
        ensure_physical_material(root, manifest["surfaceName"])
        task.enter_progress_frame(1, "DataTable")
        update_datatable(root, manifest, imported)
    log("done: %d waves, volume %.3f (%s dB)" % (len(imported) - missing, volume, manifest.get("volumeDb")))


main()
