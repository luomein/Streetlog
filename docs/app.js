"use strict";

const byId = id => document.getElementById(id);
const record = byId("record");
const dropPin = byId("drop-pin");
const locate = byId("locate");
const exportButton = byId("export");
const status = byId("status");
const hint = byId("hint");
const storagePrefix = "streetlog.outing.";
const gpsOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 };
const routingAttribution = 'Routing by <a href="https://routing.openstreetmap.de/about.html">FOSSGIS</a> · <a href="https://www.openstreetmap.org/fixthemap">Fix the map</a>';
const defaultHint = hint.textContent;

const matchBatchSize = 10;
let nextMatchRequest = 0;
const routingURL = "https://routing.openstreetmap.de/routed-foot/";

async function requestRouting(path) {
  const now = Date.now();
  const requestAt = Math.max(now, nextMatchRequest);
  nextMatchRequest = requestAt + 1000;
  if (requestAt > now) await new Promise(resolve => setTimeout(resolve, requestAt - now));
  const response = await fetch(routingURL + path, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("Routing service unavailable");
  return response.json();
}

// Keep the straight-line approximation within five meters and limit point
// spacing so the matcher still gets observations near nearby streets.
function matchAnchorIndices(coordinates, includeEnd = true, limit = Infinity) {
  if (coordinates.length < 2) return coordinates.map((_, index) => index);

  const anchors = [0];
  let start = 0;
  for (let end = 1; end < coordinates.length; end++) {
    const [lng, lat] = coordinates[start];
    const metersPerLongitude = 111320 * Math.cos(lat * Math.PI / 180);
    const offsetMeters = point => [
      (((point[0] - lng + 540) % 360) - 180) * metersPerLongitude,
      (point[1] - lat) * 111320
    ];
    const [dx, dy] = offsetMeters(coordinates[end]);
    const lengthSquared = dx * dx + dy * dy;
    let preserve = !Number.isFinite(lengthSquared) || lengthSquared > 35 ** 2 || end - start > 32;
    if (!preserve && end - start >= 2) {
      const [cornerX, cornerY] = offsetMeters(coordinates[end - 1]);
      const [beforeX, beforeY] = offsetMeters(coordinates[end - 2]);
      const [ax, ay] = [cornerX - beforeX, cornerY - beforeY];
      const [bx, by] = [dx - cornerX, dy - cornerY];
      const incoming = Math.hypot(ax, ay);
      const outgoing = Math.hypot(bx, by);
      preserve = incoming >= 4.5 && outgoing >= 4.5 &&
        ax * bx + ay * by < incoming * outgoing * Math.SQRT1_2;
    }
    if (!preserve) {
      for (let index = start + 1; index < end; index++) {
        const [px, py] = offsetMeters(coordinates[index]);
        const projection = lengthSquared ? Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared)) : 0;
        if (!Number.isFinite(px + py) || Math.hypot(px - projection * dx, py - projection * dy) > 5) {
          preserve = true;
          break;
        }
      }
    }
    if (preserve) {
      start = Math.max(start + 1, end - 1);
      anchors.push(start);
      if (anchors.length === limit) return anchors;
      if (start < end) end = start;
    }
  }
  const last = coordinates.length - 1;
  if (includeEnd && anchors.at(-1) !== last) anchors.push(last);
  return anchors;
}

function streetMatchMark(value) {
  return value?.type === "Feature" ? value.properties ?? {} : value ?? {};
}

function lineMatchStatuses(geometry, mark = geometry) {
  const count = geometry.type === "LineString" ? 1 : geometry.coordinates.length;
  if (mark?.streetSnapped === true) return Array(count).fill(true);
  const statuses = mark?.streetSnappedParts;
  return Array.from({ length: count }, (_, index) => statuses?.[index] === true);
}

function countMatchBatches(geometry, anchorsFor, mark = streetMatchMark(geometry)) {
  if (mark.streetSnapped === true) return 0;
  switch (geometry?.type) {
    case "FeatureCollection":
      return geometry.features.reduce((sum, child) => sum + countMatchBatches(child, anchorsFor), 0);
    case "Feature":
      return countMatchBatches(geometry.geometry, anchorsFor, { ...geometry.geometry, ...mark });
    case "GeometryCollection":
      return geometry.geometries.reduce((sum, child) => sum + countMatchBatches(child, anchorsFor), 0);
    case "MultiLineString":
    case "LineString": {
      const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
      const statuses = lineMatchStatuses(geometry, mark);
      return lines.reduce((sum, line, index) => sum + (statuses[index] ? 0 :
        Math.max(0, Math.ceil((anchorsFor(line).length - 1) / (matchBatchSize - 1)))), 0);
    }
    default:
      return 0;
  }
}

function containsSnappedRoute(data) {
  const mark = streetMatchMark(data);
  if (mark.streetSnapped === true || (Array.isArray(mark.streetSnappedParts) && mark.streetSnappedParts.includes(true))) return true;
  if (data?.type === "Feature") return containsSnappedRoute(data.geometry);
  if (data?.type === "FeatureCollection") return data.features.some(containsSnappedRoute);
  if (data?.type === "GeometryCollection") return data.geometries.some(containsSnappedRoute);
  return false;
}

async function matchStreetGeometry(data, cache, onProgress) {
  const anchorsByLine = new WeakMap();
  function anchorsFor(coordinates) {
    if (!anchorsByLine.has(coordinates)) anchorsByLine.set(coordinates, matchAnchorIndices(coordinates));
    return anchorsByLine.get(coordinates);
  }
  const total = onProgress ? countMatchBatches(data, anchorsFor) : 0;
  if (total) onProgress(0, total);
  let matched = 0;
  let unmatched = 0;

  async function matchLine(coordinates) {
    const lines = [];
    const anchors = anchorsFor(coordinates);
    // Overlap chunks by one anchor so adjacent requests share an endpoint.
    for (let start = 0; start < anchors.length - 1; start += matchBatchSize - 1) {
      const batch = anchors.slice(start, start + matchBatchSize);
      const points = batch.map(index => coordinates[index]);
      try {
        const positions = points.map(([lng, lat]) => {
          if (!Number.isFinite(lng) || !Number.isFinite(lat) ||
              Math.abs(lng) > 180 || Math.abs(lat) > 90) throw new Error("Invalid position");
          return [lng.toFixed(6), lat.toFixed(6)].join(",");
        }).join(";");
        const cached = cache?.get(positions);
        if (cached) {
          lines.push({ coordinates: cached, snapped: true });
          matched++;
          continue;
        }
        const radiuses = points.map(() => 20).join(";");
        const result = await requestRouting(
          "match/v1/driving/" + positions + "?geometries=geojson&overview=full&radiuses=" + radiuses
        );
        if (result.code !== "Ok" || result.matchings.length !== 1 ||
            result.tracepoints.length !== points.length || result.tracepoints.some(point => !point)) {
          throw new Error("Incomplete street match");
        }
        const geometry = result.matchings[0].geometry;
        if (geometry?.type !== "LineString" || geometry.coordinates.length < 2) {
          throw new Error("Invalid snapped route");
        }
        cache?.set(positions, geometry.coordinates);
        lines.push({ coordinates: geometry.coordinates, snapped: true });
        matched++;
      } catch {
        lines.push({ coordinates: coordinates.slice(batch[0], batch.at(-1) + 1), snapped: false });
        unmatched++;
      } finally {
        if (total) onProgress(matched + unmatched, total);
      }
    }
    return lines;
  }

  async function visit(value, mark = streetMatchMark(value)) {
    if (!value || mark.streetSnapped === true) return value;
    switch (value.type) {
      case "FeatureCollection": {
        const features = [];
        for (const feature of value.features) features.push(await visit(feature));
        return { ...value, features };
      }
      case "Feature": {
        const geometry = await visit(value.geometry, { ...value.geometry, ...mark });
        if (geometry === value.geometry || geometry?.streetSnapped === undefined) return { ...value, geometry };
        const { streetSnapped, streetSnappedParts, ...geoJSON } = geometry;
        return {
          ...value, geometry: geoJSON, properties: {
            ...value.properties, streetSnapped, streetSnappedParts,
            ...(streetSnappedParts.some(Boolean) && value.geometry.type === "LineString" &&
              !value.properties?.originalCoordinates ? { originalCoordinates: value.geometry.coordinates } : {})
          }
        };
      }
      case "GeometryCollection": {
        const geometries = [];
        for (const geometry of value.geometries) geometries.push(await visit(geometry));
        return { ...value, geometries };
      }
      case "LineString":
      case "MultiLineString": {
        const lines = value.type === "LineString" ? [value.coordinates] : value.coordinates;
        const statuses = lineMatchStatuses(value, mark);
        if (statuses.length && statuses.every(Boolean)) return value;
        const parts = [];
        for (const [index, line] of lines.entries()) {
          if (statuses[index] || line.length < 2) parts.push({ coordinates: line, snapped: statuses[index] });
          else parts.push(...await matchLine(line));
        }
        const streetSnappedParts = parts.map(part => part.snapped);
        return { type: "MultiLineString", coordinates: parts.map(part => part.coordinates),
          streetSnapped: parts.length > 0 && streetSnappedParts.every(Boolean), streetSnappedParts };
      }
      default:
        return value;
    }
  }

  return { data: await visit(data), matched, unmatched };
}

function routePaths(geometry) {
  if (!geometry) return [];
  const { type, coordinates } = geometry;
  if (type === "GeometryCollection") return geometry.geometries.flatMap(routePaths);
  const validPoint = point => Array.isArray(point) &&
    Number.isFinite(point[0]) && Math.abs(point[0]) <= 180 &&
    Number.isFinite(point[1]) && Math.abs(point[1]) <= 90;
  const paths = {
    Point: () => [[coordinates]],
    MultiPoint: () => Array.isArray(coordinates) ? coordinates.map(point => [point]) : [],
    LineString: () => [coordinates],
    MultiLineString: () => Array.isArray(coordinates) ? coordinates : []
  }[type]?.() ?? [];
  return paths.filter(path => Array.isArray(path) && path.length && path.every(validPoint));
}

const uncategorized = "Uncategorized";
const categoryDefaults = { color: "#007985", weight: 5, opacity: 0.9, visible: true };

function categoryName(value) {
  return typeof value === "string" && value.trim() ? value.trim() : uncategorized;
}

function categoryKey(value) {
  return categoryName(value).toLowerCase();
}

function categoryStyle(config, fallback) {
  const number = (value, otherwise, minimum, maximum) => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : otherwise;
  };
  return {
    color: typeof config.color === "string" && /^#[\da-f]{6}$/i.test(config.color) ? config.color : fallback.color,
    weight: number(config.weight, fallback.weight, 1, 12),
    opacity: number(config.opacity, fallback.opacity, 0, 1),
    visible: typeof config.visible === "boolean" ? config.visible : fallback.visible
  };
}

