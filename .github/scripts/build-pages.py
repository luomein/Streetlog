"""Copy the public website and generate its published GeoJSON index."""
import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path


DEFAULT_CATEGORY_STYLE = {"stroke": "#007985", "stroke-width": "5px", "stroke-opacity": 0.9}


def classified_geometries(data):
    if not isinstance(data, dict):
        return
    kind = data.get("type")
    if kind == "FeatureCollection":
        features = data.get("features")
        if isinstance(features, list):
            for feature in features:
                yield from classified_geometries(feature)
    elif kind == "Feature":
        properties = data.get("properties")
        name = properties.get("category") if isinstance(properties, dict) else None
        category = name.strip() if isinstance(name, str) and name.strip() else "Uncategorized"
        yield category, data.get("geometry")
    else:
        yield "Uncategorized", data


def extend_bounds(bounds, extent):
    if bounds is None:
        return extent.copy()
    return [min(bounds[0], extent[0]), min(bounds[1], extent[1]),
            max(bounds[2], extent[2]), max(bounds[3], extent[3])]


def geometry_bounds(data):
    """Return [west, south, east, north] from actual positions."""
    bounds = None
    stack = [data]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            kind = node.get("type")
            if kind == "Feature":
                stack.append(node.get("geometry"))
            elif kind in ("FeatureCollection", "GeometryCollection"):
                members = node.get("features" if kind == "FeatureCollection" else "geometries")
                if isinstance(members, list):
                    stack.extend(members)
            else:
                stack.append(node.get("coordinates"))
        elif isinstance(node, list):
            if (len(node) >= 2 and all(type(value) in (int, float) for value in node[:2])):
                longitude, latitude = node[:2]
                if -180 <= longitude <= 180 and -90 <= latitude <= 90:
                    if bounds is None:
                        bounds = [longitude, latitude, longitude, latitude]
                    else:
                        bounds[0] = min(bounds[0], longitude)
                        bounds[1] = min(bounds[1], latitude)
                        bounds[2] = max(bounds[2], longitude)
                        bounds[3] = max(bounds[3], latitude)
            else:
                stack.extend(node)
    return bounds


def index_routes(config, folder, files):
    categories = config.setdefault("categories", [])
    if not isinstance(categories, list):
        raise ValueError("site.json categories must be an array.")
    known = {entry["name"].strip().casefold() for entry in categories
             if isinstance(entry, dict) and isinstance(entry.get("name"), str)}
    default = next((entry["style"] for entry in categories
                    if isinstance(entry, dict) and isinstance(entry.get("name"), str)
                    and entry["name"].strip().casefold() == "uncategorized"
                    and isinstance(entry.get("style"), dict)), DEFAULT_CATEGORY_STYLE)
    added = 0
    bounds = {}
    category_bounds = {}
    for name in files:
        bounds[name] = None
        try:
            data = json.loads((folder / name).read_text(encoding="utf-8-sig"))
        except (OSError, ValueError):
            print(f"Skipping category scan for unreadable GeoJSON: {name!r}")
            continue
        file_categories = {}
        category_bounds[name] = file_categories
        for category, geometry in classified_geometries(data):
            extent = geometry_bounds(geometry)
            if extent is None:
                continue
            bounds[name] = extend_bounds(bounds[name], extent)
            file_categories[category] = extend_bounds(file_categories.get(category), extent)
        for category in file_categories:
            key = category.casefold()
            if key in known:
                continue
            known.add(key)
            categories.append({"name": category, "style": dict(default)})
            added += 1
    print(f"Added {added} categories to the published site.json.")
    return bounds, category_bounds


def build_pages(repository: Path, output: Path) -> None:
    published_source = repository / "docs"
    config_file = repository / "site.json"
    config = json.loads(config_file.read_text(encoding="utf-8"))
    folder_value = config.get("GeoJSON_folder")
    if not isinstance(folder_value, str) or not folder_value.strip():
        raise ValueError("GeoJSON_folder must name a folder inside docs/.")
    relative_folder = Path(folder_value.strip())
    if (relative_folder.is_absolute() or ".." in relative_folder.parts
            or any(character in folder_value for character in "\\:?#%")):
        raise ValueError("GeoJSON_folder must be a relative path inside docs/.")
    if any(path.is_symlink() for path in published_source.rglob("*")):
        raise ValueError("GitHub Pages does not publish symbolic links.")

    shutil.copytree(published_source, output)
    folder = output / relative_folder
    folder.mkdir(parents=True, exist_ok=True)
    names = sorted((file.name for file in folder.iterdir() if file.is_file()),
                   key=lambda name: (name.casefold(), name))
    files = [name for name in names if Path(name).suffix.lower() == ".geojson"]
    source_folder = published_source.relative_to(repository) / relative_folder
    tracked_paths = set(subprocess.check_output(
        ["git", "ls-tree", "-r", "--name-only", "-z", "HEAD", "--", source_folder.as_posix()],
        cwd=repository,
    ).decode("utf-8").split("\0"))
    source_files = [name for name in files if (source_folder / name).as_posix() in tracked_paths]
    image_types = {".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"}
    photos = [name for name in names if Path(name).suffix.lower() in image_types]
    bounds, category_bounds = index_routes(config, folder, files)
    (output / "site.json").write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    manifest = json.dumps({
        "files": files,
        "bounds": bounds,
        "category_bounds": category_bounds,
        "photos": photos,
        "source_branch": os.environ.get("GITHUB_REF_NAME", "main"),
        "source_folder": source_folder.as_posix(),
        "source_files": source_files,
    }, ensure_ascii=False, indent=2) + "\n"
    (folder / "index.json").write_text(manifest, encoding="utf-8")
    print(f"Indexed {len(files)} GeoJSON files and {len(photos)} photos in docs/{relative_folder}/.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    build_pages(Path(__file__).resolve().parents[2], args.output)