function importedOutingGroups(route) {
  const asFeatures = data => data.type === "FeatureCollection" ? data.features :
    [data.type === "Feature" ? data : { type: "Feature", geometry: data }];
  const original = asFeatures(route.sourceData ?? route.data);
  const groups = new Map();
  asFeatures(route.data).forEach((feature, index) => {
    const paths = routePaths(feature?.geometry);
    if (!paths.length) return;
    const properties = feature.properties ?? {};
    const sourceID = typeof properties.outing === "string" ? properties.outing : "";
    if (!groups.has(sourceID)) {
      groups.set(sourceID, {
        key: JSON.stringify([route.id, sourceID]), routeID: route.id, sourceID,
        name: route.name || properties.name || "Imported route",
        category: categoryName(properties.category),
        segments: [], matchedSegments: [], matchStatuses: [], features: [], snapped: route.snapped
      });
    }
    const group = groups.get(sourceID);
    if (categoryKey(group.category) !== categoryKey(properties.category)) group.category = uncategorized;
    group.features.push(feature);
    const source = original[index]?.geometry;
    const embedded = routePaths({ type: "LineString", coordinates: properties.originalCoordinates });
    const sourceLine = source?.type === "LineString" ? routePaths(source) : [];
    const originalPath = embedded[0] ?? sourceLine[0];
    const preserveOriginal = originalPath?.length > 1 && paths.every(path => path.length > 1);
    const rawPaths = preserveOriginal ? [originalPath] : paths;
    rawPaths.forEach((path, pathIndex) => {
      const metadata = pathIndex === 0 && rawPaths.length === 1;
      group.segments.push(path.map(([lng, lat], pointIndex) => {
        const timestamp = metadata ? properties.timestamps?.[pointIndex] : null;
        const time = typeof timestamp === "string" ? Date.parse(timestamp) : timestamp;
        const accuracy = metadata ? properties.accuracyMeters?.[pointIndex] : null;
        return { lng, lat, time: Number.isFinite(time) ? time : null,
          accuracy: Number.isFinite(accuracy) ? accuracy : null };
      }));
      const moved = preserveOriginal && (paths.length > 1 || JSON.stringify(paths[0]) !== JSON.stringify(path));
      group.matchedSegments.push(moved ? paths : null);
      const mark = { ...feature.geometry, ...properties };
      const statuses = paths.map((_, index) => mark.streetSnapped === true || mark.streetSnappedParts?.[index] === true);
      group.matchStatuses.push(preserveOriginal ? statuses : [statuses[pathIndex]]);
    });
    if (containsSnappedRoute(feature)) group.snapped = true;
  });
  return [...groups.values()].map((group, index) => ({
    ...group, name: groups.size > 1 ? `${group.name} · Outing ${index + 1}` : group.name
  }));
}

async function importedOutingID(group) {
  if (/^(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|import-[a-f0-9]{64})$/i.test(group.sourceID)) {
    return group.sourceID.toLowerCase();
  }
  const key = JSON.stringify([group.sourceID, group.segments.map(segment =>
    segment.map(({ lng, lat }) => [lng, lat]))]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return "import-" + [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function nearestRouteSection(map, point, paths) {
  const target = map.project(point, 16);
  let nearest = null;
  for (const path of paths) {
    for (let index = 1; index < path.length; index++) {
      const start = map.project(path[index - 1], 16);
      const end = map.project(path[index], 16);
      const edge = end.subtract(start);
      const magnitude = edge.x ** 2 + edge.y ** 2;
      if (!magnitude) continue;
      const offset = target.subtract(start);
      const fraction = Math.max(0, Math.min(1, (offset.x * edge.x + offset.y * edge.y) / magnitude));
      const center = map.unproject(start.add(edge.multiplyBy(fraction)), 16);
      const distance = map.distance(point, center);
      if (!nearest || distance < nearest.distance) nearest = { path, index, center, distance };
    }
  }
  if (!nearest || nearest.distance > 50) return null;

  const { path, index, center } = nearest;
  function walk(direction) {
    let previous = center;
    let remaining = 14;
    const points = [];
    for (let i = direction < 0 ? index - 1 : index; i >= 0 && i < path.length; i += direction) {
      const next = L.latLng(path[i]);
      const length = map.distance(previous, next);
      if (length >= remaining) {
        const fraction = remaining / length;
        points.push(L.latLng(previous.lat + (next.lat - previous.lat) * fraction,
          previous.lng + (next.lng - previous.lng) * fraction));
        break;
      }
      points.push(next);
      remaining -= length;
      previous = next;
    }
    return points;
  }
  return { path, center, section: [...walk(-1).reverse(), center, ...walk(1)] };
}

function overlapsViewport(view, [west, south, east, north]) {
  if (north < view.getSouth() || south > view.getNorth()) return false;
  // Leaflet allows continuous panning across repeated copies of the world.
  const shift = 360 * Math.ceil((view.getWest() - east) / 360);
  return west + shift <= view.getEast();
}

function init() {
  if (!window.L) {
    byId("github-repository").textContent = "Streetlog could not load its map. Reload the page to retry.";
    status.textContent = "Map failed to load";
    hint.textContent = "Check your connection and reload.";
    record.disabled = dropPin.disabled = locate.disabled = byId("import").disabled = byId("photos").disabled = true;
    return;
  }

  const mapViewKey = `streetlog.map-view.v1:${location.pathname.replace(/index\.html$/, "")}`;
  const taiwan = [[21.85, 118.05], [26.45, 122.15]];
  const map = L.map("map", { zoomControl: false });
  let savedView;
  try {
    const view = JSON.parse(localStorage.getItem(mapViewKey));
    if (Number.isFinite(view?.lat) && Math.abs(view.lat) <= 90 &&
        Number.isFinite(view.lng) && Math.abs(view.lng) <= 180 &&
        Number.isFinite(view.zoom) && view.zoom >= 0 && view.zoom <= 19) {
      savedView = view;
    }
  } catch {
    // Unavailable or invalid storage falls back to Taiwan.
  }
  if (savedView) {
    map.setView([savedView.lat, savedView.lng], savedView.zoom);
  } else {
    map.fitBounds(taiwan, { padding: [16, 16] });
  }
  map.on("moveend", () => {
    const { lat, lng } = map.wrapLatLng(map.getCenter());
    try {
      localStorage.setItem(mapViewKey, JSON.stringify({ lat, lng, zoom: map.getZoom() }));
    } catch {
      // The map can still be used when storage is unavailable.
    }
  });
  if (window.ResizeObserver) {
    const observer = new ResizeObserver(() => map.invalidateSize({ pan: false }));
    observer.observe(map.getContainer());
  }
  L.control.zoom({ position: "topright" }).addTo(map);
  L.control.scale({ position: "bottomleft", imperial: false }).addTo(map);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    maxZoom: 19
  }).addTo(map);

  let routingAttributed = false;
  const categoryLayers = new Map();
  const categoryConfig = new Map();
  const layerPreferenceKey = "streetlog.category-layers";
  const layerList = byId("category-layers");
  const draftFields = byId("outing-draft");
  const draftCategory = byId("draft-category");
  const localCategoryKey = "streetlog.custom-categories";
  const localCategories = new Set();
  try {
    const names = JSON.parse(localStorage.getItem(localCategoryKey) || "[]");
    if (Array.isArray(names)) {
      for (const name of names) {
        if (typeof name === "string" && name.trim()) localCategories.add(name.trim());
      }
    }
  } catch {
    // Categories can still be created for this visit.
  }
  const categoryDetails = byId("draft-new-category");
  const categoryInput = byId("draft-category-name");
  const categoryStatus = byId("draft-category-status");
  const draftDescription = byId("draft-description");
  const draftExport = byId("export-draft");
  const photoPicker = byId("draft-photo-picker");
  const draftPhotoFiles = byId("draft-photo-files");
  const draftPhotoStatus = byId("draft-photo-status");
  const draftPhotoList = byId("draft-photo-list");
  let preparingPhotos = false;
  const pushDraft = byId("push-draft");
  const discardDraft = byId("discard-draft");
  const githubMethod = byId("github-method");
  const githubTokenSettings = byId("github-token-settings");
  let guestEndpoint;
  const canPublishGitHub = () => githubMethod.value === "guest"
    ? Boolean(githubRepo && guestEndpoint)
    : Boolean(githubTarget);
  githubMethod.addEventListener("change", () => {
    showUploadMethodStatus();
    syncCaptureControls();
  });
  const githubForm = byId("github-form");
  const githubToken = byId("github-token");
  const rememberGitHub = byId("github-remember");
  const githubLink = byId("github-link");
  const githubUnlink = byId("github-unlink");
  const githubStatus = byId("github-status");
  let githubRepo;
  let githubFolder;
  let githubClient;
  let githubTarget;
  let linkedToken = "";
  let publishing = false;
  let linking = false;
  const gpsAvailable = Boolean(navigator.geolocation && window.isSecureContext);
  let overrides = new Map();
  try {
    const saved = JSON.parse(localStorage.getItem(layerPreferenceKey) || "[]");
    if (Array.isArray(saved)) overrides = new Map(saved);
  } catch {
    // Layer controls remain usable if browser storage is unavailable.
  }
  const layerMembership = new WeakMap();
  const importLayers = new Map();
  const importedRoutes = [];
  const importedGroups = new Map();
  const photos = [];
  const photoLayers = L.featureGroup().addTo(map);
  const selectionLayers = L.featureGroup().addTo(map);
  const outingSelectionLayers = L.featureGroup().addTo(map);
  const photoSections = new Map();
  const photoButton = byId("photos");
  const photoFiles = byId("photo-files");
  const photoStatus = byId("photo-status");
  let rejectedPhotos = 0;
  let readingPhotos = false;

  function getCategory(name) {
    const key = categoryKey(name);
    if (!categoryLayers.has(key)) {
      const entry = { key, name: categoryName(name), layer: L.featureGroup() };
      categoryLayers.set(key, entry);
      applyCategory(entry);
      renderLayerControls();
    }
    return categoryLayers.get(key);
  }

  function styleFor(entry) {
    const defaults = categoryConfig.get(entry.key) ?? categoryConfig.get(categoryKey(uncategorized)) ?? categoryDefaults;
    return categoryStyle(overrides.get(entry.key) ?? {}, defaults);
  }

  function paintLayer(layer, style) {
    if (layer.eachLayer) {
      layer.eachLayer(child => paintLayer(child, style));
    } else if (layer.setRadius) {
      layer.setRadius(Math.max(style.weight / 2, layer.options?.minRadius ?? 0));
      layer.setStyle({ stroke: false, fillColor: style.color, fillOpacity: style.opacity });
    } else {
      layer.setStyle?.({ color: style.color, weight: style.weight, opacity: style.opacity,
        fillColor: style.color, fillOpacity: style.opacity * 0.2 });
    }
  }

  function applyCategory(entry) {
    const style = styleFor(entry);
    entry.layer.eachLayer(layer => paintLayer(layer, style));
    if (style.visible && !map.hasLayer(entry.layer)) entry.layer.addTo(map);
    if (!style.visible && map.hasLayer(entry.layer)) entry.layer.remove();
  }

  function registerLayer(layer, category) {
    const entry = getCategory(category);
    layerMembership.set(layer, entry);
    paintLayer(layer, styleFor(entry));
    entry.layer.addLayer(layer);
    return layer;
  }

  function unregisterLayer(layer) {
    layerMembership.get(layer)?.layer.removeLayer(layer);
    layerMembership.delete(layer);
  }

  function isCategoryVisible(value) {
    const entry = categoryLayers.get(categoryKey(value));
    return !entry || styleFor(entry).visible;
  }

  function visibleMapBounds() {
    const bounds = L.latLngBounds([]);
    for (const entry of categoryLayers.values()) {
      if (styleFor(entry).visible) bounds.extend(entry.layer.getBounds());
    }
    return bounds;
  }

  function saveLayerPreferences(entry, override) {
    if (override) overrides.set(entry.key, override);
    else overrides.delete(entry.key);
    try {
      localStorage.setItem(layerPreferenceKey, JSON.stringify([...overrides]));
      byId("layer-status").textContent = "";
    } catch {
      byId("layer-status").textContent = "Changes apply for this visit. Browser storage is unavailable.";
    }
    applyCategory(entry);
    showPhotoSections();
    highlightServerItem();
    highlightOutings();
  }

  function renderLayerControls() {
    layerList.replaceChildren();
    const entries = [...categoryLayers.values()].sort((a, b) => a.name.localeCompare(b.name));
    const selectedCategory = draftCategory.value || uncategorized;
    draftCategory.replaceChildren(new Option(uncategorized),
      ...entries.filter(entry => entry.key !== categoryKey(uncategorized)).map(entry => new Option(entry.name)));
    draftCategory.value = [...draftCategory.options].find(option =>
      categoryKey(option.value) === categoryKey(selectedCategory))?.value ?? uncategorized;
    for (const entry of entries) {
      const style = styleFor(entry);
      const row = document.createElement("div");
      row.className = "layer-row";
      const name = document.createElement("label");
      name.className = "layer-name";
      const visible = document.createElement("input");
      visible.type = "checkbox";
      visible.checked = style.visible;
      const swatch = document.createElement("span");
      swatch.className = "layer-color";
      swatch.style.backgroundColor = style.color;
      name.append(visible, swatch, document.createTextNode(entry.name));
      const controls = document.createElement("div");
      controls.className = "layer-style";
      const update = (key, value) => {
        saveLayerPreferences(entry, { ...overrides.get(entry.key), [key]: value });
        swatch.style.backgroundColor = styleFor(entry).color;
        reset.disabled = false;
      };
      visible.addEventListener("change", () => update("visible", visible.checked));
      for (const [key, label, type, min, max, step] of [
        ["color", "Color", "color"], ["weight", "Width", "range", 1, 12, 1],
        ["opacity", "Opacity", "range", 0, 1, 0.05]
      ]) {
        const field = document.createElement("label");
        const input = document.createElement("input");
        input.type = type;
        if (type === "range") {
          input.min = min;
          input.max = max;
          input.step = step;
        }
        input.value = style[key];
        input.setAttribute("aria-label", `${entry.name} ${label.toLowerCase()}`);
        input.addEventListener("change", () => update(key, type === "range" ? Number(input.value) : input.value));
        field.append(document.createTextNode(label), input);
        controls.append(field);
      }
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "outline";
      reset.textContent = "Reset defaults";
      reset.disabled = !overrides.has(entry.key);
      reset.addEventListener("click", () => {
        saveLayerPreferences(entry);
        renderLayerControls();
      });
      controls.append(reset);
      row.append(name, controls);
      layerList.append(row);
    }
  }

  function configureCategories(categories) {
    for (const category of Array.isArray(categories) ? categories : []) {
      if (typeof category?.name !== "string" || !category.name.trim()) continue;
      const style = category.style ?? {};
      let color = style.stroke;
      if (typeof color === "string" && window.CSS?.supports("color", color)) {
        const canvas = document.createElement("canvas").getContext("2d");
        if (canvas) {
          canvas.fillStyle = color;
          color = canvas.fillStyle;
        }
      }
      categoryConfig.set(categoryKey(category.name), categoryStyle({
        color, weight: style["stroke-width"], opacity: style["stroke-opacity"],
        visible: typeof category.visible === "boolean" ? category.visible : style.display !== "none"
      }, categoryDefaults));
      getCategory(category.name).name = category.name.trim();
    }
    getCategory(uncategorized);
    for (const entry of categoryLayers.values()) applyCategory(entry);
    renderLayerControls();
  }

  function collectPaths(layer, paths) {
    if (layer instanceof L.Polygon) return;
    if (layer instanceof L.Polyline) {
      const points = layer.getLatLngs();
      if (Array.isArray(points[0])) paths.push(...points);
      else paths.push(points);
    } else if (layer.eachLayer) layer.eachLayer(child => collectPaths(child, paths));
  }

  function showPhotoSections() {
    if (!photos.length) {
      photoLayers.clearLayers();
      photoSections.clear();
      return;
    }
    const paths = [];
    for (const entry of categoryLayers.values()) {
      if (styleFor(entry).visible) entry.layer.eachLayer(layer => collectPaths(layer, paths));
    }
    const groups = [];
    let attached = 0;
    for (const photo of photos) {
      const match = nearestRouteSection(map, photo.point, paths);
      if (!match) continue;
      attached++;
      const group = groups.find(item => item.path === match.path &&
        map.distance(item.center, match.center) <= 28);
      if (group) group.photos.push(photo);
      else groups.push({ ...match, photos: [photo] });
    }

    photoLayers.clearLayers();
    photoSections.clear();
    for (const group of groups) {
      for (const photo of group.photos) photoSections.set(photo.id, group.section);
      const popup = document.createElement("div");
      popup.className = "photo-popup";
      const folderImages = [];
      for (const photo of group.photos) {
        const figure = document.createElement("figure");
        const image = document.createElement("img");
        const caption = document.createElement("figcaption");
        if (photo.getFile) folderImages.push({ image, photo });
        else image.src = photo.url;
        image.alt = photo.name;
        caption.textContent = photo.name;
        figure.append(image, caption);
        popup.append(figure);
      }
      L.polyline(group.section, { color: "#57390c", weight: 12, interactive: false })
        .addTo(photoLayers).bringToFront();
      const highlight = L.polyline(group.section, { color: "#ffd34e", weight: 8 })
        .addTo(photoLayers).bringToFront().bindPopup(popup, { maxWidth: 310 });
      let popupVersion = 0;
      const imageUrls = [];
      highlight.on("popupopen", async () => {
        const version = ++popupVersion;
        for (const { image, photo } of folderImages) {
          try {
            const file = await photo.getFile();
            if (popupVersion !== version) return;
            const url = URL.createObjectURL(file);
            imageUrls.push(url);
            image.src = url;
          } catch {
            if (popupVersion !== version) return;
            image.alt = `Could not open ${photo.name}`;
          }
        }
      });
      highlight.on("popupclose", () => {
        popupVersion++;
        for (const url of imageUrls.splice(0)) URL.revokeObjectURL(url);
        for (const { image } of folderImages) image.removeAttribute("src");
      });
      const path = highlight.getElement();
      path.setAttribute("tabindex", "0");
      path.setAttribute("role", "button");
      path.setAttribute("aria-label", group.photos.length === 1 ?
        `Open photo ${group.photos[0].name}` : `Open ${group.photos.length} route photos`);
      path.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          highlight.openPopup(group.center);
        }
      });
    }

    if (!readingPhotos) {
      let message = `${attached} of ${photos.length} geotagged photos on a route.`;
      if (attached < photos.length) message += " Add a route within 50 m of the remaining photos.";
      if (rejectedPhotos) message += ` ${rejectedPhotos} files skipped because GPS metadata was missing or unreadable.`;
      photoStatus.textContent = message;
    }
    return groups;
  }

  photoButton.addEventListener("click", () => photoFiles.click());
  photoFiles.addEventListener("change", async () => {
    const files = [...photoFiles.files];
    photoFiles.value = "";
    if (!files.length) return;
    if (!window.exifr?.gps) {
      photoStatus.textContent = "The photo metadata reader did not load. Reload and try again.";
      return;
    }
    readingPhotos = true;
    photoButton.disabled = true;
    rejectedPhotos = 0;
    photoStatus.textContent = "Reading photo locations…";
    for (const file of files) {
      try {
        const gps = await window.exifr.gps(file);
        if (!Number.isFinite(gps?.latitude) || Math.abs(gps.latitude) > 90 ||
            !Number.isFinite(gps.longitude) || Math.abs(gps.longitude) > 180) throw new Error("Missing GPS");
        photos.push({ id: crypto.randomUUID(), point: L.latLng(gps.latitude, gps.longitude),
          name: file.name, file, url: URL.createObjectURL(file) });
      } catch {
        rejectedPhotos++;
      }
    }
    readingPhotos = false;
    photoButton.disabled = false;
    const groups = showPhotoSections();
    if (!groups) photoStatus.textContent = "No readable GPS metadata found. Choose a geotagged JPEG.";
    if (groups?.length) {
      const bounds = L.latLngBounds(groups.map(group => group.center));
      if (!map.getBounds().contains(bounds)) map.fitBounds(bounds, { maxZoom: 17, padding: [40, 40] });
    }
  });

  const importButton = byId("import");
  const fileInput = byId("geojson-file");
  const importStatus = byId("import-status");
  const importProgress = byId("import-progress");
  const snapStreets = byId("snap-streets");
  snapStreets.checked = true;

  function bindPublishedOuting(layer, source, availablePhotos, repositoryFile) {
    const properties = layer.feature?.properties ?? {};
    const names = Array.isArray(properties.photoFileNames) ? properties.photoFileNames : [];
    const photos = [...new Set(names)].filter(name => availablePhotos.has(name));
    const folder = new URL(".", source);

    function details(preview) {
      const container = document.createElement("div");
      container.className = "published-outing-details";
      const category = document.createElement("p");
      category.textContent = `Category: ${categoryName(properties.category)}`;
      const description = document.createElement("p");
      description.className = "published-outing-description";
      description.textContent = typeof properties.description === "string" && properties.description.trim()
        ? properties.description.trim() : "No description";
      const link = document.createElement("a");
      link.href = repositoryFile ?? source.href;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = repositoryFile ? "Open GeoJSON on GitHub" : "Open GeoJSON";
      container.append(category, description, link);
      if (photos.length) container.append(gallery(preview));
      return container;
    }

    function gallery(preview) {
      const container = document.createElement("div");
      container.className = preview ? "published-photo-preview" : "published-photo-gallery";
      const visiblePhotos = preview ? photos.slice(0, 3) : photos;
      visiblePhotos.forEach((name, index) => {
        const url = new URL(encodeURIComponent(name), folder).href;
        const image = document.createElement("img");
        image.src = url;
        image.alt = `Outing photo ${index + 1}`;
        image.decoding = "async";
        if (preview) {
          container.append(image);
        } else {
          const link = document.createElement("a");
          link.href = url;
          link.target = "_blank";
          link.rel = "noopener";
          link.setAttribute("aria-label", `Open outing photo ${index + 1} at full size`);
          link.append(image);
          container.append(link);
        }
      });
      if (preview && photos.length > visiblePhotos.length) {
        const count = document.createElement("span");
        count.textContent = `+${photos.length - visiblePhotos.length}`;
        container.append(count);
      }
      return container;
    }

    let preview;
    const tooltip = L.tooltip({
      interactive: true, direction: "top", opacity: 1, className: "published-outing-tooltip"
    });
    let closeTimer;
    const keepOpen = () => clearTimeout(closeTimer);
    const close = () => {
      keepOpen();
      tooltip.remove();
    };
    const scheduleClose = () => {
      keepOpen();
      closeTimer = setTimeout(() => {
        if (!preview?.contains(document.activeElement)) close();
      }, 250);
    };

    layer.on("mouseover", event => {
      keepOpen();
      if (!layer.isPopupOpen() && !map.hasLayer(tooltip)) {
        if (!preview) {
          preview = details(true);
          preview.addEventListener("mouseenter", keepOpen);
          preview.addEventListener("mouseleave", scheduleClose);
          preview.addEventListener("focusout", scheduleClose);
          tooltip.setContent(preview);
        }
        tooltip.setLatLng(event.latlng).addTo(map);
      }
    });
    layer.on("mouseout", scheduleClose);
    layer.bindPopup(() => details(false), { maxWidth: 360 });
    layer.on("popupopen remove", close);
  }

  function plotImportedRoute(route) {
    const layer = L.geoJSON(route.data, {
      pointToLayer: (_feature, latlng) => L.circleMarker(latlng, { stroke: false })
    });
    const bounds = layer.getBounds();
    if (!bounds.isValid()) return null;
    const groups = importedOutingGroups(route);
    importLayers.set(route.id, layer);
    layer.eachLayer(featureLayer => registerLayer(featureLayer, featureLayer.feature?.properties?.category));
    importedRoutes.push(route);
    for (const group of groups) importedGroups.set(group.key, group);
    if (route.snapped) showRoutingAttribution();
    const visibleBounds = L.latLngBounds([]);
    layer.eachLayer(featureLayer => {
      if (isCategoryVisible(featureLayer.feature?.properties?.category)) {
        visibleBounds.extend(featureLayer.getBounds?.() ?? featureLayer.getLatLng?.());
      }
    });
    return visibleBounds;
  }

  function removeImportedRoute(id) {
    const index = importedRoutes.findIndex(route => route.id === id);
    if (index >= 0) importedRoutes.splice(index, 1);
    importLayers.get(id)?.eachLayer(unregisterLayer);
    importLayers.delete(id);
    for (const [key, group] of importedGroups) {
      if (group.routeID === id) importedGroups.delete(key);
    }
  }

  importButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;
    fileInput.value = "";
    importButton.disabled = true;
    importProgress.removeAttribute("value");
    importProgress.hidden = false;
    importStatus.textContent = `Reading ${file.name}…`;
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data.type !== "string") throw new Error("Missing GeoJSON type");
      const bounds = plotImportedRoute({
        id: crypto.randomUUID(), name: file.name, data, snapped: containsSnappedRoute(data)
      });
      if (!bounds) {
        importStatus.textContent = "This file has no map features to display.";
        return;
      }
      showPhotoSections();
      renderOutingPicker();
      if (bounds.isValid()) map.fitBounds(bounds, { maxZoom: 17, padding: [30, 30] });
      importStatus.textContent = `Plotted ${file.name}.`;
    } catch {
      importStatus.textContent = "Could not read this file. Choose valid GeoJSON.";
    } finally {
      importButton.disabled = false;
      importProgress.hidden = true;
    }
  });

  let outings = [];
  const browserOutings = new Set();
  let current = null;
  let marker = null;
  let watch = null;
  let breakTrail = false;
  let draft = null;
  let locatingPin = false;
  let routeLayer;
  let matchingRecording = false;
  let liveMatch = null;
  const pointCoords = point => [point.lat, point.lng];

  function displayedPaths(outing, segment, index) {
    const matched = outing.matchedSegments?.[index];
    if (matched) return matched.map(path => path.map(([lng, lat]) => [lat, lng]));
    const preview = liveMatch?.outing === outing ? liveMatch.segments.get(index) : null;
    if (!preview) return [segment.map(pointCoords)];
    const paths = preview.paths.map(path => path.map(([lng, lat]) => [lat, lng]));
    if (preview.offset < segment.length - 1) paths.push(segment.slice(preview.offset).map(pointCoords));
    return paths;
  }

  function showRoutingAttribution() {
    if (routingAttributed) return;
    map.attributionControl.addAttribution(routingAttribution);
    routingAttributed = true;
  }
  const distance = (first, second) => map.distance(pointCoords(first), pointCoords(second));

  function loadOutings() {
    const saved = Object.keys(localStorage)
      .filter(key => key.startsWith(storagePrefix))
      .map(key => JSON.parse(localStorage.getItem(key)))
      .filter(outing => outing?.segments?.length);
    for (const outing of saved) browserOutings.add(outing.id);
    return saved;
  }

  const serverSelection = byId("server-selection");
  const deleteServerItem = byId("delete-server-item");
  const savedItems = { outings: new Map(), imports: new Map(), photos: new Map() };
  let serverBusy = false;

  function rememberSavedItems(library) {
    for (const [collection, entries] of Object.entries(library)) {
      if (!savedItems[collection]) continue;
      for (const entry of entries) savedItems[collection].set(entry.id, entry);
    }
  }

  function selectedServerItem() {
    if (!serverSelection.value) return null;
    const [collection, id] = JSON.parse(serverSelection.value);
    const entry = savedItems[collection].get(id);
    return entry ? { collection, id, entry, label: serverSelection.selectedOptions[0].textContent } : null;
  }

  function renderServerItems() {
    const previous = serverSelection.value;
    serverSelection.replaceChildren(new Option("Select a route or photo", ""));
    for (const [collection, entries] of Object.entries(savedItems)) {
      if (!entries.size) continue;
      const group = document.createElement("optgroup");
      group.label = { outings: "Recorded routes", imports: "Imported routes", photos: "Photos" }[collection];
      let index = 0;
      for (const [id, entry] of entries) {
        index++;
        const time = entry.segments?.[0]?.[0]?.time;
        const label = collection === "outings" && Number.isFinite(time)
          ? `Outing · ${new Date(time).toLocaleString()}`
          : entry.name || entry.data?.properties?.name || `${group.label.slice(0, -1)} ${index}`;
        group.append(new Option(label, JSON.stringify([collection, id])));
      }
      serverSelection.append(group);
    }
    if (previous) serverSelection.value = previous;
    serverSelection.disabled = serverBusy;
    deleteServerItem.disabled = serverBusy || !serverSelection.value;
  }

  function highlightServerItem(center = false) {
    selectionLayers.clearLayers();
    const selected = selectedServerItem();
    if (!selected) return;
    const style = { color: "#173690", weight: 12, dashArray: "5 8", interactive: false };
    if (selected.collection === "photos") {
      const section = photoSections.get(selected.id);
      if (section) L.polyline(section, style).addTo(selectionLayers).bringToFront();
      else if (center) map.setView([selected.entry.lat, selected.entry.lng], Math.max(map.getZoom(), 16));
    } else {
      const data = selected.collection === "outings"
        ? { type: "FeatureCollection", features: outingFeatures(selected.entry) } : selected.entry.data;
      L.geoJSON(data, {
        style,
        filter: feature => isCategoryVisible(feature.properties?.category),
        pointToLayer: (_feature, point) => L.circleMarker(point, {
          radius: style.weight / 2, stroke: false, fillColor: style.color, fillOpacity: 1, interactive: false
        })
      }).addTo(selectionLayers).bringToFront();
    }
    if (center && selectionLayers.getBounds().isValid()) {
      map.fitBounds(selectionLayers.getBounds(), { maxZoom: 17, padding: [35, 35] });
    }
  }

  const checkedRecorded = new Set();
  const checkedImported = new Set();
  const outingPicker = byId("outing-picker");
  const recordedChoices = byId("recorded-choices");
  const importedChoices = byId("imported-choices");
  const mergeOutings = byId("merge-outings");
  const clearOutings = byId("clear-outings");
  const deleteRecording = byId("delete-recording");
  const outingStatus = byId("outing-status");
  let chooserSignature = "";
  let mergingOutings = false;
  let deletingRecording = false;

  function outingName(outing, index) {
    const time = outing.segments[0]?.[0]?.time;
    return outing.name || (Number.isFinite(time) ? new Date(time).toLocaleString() : `Outing ${index + 1}`);
  }

  function renderOutingPicker() {
    byId("imported-outings").textContent = importedGroups.size;
    outingPicker.hidden = outings.length === 0 && importedGroups.size === 0;
    const recorded = outings.map((outing, index) => [outing.id, outingName(outing, index)]);
    const imported = [...importedGroups.values()].map(group => [group.key, group.name]);
    const signature = JSON.stringify([recorded, imported]);
    if (signature !== chooserSignature) {
      chooserSignature = signature;
      for (const [container, entries, selected] of [
        [recordedChoices, recorded, checkedRecorded], [importedChoices, imported, checkedImported]
      ]) {
        const keys = new Set(entries.map(([key]) => key));
        for (const key of selected) if (!keys.has(key)) selected.delete(key);
        container.replaceChildren();
        for (const [key, name] of entries) {
          const label = document.createElement("label");
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.value = key;
          checkbox.checked = selected.has(key);
          label.append(checkbox, document.createTextNode(name));
          container.append(label);
        }
        if (!entries.length) container.textContent = "No outings";
      }
    }
    const count = checkedRecorded.size;
    exportButton.disabled = outings.length === 0;
    exportButton.textContent = count ? `Export selected (${count})` : "Export all GeoJSON";
    mergeOutings.disabled = checkedImported.size === 0 || mergingOutings;
    clearOutings.disabled = checkedImported.size + count === 0;
    deleteRecording.disabled = count !== 1 || deletingRecording;
  }

  function highlightOutings(center = false) {
    outingSelectionLayers.clearLayers();
    const features = [
      ...outings.filter(outing => checkedRecorded.has(outing.id)).flatMap(outingFeatures),
      ...[...checkedImported].flatMap(key => importedGroups.get(key)?.features ?? [])
    ].filter(feature => isCategoryVisible(feature.properties?.category));
    if (features.length === 0) return;
    const style = { color: "#2155cf", weight: 8, interactive: false };
    L.geoJSON({ type: "FeatureCollection", features }, {
      style,
      pointToLayer: (_feature, point) => L.circleMarker(point, {
        radius: style.weight / 2, stroke: false, fillColor: style.color, fillOpacity: 1, interactive: false
      })
    }).addTo(outingSelectionLayers).bringToFront();
    const bounds = outingSelectionLayers.getBounds();
    if (center && bounds.isValid()) map.fitBounds(bounds, { maxZoom: 17, padding: [35, 35] });
  }

  for (const [container, selection] of [[recordedChoices, checkedRecorded], [importedChoices, checkedImported]]) {
    container.addEventListener("change", event => {
      const checkbox = event.target;
      if (checkbox.checked) selection.add(checkbox.value);
      else selection.delete(checkbox.value);
      renderOutingPicker();
      highlightOutings(true);
    });
  }

  clearOutings.addEventListener("click", () => {
    checkedRecorded.clear();
    checkedImported.clear();
    chooserSignature = "";
    renderOutingPicker();
    highlightOutings();
    outingStatus.textContent = "";
  });

  function refreshMap() {
    if (routeLayer) routeLayer.eachLayer(unregisterLayer);
    routeLayer = L.featureGroup();
    let meters = 0;
    for (const outing of [...outings, ...(current || draft ? [current || draft] : [])]) {
      if (outing.snapped || (outing.matchedSegments && outing.snapped !== false)) showRoutingAttribution();
      for (const [segmentIndex, segment] of outing.segments.entries()) {
        if (segment.length === 1) {
          const prominent = outing.kind === "pin" && categoryKey(outing.category) === categoryKey(uncategorized);
          const dot = L.circleMarker(pointCoords(segment[0]), { interactive: false, minRadius: prominent ? 6 : 0 });
          routeLayer.addLayer(registerLayer(dot, outing.category));
        } else {
          for (const path of displayedPaths(outing, segment, segmentIndex)) {
            const line = L.polyline(path, { interactive: false });
            routeLayer.addLayer(registerLayer(line, outing.category));
            for (let index = 1; index < path.length; index++) {
              meters += map.distance(path[index - 1], path[index]);
            }
          }
        }
      }
    }
    byId("distance").textContent = (meters / 1000).toFixed(2);
    byId("outings").textContent = outings.length;
    renderOutingPicker();
    showPhotoSections();
    highlightServerItem();
    highlightOutings();
  }

  try {
    outings = loadOutings();
  } catch {
    status.textContent = "Browser storage unavailable";
  }
  refreshMap();

  const saveLibrary = byId("save-library");
  const libraryStatus = byId("library-status");

  async function restoreLibrary() {
    try {
      const response = await fetch("/api/library");
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return;
      const library = await response.json();
      const merged = new Map(library.outings.map(outing => [outing.id, outing]));
      for (const outing of outings) {
        const serverOuting = merged.get(outing.id);
        const count = segments => segments.reduce((total, segment) => total + segment.length, 0);
        if (!serverOuting || outing === current ||
            count(outing.segments) > count(serverOuting.segments) ||
            (count(outing.segments) === count(serverOuting.segments) &&
             (outing.matchedSegments || !serverOuting.matchedSegments))) merged.set(outing.id, outing);
      }
      outings = [...merged.values()];
      rememberSavedItems(library);
      renderServerItems();
      byId("server-items").hidden = false;
      for (const route of library.imports) plotImportedRoute(route);
      for (const photo of library.photos) {
        photos.push({ ...photo, point: L.latLng(photo.lat, photo.lng), url: photo.image, serverSaved: true });
      }
      refreshMap();
      saveLibrary.hidden = false;
      saveLibrary.disabled = false;
      libraryStatus.textContent = library.outings.length || library.imports.length || library.photos.length
        ? "Saved routes and photos loaded from this computer."
        : "Save a copy of your routes and photos on this computer’s server.";
    } catch {
      libraryStatus.textContent = "Could not load the server library. Browser GPS history is still available.";
    }
  }

  saveLibrary.addEventListener("click", async () => {
    if (readingPhotos || importButton.disabled || matchingRecording || deletingRecording) {
      libraryStatus.textContent = "Wait for importing or street matching to finish, then save.";
      return;
    }
    serverBusy = true;
    renderServerItems();
    saveLibrary.disabled = true;
    libraryStatus.textContent = "Saving routes and photos…";
    const entries = photos.filter(photo => !photo.serverSaved);
    try {
      const savedPhotos = await Promise.all(entries.map(async photo => {
        const file = photo.file ?? (photo.getFile ? await photo.getFile() : await (await fetch(photo.url)).blob());
        const image = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(new Blob([file], { type: "image/jpeg" }));
        });
        return { id: photo.id, name: photo.name, lat: photo.point.lat, lng: photo.point.lng, image };
      }));
      const payload = { outings, imports: importedRoutes, photos: savedPhotos };
      const body = JSON.stringify(payload);
      const response = await fetch("/api/library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Server save failed.");
      }
      for (const photo of entries) photo.serverSaved = true;
      rememberSavedItems(JSON.parse(body));
      libraryStatus.textContent = "Routes and photos saved to the server.";
    } catch (error) {
      libraryStatus.textContent = `Save failed. ${error.message}`;
    } finally {
      serverBusy = false;
      saveLibrary.disabled = false;
      renderServerItems();
    }
  });

  serverSelection.addEventListener("change", () => {
    deleteServerItem.disabled = !serverSelection.value;
    highlightServerItem(true);
  });

  deleteServerItem.addEventListener("click", async () => {
    const selected = selectedServerItem();
    if (!selected || serverBusy || deletingRecording) return;
    if (current || matchingRecording || readingPhotos || importButton.disabled) {
      libraryStatus.textContent = "Finish recording, matching, or importing before deleting.";
      return;
    }
    if (!window.confirm(`Delete ${selected.label} from the server library? Copies in the browser or local folder are kept.`)) return;
    const { collection, id } = selected;
    serverBusy = true;
    saveLibrary.disabled = true;
    renderServerItems();
    libraryStatus.textContent = "Deleting the selected item…";
    try {
      await deleteServerCopy(collection, id);
      if (collection === "outings") {
        outings = outings.filter(outing => outing.id !== id);
      } else if (collection === "imports") {
        removeImportedRoute(id);
      } else {
        const index = photos.findIndex(photo => photo.id === id);
        if (index >= 0) {
          const [photo] = photos.splice(index, 1);
          if (photo.url?.startsWith("blob:")) URL.revokeObjectURL(photo.url);
        }
        if (!photos.length) photoStatus.textContent = "";
      }
      serverSelection.value = "";
      refreshMap();
      libraryStatus.textContent = "Selected item deleted from the server.";
    } catch (error) {
      libraryStatus.textContent = `Delete failed. ${error.message}`;
    } finally {
      serverBusy = false;
      saveLibrary.disabled = false;
      renderServerItems();
    }
  });

  async function deleteServerCopy(collection, id) {
    const response = await fetch("/api/library", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ collection, id })
    });
    if (!response.ok) throw new Error((await response.json()).error);
    savedItems[collection].delete(id);
  }

  const openFolder = byId("open-folder");
  const reconnectFolder = byId("reopen-folder");
  const folderFiles = byId("folder-files");
  const saveFolder = byId("save-folder");
  const folderStatus = byId("folder-status");
  const folderProgress = byId("folder-progress");
  const serverFolderForm = byId("server-folder-form");
  const serverFolderPath = byId("server-folder-path");
  const folderPermission = { mode: "readwrite" };
  let activeFolder = null;
  let rememberedFolder = null;
  let folderWrite = Promise.resolve();
  let folderBusy = false;
  const folderOutingFiles = new Map();
  const folderImportFiles = new Map();
  const readOnlyOutings = new Set();

  function rememberFolderOuting(id, handle, name) {
    if (!handle) {
      readOnlyOutings.add(id);
      return;
    }
    readOnlyOutings.delete(id);
    const copies = folderOutingFiles.get(id) ?? [];
    if (!copies.some(copy => copy.handle === handle && copy.name === name)) copies.push({ handle, name });
    folderOutingFiles.set(id, copies);
  }

  function saveBrowserOuting(outing) {
    localStorage.setItem(storagePrefix + outing.id, JSON.stringify(outing));
    browserOutings.add(outing.id);
  }

  function mergeOuting(outing) {
    const index = outings.findIndex(existing => existing.id === outing.id);
    if (index < 0) {
      outings.push(outing);
      return;
    }
    const existing = outings[index];
    const count = item => item.segments.reduce((sum, segment) => sum + segment.length, 0);
    if (existing !== current && (count(outing) > count(existing) ||
        (count(outing) === count(existing) && outing.matchedSegments &&
          (!existing.matchedSegments || (outing.matchStatuses && !existing.matchStatuses))))) {
      outings[index] = outing;
    }
  }

  function photoFileId(name) {
    const stored = /^streetlog-([a-f0-9-]{36})\.(?:jpg|jpeg)$/i.exec(name);
    return stored ? stored[1] : `folder-photo:${name}`;
  }

  async function loadFolder(files, handle = null, fitView = true) {
    let skipped = 0;
    let done = 0;
    const total = files.routes.length + files.photos.length;
    folderProgress.max = Math.max(1, total);
    folderProgress.value = 0;
    for (const entry of files.routes) {
      const fileLabel = `File ${done + 1} of ${total} · ${entry.name}`;
      folderStatus.textContent = `Reading route · ${fileLabel}`;
      try {
        const data = JSON.parse(await (await entry.getFile()).text());
        const saved = data.streetlogOuting;
        if (saved && typeof saved.id === "string" && Array.isArray(saved.segments) &&
            saved.segments.length && saved.segments.every(segment => Array.isArray(segment) && segment.length &&
              segment.every(point => Number.isFinite(point?.lat) && Number.isFinite(point?.lng)))) {
          mergeOuting(saved);
          rememberFolderOuting(saved.id, handle, entry.name);
        } else {
          const id = data.streetlogImport?.id || `folder-route:${entry.name}`;
          if (importedRoutes.some(route => route.id === id)) continue;
          if (!plotImportedRoute({ id, name: entry.name, data,
            sourceData: data.streetlogImport?.sourceData,
            snapped: containsSnappedRoute(data) })) skipped++;
          else if (handle) folderImportFiles.set(id, { handle, name: entry.name, updated: false });
        }
      } catch {
        skipped++;
      } finally {
        folderProgress.value = ++done;
      }
    }
    for (const entry of files.photos) {
      folderStatus.textContent = `Reading photo · File ${done + 1} of ${total} · ${entry.name}`;
      try {
        const id = photoFileId(entry.name);
        if (photos.some(photo => photo.id === id)) continue;
        const gps = await window.exifr.gps(await entry.getFile());
        if (!Number.isFinite(gps?.latitude) || Math.abs(gps.latitude) > 90 ||
            !Number.isFinite(gps.longitude) || Math.abs(gps.longitude) > 180) throw new Error("Missing GPS");
        photos.push({ id, name: entry.name, point: L.latLng(gps.latitude, gps.longitude), getFile: entry.getFile });
      } catch {
        skipped++;
      } finally {
        folderProgress.value = ++done;
        folderStatus.textContent = `Reading library folder… ${done} of ${total} files processed`;
      }
    }
    refreshMap();
    const bounds = visibleMapBounds();
    if (fitView && bounds.isValid() && !current && !draft) map.fitBounds(bounds, { maxZoom: 17, padding: [30, 30] });
    let summary = skipped ? ` Skipped ${skipped} unreadable files.` : "";
    return summary;
  }

  async function connectFolder(handle, fitView = true) {
    folderBusy = true;
    folderProgress.removeAttribute("value");
    folderProgress.hidden = false;
    folderStatus.textContent = "Reading library folder…";
    try {
      if (!handle.server) {
        await handle.getDirectoryHandle("GeoJSON", { create: true });
        await handle.getDirectoryHandle("Photo", { create: true });
      }
      const summary = await loadFolder(await folderLibrary.list(handle), handle, fitView);
      activeFolder = handle;
      if (!handle.server) rememberedFolder = handle;
      reconnectFolder.hidden = true;
      saveFolder.hidden = false;
      if (navigator.geolocation && window.isSecureContext) record.disabled = false;
      folderStatus.textContent = `Opened ${handle.name}.${summary}`;
      if (handle.server) folderStatus.textContent += " This folder will reopen on your next visit.";
      else {
        try {
          await folderLibrary.remember(handle);
        } catch {
          folderStatus.textContent += " This browser could not remember the folder.";
        }
      }
    } catch {
      folderStatus.textContent = "Could not open the library folder.";
    } finally {
      folderProgress.hidden = true;
      folderBusy = false;
    }
  }

  openFolder.addEventListener("click", async () => {
    if (folderBusy || mergingOutings || deletingRecording || current || matchingRecording) return;
    if (!window.showDirectoryPicker) {
      folderFiles.click();
      return;
    }
    try {
      const handle = await window.showDirectoryPicker(folderPermission);
      await connectFolder(handle);
    } catch (error) {
      if (error.name !== "AbortError") {
        folderStatus.textContent = "This browser cannot remember the folder through the picker. Use the Mac folder path or import for this visit.";
        folderFiles.click();
      }
    }
  });

  reconnectFolder.addEventListener("click", async () => {
    if (folderBusy || mergingOutings || deletingRecording || current || matchingRecording || !rememberedFolder) return;
    try {
      if (await rememberedFolder.requestPermission(folderPermission) === "granted") {
        await connectFolder(rememberedFolder);
      }
    } catch {
      folderStatus.textContent = "Could not reconnect. Open the library folder again.";
    }
  });

  folderFiles.addEventListener("change", async () => {
    const files = [...folderFiles.files];
    folderFiles.value = "";
    if (!files.length || folderBusy) return;
    folderBusy = true;
    folderProgress.removeAttribute("value");
    folderProgress.hidden = false;
    folderStatus.textContent = "Reading library folder…";
    try {
      const summary = await loadFolder(folderLibrary.selectedFiles(files));
      folderStatus.textContent = `Folder imported for this visit only.${summary}`;
    } catch {
      folderStatus.textContent = "Could not load the library folder.";
    } finally {
      folderProgress.hidden = true;
      folderBusy = false;
    }
  });

  serverFolderForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (folderBusy || mergingOutings || deletingRecording || current || matchingRecording) return;
    folderBusy = true;
    try {
      const folder = await folderLibrary.serverPreference(serverFolderPath.value.trim());
      if (!folder?.name) throw new Error("Folder unavailable.");
      await connectFolder({ server: true, name: folder.name, key: folder.key });
      serverFolderPath.value = "";
    } catch (error) {
      folderStatus.textContent = error.message;
    } finally {
      folderBusy = false;
    }
  });

  async function reopenRememberedFolder() {
    try {
      const local = ["127.0.0.1", "localhost"].includes(window.location.hostname);
      const folder = local ? await folderLibrary.serverPreference() : null;
      if (folder) serverFolderForm.hidden = false;
      if (folder?.name) {
        await connectFolder({ server: true, name: folder.name, key: folder.key }, false);
        return;
      }
    } catch {
      folderStatus.textContent = "The remembered Mac folder is unavailable. Enter its current path.";
      serverFolderForm.hidden = false;
    }
    if (!window.showDirectoryPicker) {
      if (!serverFolderForm.hidden) folderStatus.textContent = "Enter a Mac folder path to reopen it automatically. The picker imports for this visit only.";
      return;
    }
    try {
      rememberedFolder = await folderLibrary.remembered();
      if (!rememberedFolder) return;
      if (await rememberedFolder.queryPermission(folderPermission) === "granted") {
        await connectFolder(rememberedFolder, false);
      } else {
        reconnectFolder.hidden = false;
        folderStatus.textContent = `Reconnect ${rememberedFolder.name} to load its routes and photos.`;
      }
    } catch {
      folderStatus.textContent = "Open a library folder to load its routes and photos.";
    }
  }

  function writeFolderOuting(handle, outing) {
    const name = `outing-${encodeURIComponent(outing.id)}.geojson`;
    const data = JSON.stringify({
      type: "FeatureCollection", features: outingFeatures(outing), streetlogOuting: outing
    });
    const write = folderWrite.catch(() => {}).then(async () => {
      await folderLibrary.write(handle, "routes", name, data, true);
      rememberFolderOuting(outing.id, handle, name);
    });
    folderWrite = write;
    return write;
  }

  deleteRecording.addEventListener("click", async () => {
    if (checkedRecorded.size !== 1 || deletingRecording) return;
    if (current || matchingRecording || folderBusy || mergingOutings || serverBusy) {
      outingStatus.textContent = "Finish recording or saving before deleting an outing.";
      return;
    }
    const [id] = checkedRecorded;
    const index = outings.findIndex(outing => outing.id === id);
    if (index < 0) return;
    if (readOnlyOutings.has(id)) {
      outingStatus.textContent = "This recording was opened from a read-only folder. Reopen that folder with write access, or remove its file in Files or Finder.";
      return;
    }
    const name = outingName(outings[index], index);
    if (!window.confirm(`Delete this recording and its saved Streetlog copies?\n${name}`)) return;
    deletingRecording = true;
    outingStatus.textContent = "Deleting recording…";
    renderOutingPicker();
    try {
      await folderWrite.catch(() => {});
      for (const copy of folderOutingFiles.get(id) ?? []) {
        await folderLibrary.removeOuting(copy.handle, copy.name, id);
      }
      if (savedItems.outings.has(id)) await deleteServerCopy("outings", id);
      try {
        localStorage.removeItem(storagePrefix + id);
      } catch (error) {
        if (browserOutings.has(id)) throw error;
      }
      browserOutings.delete(id);
      folderOutingFiles.delete(id);
      outings = outings.filter(outing => outing.id !== id);
      checkedRecorded.delete(id);
      renderServerItems();
      refreshMap();
      outingStatus.textContent = "Recording deleted.";
    } catch (error) {
      outingStatus.textContent = `Could not finish deleting. ${error.message} You can retry.`;
    } finally {
      deletingRecording = false;
      renderOutingPicker();
    }
  });

  mergeOutings.addEventListener("click", async () => {
    if (mergingOutings || deletingRecording || checkedImported.size === 0) return;
    if (current || matchingRecording || folderBusy || importButton.disabled) {
      outingStatus.textContent = "Finish recording or importing before adding outings.";
      return;
    }
    mergingOutings = true;
    renderOutingPicker();
    outingStatus.textContent = "Adding selected outings to your recorded library…";
    const handle = activeFolder;
    const selection = [...checkedImported].map(key => importedGroups.get(key)).filter(Boolean);
    let added = 0;
    let existing = 0;
    let failed = 0;
    for (const group of selection) {
      try {
        const id = await importedOutingID(group);
        if (outings.some(outing => outing.id.toLowerCase() === id)) {
          existing++;
        } else {
          const outing = { id, name: group.name, category: group.category, segments: group.segments };
          if (group.matchedSegments.some(Boolean)) outing.matchedSegments = group.matchedSegments;
          outing.matchStatuses = group.matchStatuses;
          outing.snapped = Boolean(group.snapped);
          if (handle) await writeFolderOuting(handle, outing);
          else saveBrowserOuting(outing);
          outings.push(outing);
          added++;
        }
        checkedRecorded.add(outings.find(outing => outing.id.toLowerCase() === id).id);
        checkedImported.delete(group.key);
      } catch {
        failed++;
      }
    }
    mergingOutings = false;
    chooserSignature = "";
    refreshMap();
    highlightOutings(true);
    outingStatus.textContent = `Added ${added} to recorded outings.` +
      (existing ? ` ${existing} already in the library.` : "") +
      (failed ? ` Could not save ${failed}. Check the folder or browser storage and retry.` : "");
  });

  saveFolder.addEventListener("click", async () => {
    if (!activeFolder || folderBusy || mergingOutings || deletingRecording || current || matchingRecording || readingPhotos || importButton.disabled) {
      folderStatus.textContent = "Finish recording or importing before saving the folder.";
      return;
    }
    folderBusy = true;
    saveFolder.disabled = true;
    const handle = activeFolder;
    const updated = importedRoutes.filter(route => {
      const origin = folderImportFiles.get(route.id);
      return origin?.handle === handle && origin.updated;
    }).length;
    const saveMatches = updated === 0 || window.confirm(
      `Update the geometry and snap status in ${updated} existing GeoJSON files? Original GPS coordinates will be kept in the files.`
    );
    folderStatus.textContent = "Saving library folder…";
    try {
      for (const outing of outings) await writeFolderOuting(handle, outing);
      for (const route of importedRoutes) {
        const origin = folderImportFiles.get(route.id);
        const inCurrentFolder = origin?.handle === handle;
        if (inCurrentFolder && (!origin.updated || !saveMatches)) continue;
        if (!inCurrentFolder && route.id.startsWith("folder-route:")) continue;
        const name = inCurrentFolder ? origin.name : `import-${encodeURIComponent(route.id)}.geojson`;
        const data = JSON.stringify({
          ...route.data, streetlogImport: { id: route.id, snapped: route.snapped, sourceData: route.sourceData }
        });
        await folderLibrary.write(handle, "routes", name, data, inCurrentFolder);
        folderImportFiles.set(route.id, { handle, name, updated: false });
      }
      for (const photo of photos) {
        const name = photo.id.startsWith("folder-photo:") ? photo.name : `streetlog-${photo.id}.jpg`;
        const file = photo.file ?? (photo.getFile ? await photo.getFile() : await (await fetch(photo.url)).blob());
        await folderLibrary.write(handle, "photos", name, file);
      }
      folderStatus.textContent = `Saved routes and photos to ${handle.name}.`;
    } catch {
      folderStatus.textContent = "Could not finish saving. Check folder access and available disk space, then retry.";
    } finally {
      folderBusy = false;
      saveFolder.disabled = false;
    }
  });

  const siteBase = new URL(".", document.baseURI);
  const siteConfig = readSiteConfig();

  async function readSiteConfig() {
    try {
      const response = await fetch(new URL("site.json", siteBase), { cache: "no-store", signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const config = await response.json();
      if (typeof config.site_name === "string" && config.site_name.trim()) {
        const name = config.site_name.trim();
        byId("site-name").textContent = name;
        document.title = name;
      }
      configureGitHub(config.git_url, config.GeoJSON_folder, config.guest_github_api_url);
      return config;
    } catch {
      byId("github-repository").textContent = "Could not load site.json. Reload the page to retry.";
      return null;
    }
  }

  async function loadPublishedRoutes() {
    const publishedStatus = byId("published-status");
    const base = new URL(".", document.baseURI);
    let folder;
    let files;
    let indexedBounds;
    let availablePhotos;
    let repositoryFolder;
    try {
      const config = await siteConfig;
      if (!config) return;
      const { GeoJSON_folder: path, categories } = config;
      configureCategories(categories);
      if (typeof path !== "string" || !path.trim()) throw new Error("Set GeoJSON_folder in site.json.");
      folder = new URL(path.trim().replace(/\/?$/, "/"), base);
      if (folder.origin !== base.origin || !folder.pathname.startsWith(base.pathname) ||
          folder.search || folder.hash) throw new Error("GeoJSON_folder must be inside the published site.");
      const response = await fetch(new URL("index.json", folder), { cache: "no-cache" });
      if (!response.ok) throw new Error("Could not read the GeoJSON folder’s index.json.");
      const manifest = await response.json();
      ({ files, bounds: indexedBounds } = manifest);
      const { source_branch: branch, source_folder: sourceFolder } = manifest;
      if (githubRepo && typeof branch === "string" && branch &&
          typeof sourceFolder === "string" && sourceFolder) {
        const location = [...githubRepo, "blob", ...branch.split("/"), ...sourceFolder.split("/")];
        repositoryFolder = "https://github.com/" + location.map(encodeURIComponent).join("/") + "/";
      }
      availablePhotos = new Set(Array.isArray(manifest.photos) ? manifest.photos.filter(name =>
        typeof name === "string" && /^[^/\\]+\.(?:jpe?g|png|webp|avif|gif)$/i.test(name)) : []);
      if (!Array.isArray(files) || !files.every(name =>
        typeof name === "string" && /^[^/\\]+\.geojson$/i.test(name))) {
        throw new Error("index.json must list GeoJSON filenames in its files array.");
      }
    } catch (error) {
      publishedStatus.textContent = error.message;
      return;
    }

    const routes = [...new Set(files)].flatMap(name => {
      const url = new URL(encodeURIComponent(name), folder);
      const bounds = indexedBounds && Object.hasOwn(indexedBounds, name) ? indexedBounds[name] : undefined;
      if (bounds === null) return [];
      const valid = Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite) &&
        bounds[0] <= bounds[2] && bounds[1] <= bounds[3];
      return [{ id: `published:${url.pathname}`, name, url, bounds: valid ? bounds : null }];
    });
    const displayed = new Set();
    const inFlight = new Map();
    const failed = new Set();
    let wanted = new Map();
    let queued = new Set();

    function loadVisibleFiles() {
      while (inFlight.size < 4 && queued.size) {
        const id = queued.values().next().value;
        queued.delete(id);
        const controller = new AbortController();
        inFlight.set(id, controller);
        loadFile(wanted.get(id), controller);
      }
      publishedStatus.textContent = inFlight.size
        ? `Loading published outings · ${displayed.size} of ${wanted.size}`
        : `${displayed.size} published route files in view.${failed.size ? ` Could not load ${failed.size}.` : ""}`;
    }

    async function loadFile({ id, name, url }, controller) {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error("Route unavailable.");
        const data = await response.json();
        if (controller.signal.aborted || !wanted.has(id)) return;
        const plotted = plotImportedRoute({ id, name, data, snapped: containsSnappedRoute(data) });
        if (!plotted) throw new Error("No map geometry found.");
        const repositoryFile = repositoryFolder && repositoryFolder + encodeURIComponent(name);
        importLayers.get(id).eachLayer(layer => bindPublishedOuting(layer, url, availablePhotos, repositoryFile));
        displayed.add(id);
        refreshMap();
      } catch {
        if (importLayers.has(id)) {
          removeImportedRoute(id);
          refreshMap();
        }
        if (!controller.signal.aborted) failed.add(id);
      } finally {
        inFlight.delete(id);
        if (controller.signal.aborted && wanted.has(id)) queued.add(id);
        loadVisibleFiles();
      }
    }

    function updateViewport() {
      const viewport = map.getBounds();
      wanted = new Map(routes.filter(route => !route.bounds || overlapsViewport(viewport, route.bounds))
        .map(route => [route.id, route]));
      queued = new Set([...wanted.keys()].filter(id => !displayed.has(id) && !inFlight.has(id)));
      failed.clear();
      for (const [id, controller] of inFlight) {
        if (!wanted.has(id)) controller.abort();
      }
      let changed = false;
      for (const id of displayed) {
        if (wanted.has(id)) continue;
        removeImportedRoute(id);
        displayed.delete(id);
        changed = true;
      }
      if (changed) refreshMap();
      loadVisibleFiles();
    }

    map.on("moveend", updateViewport);
    updateViewport();
  }

  if (["127.0.0.1", "localhost"].includes(window.location.hostname)) {
    restoreLibrary().then(loadPublishedRoutes).then(reopenRememberedFolder);
  } else {
    loadPublishedRoutes();
    reopenRememberedFolder();
  }


  function showLocation(point, center) {
    if (!marker) {
      marker = L.circleMarker(pointCoords(point), {
        radius: 7, color: "white", weight: 3, fillColor: "#1266a8", fillOpacity: 1
      }).addTo(map).bindTooltip("Your location");
    }
    marker.setLatLng(pointCoords(point)).bringToFront();
    if (center) map.setView(pointCoords(point), Math.max(map.getZoom(), 17));
  }

  function guestUploadURL(value) {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value.trim());
      return url.protocol === "https:" && !url.username && !url.password && !url.hash ? url : null;
    } catch {
      return null;
    }
  }

  function showUploadMethodStatus() {
    githubStatus.textContent = githubMethod.value === "guest" && !guestEndpoint && githubRepo
      ? "Guest uploads need a valid HTTPS guest_github_api_url in site.json."
      : "";
  }

  function configureGitHub(url, folder, guestURL) {
    if (!window.streetlogGitHub) {
      byId("github-repository").textContent = "GitHub controls could not load. Reload the page to retry.";
      return;
    }
    githubRepo = window.streetlogGitHub.repository(url);
    githubFolder = folder;
    guestEndpoint = guestUploadURL(guestURL);
    if (!githubRepo) {
      byId("github-repository").textContent = "Set a GitHub repository URL in site.json.";
      return;
    }
    const repo = githubRepo.join("/");
    const link = document.createElement("a");
    link.href = "https://github.com/" + repo;
    link.textContent = repo;
    byId("github-repository").replaceChildren(link);
    showUploadMethodStatus();
    syncCaptureControls();
    let savedToken;
    try {
      savedToken = localStorage.getItem(githubTokenKey());
    } catch {
      // Linking still works for the current visit.
    }
    rememberGitHub.checked = Boolean(savedToken);
    if (savedToken) {
      githubMethod.value = "token";
      syncCaptureControls();
      linkGitHub(savedToken, true);
    }
  }

  function githubTokenKey() {
    return "streetlog.github-token." + githubRepo.join("/").toLowerCase();
  }

  function storeGitHubPreference() {
    try {
      if (rememberGitHub.checked && linkedToken) {
        localStorage.setItem(githubTokenKey(), linkedToken);
      } else {
        localStorage.removeItem(githubTokenKey());
      }
      return true;
    } catch {
      rememberGitHub.checked = false;
      githubStatus.textContent = "Could not update the saved token. Check browser storage permissions.";
      return false;
    }
  }

  rememberGitHub.addEventListener("change", () => {
    if (!githubRepo || (rememberGitHub.checked && !linkedToken)) return;
    syncCaptureControls();
    if (storeGitHubPreference()) {
      githubStatus.textContent = rememberGitHub.checked
        ? "Token saved in this browser." : "Token will be forgotten after this visit.";
    }
  });

  githubForm.addEventListener("submit", event => {
    event.preventDefault();
    if (!githubRepo || githubLink.disabled) return;
    const token = githubToken.value.trim();
    githubToken.value = "";
    if (token) return linkGitHub(token);
  });

  async function linkGitHub(token, restoring = false) {
    linking = true;
    syncCaptureControls();
    githubStatus.textContent = "Checking GitHub account and repository…";
    try {
      const client = window.streetlogGitHub.connect(token);
      const account = (await client.user()).login;
      const target = await client.inspect(githubRepo, githubFolder, account);
      githubClient = client;
      githubTarget = target;
      linkedToken = token;
      byId("github-account").textContent = `${account} · ${target.role}`;
      githubStatus.textContent = `Ready · ${target.branch} / ${target.path}`;
      githubForm.hidden = true;
      githubUnlink.hidden = false;
      if (!restoring) storeGitHubPreference();
    } catch (error) {
      githubStatus.textContent = `Could not link GitHub: ${error.message}`;
      if (restoring && error.status === 401) {
        rememberGitHub.checked = false;
        storeGitHubPreference();
      }
    } finally {
      linking = false;
      syncCaptureControls();
    }
  }

  githubUnlink.addEventListener("click", () => {
    if (publishing || linking) return;
    githubClient = githubTarget = null;
    linkedToken = "";
    rememberGitHub.checked = false;
    byId("github-account").textContent = "Guest · no account linked";
    githubStatus.textContent = "";
    githubUnlink.hidden = true;
    githubForm.hidden = false;
    storeGitHubPreference();
    syncCaptureControls();
  });

  async function submitAsGuest(filename, data, photos) {
    const form = new FormData();
    form.append("geojson", new Blob([data], { type: "application/geo+json" }), filename);
    for (const photo of photos) form.append("photos", photo.blob, photo.name);
    const response = await fetch(guestEndpoint, {
      method: "POST", body: form, credentials: "omit", redirect: "error",
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `The submission API returned HTTP ${response.status}.`);
    const pullRequest = guestUploadURL(result.url);
    if (pullRequest?.hostname !== "github.com" || !/^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(pullRequest.pathname)) {
      throw new Error("The guest API did not return a GitHub pull request URL.");
    }
    return { url: pullRequest.href, pullRequest: true };
  }

  pushDraft.addEventListener("click", async () => {
    if (!draft || !canPublishGitHub() || matchingRecording || preparingPhotos || publishing) return;
    const target = githubTarget;
    const guest = githubMethod.value === "guest";
    const outing = draft;
    const audience = guest || !target.isPrivate ? " This outing can become publicly visible." : "";
    const destination = guest ? githubRepo.join("/") + " via " + guestEndpoint.host : target.repo.join("/") + "/" + target.path;
    const photos = outing.album ?? [];
    const attachments = photos.length ? ` and ${photos.length} attached photo${photos.length === 1 ? "" : "s"}` : "";
    if (!window.confirm(`Upload this outing${attachments} to ${destination}?${audience}`)) return;
    publishing = true;
    syncCaptureControls();
    byId("github-settings").open = true;
    githubStatus.textContent = "Uploading outing…";
    try {
      const filename = `streetlog-${outing.kind}-${outing.id}.geojson`;
      const data = JSON.stringify({ type: "FeatureCollection", features: outingFeatures(outing) });
      let result;
      if (guest) {
        result = await submitAsGuest(filename, data, photos);
      } else {
        const latest = await githubClient.inspect(githubRepo, githubFolder, target.account);
        if (latest.branch !== target.branch || latest.path !== target.path || latest.isPrivate !== target.isPrivate) {
          githubTarget = latest;
          throw new Error("The publishing destination changed. Review it before retrying.");
        }
        result = await githubClient.upload(latest, filename, data, photos);
      }
      const link = document.createElement("a");
      link.href = result.url;
      link.textContent = result.pullRequest ? "View pull request" : "View GitHub commit";
      link.target = "_blank";
      link.rel = "noopener";
      githubStatus.replaceChildren(link);
      closeDraft(result.pullRequest ? "Pull request opened" : "Outing pushed to GitHub");
    } catch (error) {
      githubStatus.textContent = `Upload failed: ${error.message}`;
    } finally {
      publishing = false;
      syncCaptureControls();
    }
  });

  function syncCaptureControls() {
    record.disabled = !gpsAvailable || locatingPin || Boolean(draft);
    dropPin.disabled = !gpsAvailable || locatingPin || Boolean(current || draft);
    snapStreets.disabled = Boolean(current || draft) || locatingPin;
    draftFields.hidden = !draft;
    draftExport.disabled = matchingRecording || preparingPhotos || publishing;
    photoPicker.disabled = preparingPhotos || publishing;
    for (const button of draftPhotoList.querySelectorAll("button")) button.disabled = publishing;
    discardDraft.disabled = publishing;
    draftCategory.disabled = draftDescription.disabled = categoryInput.disabled = byId("draft-category-add").disabled = publishing;
    githubMethod.disabled = publishing || linking;
    githubTokenSettings.hidden = githubMethod.value !== "token";
    pushDraft.disabled = !draft || !canPublishGitHub() || matchingRecording || preparingPhotos || publishing;
    githubUnlink.disabled = publishing || linking;
    githubToken.disabled = githubLink.disabled = rememberGitHub.disabled = !githubRepo || publishing || linking;
    githubUnlink.hidden = !githubTarget && !rememberGitHub.checked;
  }

  function showDraft(outing, message) {
    draft = outing;
    draftCategory.value = categoryName(outing.category);
    draftDescription.value = outing.description ?? "";
    categoryDetails.open = false;
    categoryInput.value = "";
    categoryStatus.textContent = "";
    draftPhotoStatus.textContent = "";
    renderDraftAlbum();
    status.textContent = message;
    hint.textContent = "Export or discard this outing before starting another.";
    syncCaptureControls();
    refreshMap();
  }

  function closeDraft(message) {
    for (const photo of draft?.album ?? []) URL.revokeObjectURL(photo.preview);
    draft = null;
    preparingPhotos = false;
    draftPhotoStatus.textContent = "";
    renderDraftAlbum();
    liveMatch = null;
    matchingRecording = false;
    status.textContent = message;
    hint.textContent = defaultHint;
    syncCaptureControls();
    refreshMap();
  }

  async function updateLiveMatch(preview) {
    for (const [index, segment] of preview.outing.segments.entries()) {
      const state = preview.segments.get(index) ?? { offset: 0, paths: [], statuses: [] };
      while (segment.length - state.offset >= matchBatchSize && current === preview.outing) {
        const coordinates = segment.slice(state.offset).map(({ lat, lng }) => [lng, lat]);
        const anchors = matchAnchorIndices(coordinates, false, matchBatchSize);
        if (anchors.length < matchBatchSize) break;
        const end = anchors.at(-1);
        const result = await matchStreetGeometry({
          type: "LineString", coordinates: coordinates.slice(0, end + 1)
        });
        if (liveMatch !== preview) return;
        state.paths.push(...result.data.coordinates);
        state.statuses.push(...result.data.streetSnappedParts);
        state.offset += end;
        preview.segments.set(index, state);
        if (result.matched) showRoutingAttribution();
        refreshMap();
      }
    }
  }

  async function finishRecording(outing, preview) {
    try {
      await preview.pending;
      if (draft !== outing) return;
      const sections = [];
      for (const [index, segment] of outing.segments.entries()) {
        if (segment.length < 2) {
          sections.push(null);
          continue;
        }
        const state = preview.segments.get(index) ?? { offset: 0, paths: [], statuses: [] };
        const coordinates = segment.slice(state.offset).map(({ lat, lng }) => [lng, lat]);
        if (coordinates.length > 1) {
          const { data } = await matchStreetGeometry({ type: "LineString", coordinates });
          if (draft !== outing) return;
          state.paths.push(...data.coordinates);
          state.statuses.push(...data.streetSnappedParts);
        }
        sections.push(state.statuses.some(Boolean) ? state : null);
      }
      outing.matchedSegments = sections.map(section => section?.paths ?? null);
      outing.matchStatuses = sections.map(section => section?.statuses ?? null);
      outing.snapped = sections.some(Boolean);
      status.textContent = outing.snapped
        ? "Unsaved recording · street matching complete"
        : "Unsaved recording · original GPS trail";
    } catch {
      if (draft === outing) status.textContent = "Unsaved recording · street matching unavailable";
    } finally {
      if (draft === outing) {
        liveMatch = null;
        matchingRecording = false;
        syncCaptureControls();
        refreshMap();
      }
    }
  }

  function stopRecording(message = "Ready to record") {
    if (watch !== null) navigator.geolocation.clearWatch(watch);
    watch = null;
    const outing = current;
    current = null;
    byId("dot").classList.remove("active");
    record.classList.remove("is-recording");
    byId("record-label").textContent = "Record";
    if (!outing.segments.length) {
      closeDraft(message);
      return;
    }
    matchingRecording = Boolean(liveMatch && outing.segments.some(segment => segment.length > 1));
    showDraft(outing, matchingRecording ? "Unsaved recording · finishing street matching…" : "Unsaved recording");
    if (matchingRecording) finishRecording(outing, liveMatch);
  }

  function geoError(error) {
    return error.code === 1 ? "Location permission denied" : "Waiting for a GPS signal";
  }

  function addPosition(position) {
    if (!current) return;
    const { latitude: lat, longitude: lng, accuracy } = position.coords;
    if (accuracy > 35) {
      status.textContent = "Waiting for more accurate GPS";
      return;
    }

    status.textContent = "Recording";
    const point = { lat, lng, time: position.timestamp, accuracy };
    const segment = current.segments.at(-1);
    const previous = segment?.at(-1);
    const first = !previous;
    showLocation(point, first);
    const elapsed = previous ? (point.time - previous.time) / 1000 : 0;
    if (!first && elapsed <= 0) return;
    const moved = first ? 0 : distance(previous, point);
    const newSegment = first || breakTrail || elapsed > 45 || moved / Math.max(1, elapsed) > 45;
    if (!newSegment && moved < Math.max(5, accuracy / 2)) return;

    if (newSegment) current.segments.push([point]);
    else segment.push(point);

    breakTrail = false;
    refreshMap();
    if (liveMatch && !liveMatch.pending) {
      const preview = liveMatch;
      preview.pending = updateLiveMatch(preview).finally(() => { preview.pending = null; });
    }
  }

  record.addEventListener("click", () => {
    if (current) {
      stopRecording();
      return;
    }
    if (!gpsAvailable || draft || locatingPin) return;
    const outing = { id: crypto.randomUUID(), kind: "recording", segments: [] };
    current = outing;
    liveMatch = snapStreets.checked ? { outing, segments: new Map(), pending: null } : null;
    breakTrail = false;
    syncCaptureControls();
    byId("dot").classList.add("active");
    record.classList.add("is-recording");
    byId("record-label").textContent = "Stop";
    status.textContent = "Waiting for GPS";
    hint.textContent = "Keep this page open and your phone awake for continuous tracking.";
    watch = navigator.geolocation.watchPosition(position => {
      if (current === outing) addPosition(position);
    }, error => {
      if (current !== outing) return;
      if (error.code === 1) stopRecording(geoError(error));
      else {
        breakTrail = true;
        status.textContent = geoError(error);
      }
    }, gpsOptions);
  });

  dropPin.addEventListener("click", () => {
    if (!gpsAvailable || current || draft || locatingPin) return;
    locatingPin = true;
    syncCaptureControls();
    status.textContent = "Locating pin…";
    navigator.geolocation.getCurrentPosition(async position => {
      const { latitude: lat, longitude: lng, accuracy } = position.coords;
      const point = { lat, lng, accuracy, time: position.timestamp };
      const outing = { id: crypto.randomUUID(), kind: "pin", segments: [[point]] };
      locatingPin = false;
      matchingRecording = snapStreets.checked;
      showDraft(outing, matchingRecording ? "Unsaved pin · matching to a walking path…" : "Unsaved pin");
      map.setView(pointCoords(point), Math.max(map.getZoom(), 17));
      if (!matchingRecording) return;
      try {
        const result = await requestRouting(`nearest/v1/driving/${lng.toFixed(6)},${lat.toFixed(6)}?number=1`);
        if (draft !== outing) return;
        const waypoint = result.waypoints?.[0];
        const [snappedLng, snappedLat] = waypoint?.location ?? [];
        if (result.code !== "Ok" || !Number.isFinite(waypoint?.distance) || waypoint.distance > 20 ||
            !Number.isFinite(snappedLng) || !Number.isFinite(snappedLat)) throw new Error("No nearby match");
        outing.recordedCoordinates = [[lng, lat]];
        Object.assign(point, { lat: snappedLat, lng: snappedLng });
        outing.snapped = true;
        status.textContent = "Unsaved pin · snapped to a walking path";
      } catch {
        if (draft === outing) status.textContent = "Unsaved pin · original GPS location";
      } finally {
        if (draft === outing) {
          matchingRecording = false;
          syncCaptureControls();
          refreshMap();
        }
      }
    }, error => {
      locatingPin = false;
      syncCaptureControls();
      status.textContent = error.code === 1 ? geoError(error) : "Could not locate pin. Try again.";
    }, { ...gpsOptions, maximumAge: 10000 });
  });

  async function sanitizePhoto(file) {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    try {
      const scale = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d", { alpha: false });
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.9));
      if (blob?.type !== "image/jpeg") throw new Error("Could not encode photo.");
      return blob;
    } finally {
      bitmap.close();
      canvas.width = canvas.height = 0;
    }
  }

  function renderDraftAlbum() {
    draftPhotoList.replaceChildren();
    const outing = draft;
    for (const photo of outing?.album ?? []) {
      const row = document.createElement("li");
      const link = document.createElement("a");
      link.href = photo.preview;
      link.download = photo.name;
      const image = document.createElement("img");
      image.src = photo.preview;
      image.alt = "";
      link.append(image, document.createTextNode(photo.name));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "outline";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove photo ${photo.name}`);
      remove.addEventListener("click", () => {
        if (draft !== outing || publishing) return;
        outing.album = outing.album.filter(item => item !== photo);
        URL.revokeObjectURL(photo.preview);
        draftPhotoStatus.textContent = "";
        renderDraftAlbum();
      });
      row.append(link, remove);
      draftPhotoList.append(row);
    }
  }

  async function addDraftPhotos(files) {
    if (!draft || preparingPhotos || publishing || !files.length) return;
    const outing = draft;
    outing.album ??= [];
    preparingPhotos = true;
    syncCaptureControls();
    draftPhotoStatus.textContent = "Preparing photos…";
    let added = 0;
    let failed = 0;
    try {
      for (const file of files) {
        if (draft !== outing) return;
        try {
          const blob = await sanitizePhoto(file);
          if (draft !== outing) return;
          const name = crypto.randomUUID().toUpperCase() + ".jpg";
          outing.album.push({ name, blob, preview: URL.createObjectURL(blob) });
          added++;
          renderDraftAlbum();
        } catch {
          failed++;
        }
      }
    } finally {
      if (draft === outing) {
        preparingPhotos = false;
        draftPhotoStatus.textContent = failed
          ? `Added ${added} of ${files.length} photos. Try JPEG or PNG for photos this browser could not open.`
          : "";
        syncCaptureControls();
      }
    }
  }

  photoPicker.addEventListener("click", () => draftPhotoFiles.click());
  draftPhotoFiles.addEventListener("change", () => {
    const files = [...draftPhotoFiles.files];
    draftPhotoFiles.value = "";
    return addDraftPhotos(files);
  });
  photoPicker.addEventListener("dragover", event => {
    event.preventDefault();
    event.dataTransfer.dropEffect = photoPicker.disabled ? "none" : "copy";
    if (!photoPicker.disabled) photoPicker.classList.add("is-dragging");
  });
  photoPicker.addEventListener("dragleave", () => photoPicker.classList.remove("is-dragging"));
  photoPicker.addEventListener("drop", event => {
    event.preventDefault();
    photoPicker.classList.remove("is-dragging");
    return addDraftPhotos([...event.dataTransfer.files]);
  });

  function selectDraftCategory(value) {
    if (!draft || publishing) return;
    const entry = getCategory(categoryKey(value) === categoryKey(uncategorized) ? uncategorized : value);
    draft.category = draftCategory.value = entry.name;
    if (!styleFor(entry).visible) {
      saveLayerPreferences(entry, { ...overrides.get(entry.key), visible: true });
      renderLayerControls();
    }
    refreshMap();
  }

  draftCategory.addEventListener("change", () => selectDraftCategory(draftCategory.value));

  byId("draft-category-form").addEventListener("submit", event => {
    event.preventDefault();
    if (!draft || publishing) return;
    const name = categoryInput.value.trim();
    if (!name) {
      categoryStatus.textContent = "Enter a category name.";
      return;
    }
    const existing = categoryKey(name) === categoryKey(uncategorized) || categoryLayers.has(categoryKey(name));
    selectDraftCategory(name);
    if (existing) {
      categoryStatus.textContent = "Selected the existing category.";
    } else {
      localCategories.add(name);
      try {
        localStorage.setItem(localCategoryKey, JSON.stringify([...localCategories]));
        categoryStatus.textContent = "Category added.";
      } catch {
        categoryStatus.textContent = "Category added for this visit.";
      }
    }
    categoryInput.value = "";
    categoryDetails.open = false;
  });

  draftDescription.addEventListener("input", () => {
    if (draft) draft.description = draftDescription.value;
  });
  discardDraft.addEventListener("click", () => {
    if (draft && !publishing) closeDraft("Outing discarded");
  });
  draftExport.addEventListener("click", () => {
    if (!draft || matchingRecording || preparingPhotos || publishing) return;
    downloadOutings([draft], `streetlog-${draft.kind}-${draft.id}.geojson`);
    closeDraft("GeoJSON export started");
  });
  window.addEventListener("beforeunload", event => {
    if (!current?.segments.length && !draft) return;
    event.preventDefault();
    event.returnValue = "";
  });

  locate.addEventListener("click", () => {
    locate.disabled = true;
    locate.textContent = "Locating…";
    const resetLocate = () => {
      locate.disabled = false;
      locate.textContent = "⌖ My location";
    };
    navigator.geolocation.getCurrentPosition(position => {
      showLocation({ lat: position.coords.latitude, lng: position.coords.longitude }, true);
      resetLocate();
    }, error => {
      resetLocate();
      locate.textContent = error.code === 1 ? "Location blocked · Retry" : "Location unavailable · Retry";
    }, gpsOptions);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && current) breakTrail = true;
  });

  function outingFeatures(outing) {
    return outing.segments.map((segment, index) => {
      const coordinates = segment.map(point => [point.lng, point.lat]);
      const singlePoint = coordinates.length === 1;
      const matched = outing.matchedSegments?.[index];
      const statuses = outing.matchStatuses?.[index] ?? (matched ? matched.map(() => false) : [false]);
      return {
        type: "Feature",
        properties: {
          outing: outing.id,
          outingKind: outing.kind ?? "recording",
          category: categoryName(outing.category),
          description: outing.description ?? "",
          photoFileNames: outing.album?.map(photo => photo.name) ?? outing.photoFileNames ?? [],
          streetSnapped: singlePoint ? outing.kind === "pin" && outing.snapped === true : statuses.every(Boolean),
          ...(outing.recordedCoordinates ? { recordedCoordinates: outing.recordedCoordinates } : {}),
          ...(matched ? { streetSnappedParts: statuses } : {}),
          timestamps: segment.map(point => Number.isFinite(point.time) && Number.isFinite(new Date(point.time).getTime())
            ? new Date(point.time).toISOString() : null),
          accuracyMeters: segment.map(point => point.accuracy),
          ...(matched ? { originalCoordinates: coordinates } : {})
        },
        geometry: matched ? { type: "MultiLineString", coordinates: matched } : {
          type: singlePoint ? "Point" : "LineString",
          coordinates: singlePoint ? coordinates[0] : coordinates
        }
      };
    });
  }

  function downloadOutings(selected, filename) {
    const features = selected.flatMap(outingFeatures);
    const blob = new Blob([JSON.stringify({ type: "FeatureCollection", features })],
      { type: "application/geo+json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  exportButton.addEventListener("click", () => {
    const selected = checkedRecorded.size ? outings.filter(outing => checkedRecorded.has(outing.id)) : outings;
    downloadOutings(selected, checkedRecorded.size ? "streetlog-selected.geojson" : "streetlog.geojson");
  });

  for (const name of localCategories) getCategory(name);
  syncCaptureControls();
  if (!gpsAvailable) {
    locate.disabled = true;
    status.textContent = "GPS unavailable";
    hint.textContent = "Open Streetlog in a browser over HTTPS or localhost.";
  }
}

init();
