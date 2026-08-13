'use strict';

(() => {
  const LIVE_BASE = "https://kladbm.github.io/BackgroundsTracker/";
  const OVERRIDES_URL = "https://raw.githubusercontent.com/Kladbm/BackgroundsTracker/main/custom/overrides.json";
  const GITHUB_API_BASE = "https://api.github.com/repos/Kladbm/BackgroundsTracker";
  const GITHUB_ACTIONS_URL = "https://github.com/Kladbm/BackgroundsTracker/actions";
  const TOKEN_STORAGE_KEY = "dittotracker.githubToken";
  const TYPE_LABELS = { sb: "Special", lc: "Location", custom: "Custom" };

  const state = {
    backgrounds: [],
    detailBySlug: new Map(),
    overrides: { background_patches: {}, pokemon_exclusions: {} },
    pending: {
      background_patches: {},
      pokemon_exclusions: {},
      pokemon_restores: {},
      pokemon_additions: {},
      custom_backgrounds: [],
    },
    adders: {},
    adderRequests: {},
    customDraft: { pokemon: [], heroFile: null, heroPreviewUrl: "" },
    pokedexCatalog: null,
    pokedexCatalogSource: "",
    type: "All",
    sort: "newest",
    search: "",
    activeSlug: null,
    shinyOn: true,
    pendingCollapsed: false,
    publishing: false,
  };

  const $ = (sel) => document.querySelector(sel);
  const liveUrl = (path) => new URL(path, LIVE_BASE).href;

  const normalizeOverrides = (value) => ({
    background_patches: {},
    pokemon_exclusions: {},
    ...(value && typeof value === "object" ? value : {}),
  });

  const fmtDate = (iso) => {
    if (!iso) return "-";
    const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
    if (Number.isNaN(d.getTime())) return "-";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  const dexLabel = (dex) => `#${String(dex).padStart(4, "0")}`;


  const slugify = (value) => value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const displayPokemonName = (slug) => slug
    .split("-")
    .map((part) => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join(" ");

  const filePreview = (file) => new Promise((resolve) => {
    if (!file) {
      resolve("");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => resolve("");
    reader.readAsDataURL(file);
  });

  const localDataUrl = (path) => new URL(`../public/${path}`, location.href).href;

  const loadPokedexCatalog = async () => {
    if (state.pokedexCatalog) return state.pokedexCatalog;
    const urls = [liveUrl("data/pokedex-catalog.json"), localDataUrl("data/pokedex-catalog.json")];
    let lastError = null;
    for (const url of urls) {
      try {
        const data = await fetchJson(url);
        state.pokedexCatalog = Array.isArray(data.pokemon) ? data.pokemon : [];
        state.pokedexCatalogSource = url;
        return state.pokedexCatalog;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error("Unable to load pokedex catalog.");
  };

  const pokemonChoicesFromCatalog = async (dex) => {
    const numericDex = Number(dex);
    const catalog = await loadPokedexCatalog();
    const choices = catalog
      .filter((entry) => entry.dex === numericDex)
      .map((entry) => ({
        dex: entry.dex,
        name: entry.name || displayPokemonName(entry.pokedex_slug),
        pokedex_slug: entry.pokedex_slug,
        species_slug: entry.species_slug || entry.pokedex_slug,
        types: Array.isArray(entry.types) ? entry.types : [],
        shiny_available: entry.shiny_available === true && Boolean(entry.image_shiny),
        image_normal: entry.image_normal || "",
        image_shiny: entry.image_shiny || "",
        preview_normal: entry.image_normal || "",
        normalSource: entry.image_normal || "",
      }))
      .filter((entry) => entry.image_normal)
      .sort((a, b) => {
        if (a.pokedex_slug === a.species_slug && b.pokedex_slug !== b.species_slug) return -1;
        if (b.pokedex_slug === b.species_slug && a.pokedex_slug !== a.species_slug) return 1;
        return a.pokedex_slug.localeCompare(b.pokedex_slug);
      });
    choices.catalogSource = state.pokedexCatalogSource;
    return choices;
  };

  const additionForOverrides = (draft) => ({
    dex: draft.dex,
    name: draft.name,
    pokedex_slug: draft.pokedex_slug,
    types: draft.types,
    shiny_available: draft.shiny_available,
  });
  const resolveAsset = (path) => {
    if (!path) return "";
    try {
      return new URL(path, LIVE_BASE).href;
    } catch {
      return "";
    }
  };

  const sortBackgrounds = (list) => {
    const copy = [...list];
    copy.sort((a, b) => {
      if (state.sort === "az" || state.sort === "za") {
        const cmp = a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
        return state.sort === "az" ? cmp : -cmp;
      }
      const aNull = !a.release_date;
      const bNull = !b.release_date;
      if (aNull && bNull) return 0;
      if (aNull) return 1;
      if (bNull) return -1;
      const cmp = a.release_date.localeCompare(b.release_date);
      return state.sort === "newest" ? -cmp : cmp;
    });
    return copy;
  };

  const visibleBackgrounds = () => {
    const q = state.search.trim().toLowerCase();
    const filtered = state.backgrounds.filter((b) => {
      if (state.type !== "All" && b.type !== state.type) return false;
      if (q && !b.title.toLowerCase().includes(q)) return false;
      return true;
    });
    return sortBackgrounds(filtered);
  };

  const renderCountLabel = (visibleCount) => {
    const total = state.backgrounds.length;
    const label = $("#count-label");
    label.replaceChildren();
    label.append("Displaying ");
    if (visibleCount < total) {
      const pill = document.createElement("span");
      pill.className = "count-pill";
      pill.textContent = `${visibleCount} of ${total}`;
      label.append(pill);
    } else {
      label.append(`${visibleCount} of ${total}`);
    }
    label.append(" live backgrounds.");
  };

  const buildCard = (b) => {
    const card = document.createElement("a");
    card.className = "card";
    card.href = `#${encodeURIComponent(b.slug)}`;
    card.dataset.slug = b.slug;

    const imgWrap = document.createElement("div");
    imgWrap.className = "card-img";
    const img = document.createElement("img");
    img.src = liveUrl(`images/backgrounds/${b.slug}.png`);
    img.alt = b.title;
    img.loading = "lazy";
    imgWrap.appendChild(img);

    const body = document.createElement("div");
    body.className = "card-body";

    const title = document.createElement("h2");
    title.className = "card-title";
    title.textContent = b.title;

    const meta = document.createElement("div");
    meta.className = "card-meta";

    const date = document.createElement("span");
    date.className = "card-date";
    date.textContent = fmtDate(b.release_date);

    const count = document.createElement("span");
    count.className = "card-count";
    count.textContent = String(b.pokemon_count ?? "-");

    meta.append(date, count);
    body.append(title, meta);
    card.append(imgWrap, body);
    return card;
  };

  const renderGrid = () => {
    const list = visibleBackgrounds();
    const grid = $("#grid");
    if (!list.length) {
      const empty = document.createElement("p");
      empty.className = "admin-empty";
      empty.textContent = "No backgrounds match the current filters.";
      grid.replaceChildren(empty);
    } else {
      grid.replaceChildren(...list.map(buildCard));
    }
    renderCountLabel(list.length);
  };

  const hideAllViews = () => {
    $(".admin-grid-head").hidden = true;
    $(".admin-detail-head").hidden = true;
    $(".admin-custom-head").hidden = true;
    $(".admin-publish-head").hidden = true;
    $("#grid").hidden = true;
    $("#detail").hidden = true;
    $("#custom-detail").hidden = true;
    $("#publish-review").hidden = true;
  };

  const showGrid = () => {
    state.activeSlug = null;
    hideAllViews();
    $(".admin-grid-head").hidden = false;
    $("#grid").hidden = false;
    document.title = "Admin Browse - Pokemon GO Backgrounds Tracker";
    if (location.hash) history.pushState("", document.title, location.pathname + location.search);
  };

  const showCustomForm = () => {
    state.activeSlug = null;
    hideAllViews();
    $(".admin-custom-head").hidden = false;
    $("#custom-detail").hidden = false;
    document.title = "Add custom background - Admin Browse";
    if (location.hash !== "#custom-new") history.pushState("", document.title, "#custom-new");
    renderCustomDraft();
    renderPending();
  };

  const showPublishReview = () => {
    state.activeSlug = null;
    hideAllViews();
    $(".admin-publish-head").hidden = false;
    $("#publish-review").hidden = false;
    document.title = "Review & publish - Admin Browse";
    if (location.hash !== "#publish") history.pushState("", document.title, "#publish");
    renderPublishReview();
    renderTokenState();
    renderPending();
  };

  const fetchJson = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  };

  const loadOverrides = async () => {
    const res = await fetch(OVERRIDES_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${OVERRIDES_URL}`);
    state.overrides = normalizeOverrides(await res.json());
  };

  const loadDetail = async (slug) => {
    if (!state.detailBySlug.has(slug)) {
      const request = fetchJson(liveUrl(`data/backgrounds/${encodeURIComponent(slug)}.json`)).then((data) => {
        state.detailBySlug.set(slug, data);
        return data;
      });
      state.detailBySlug.set(slug, request);
    }
    return state.detailBySlug.get(slug);
  };

  const renderEvent = (data) => {
    const evt = $("#event");
    evt.hidden = !data.event;
    if (!data.event) return;

    evt.classList.remove("has-event-image", "no-event-image");
    evt.classList.add("no-event-image");
    evt.href = data.event.url || "#";
    $("#event-name").textContent = data.event.name || "";
    $("#event-dates").textContent = data.event.date_range || "";

    const thumb = $("#event-thumb");
    thumb.hidden = true;
    thumb.alt = data.event.name || "";
    if (data.event.image) {
      thumb.src = resolveAsset(data.event.image);
      thumb.onload = () => {
        thumb.hidden = false;
        evt.classList.remove("no-event-image");
        evt.classList.add("has-event-image");
      };
      thumb.onerror = () => {
        thumb.hidden = true;
        evt.classList.remove("has-event-image");
        evt.classList.add("no-event-image");
      };
    }
  };

  const getBasePatch = (slug) =>
    (state.overrides.background_patches && state.overrides.background_patches[slug]) || null;

  const getBaseExclusions = (slug) =>
    new Set((state.overrides.pokemon_exclusions && state.overrides.pokemon_exclusions[slug]) || []);

  const getPendingExclusions = (slug) => new Set(state.pending.pokemon_exclusions[slug] || []);
  const getPendingRestores = (slug) => new Set(state.pending.pokemon_restores[slug] || []);

  const setArrayBucket = (bucket, slug, set) => {
    const list = [...set];
    if (list.length) bucket[slug] = list;
    else delete bucket[slug];
  };

  const effectiveExcludedSlugs = (slug) => {
    const set = getBaseExclusions(slug);
    for (const pSlug of getPendingRestores(slug)) set.delete(pSlug);
    for (const pSlug of getPendingExclusions(slug)) set.add(pSlug);
    return set;
  };

  const pokemonNameForSlug = (slug, pokedexSlug) => {
    const detail = state.detailBySlug.get(slug);
    if (!detail || typeof detail.then === "function") return pokedexSlug;
    const found = (detail.pokemon || []).find((p) => p.pokedex_slug === pokedexSlug);
    return found ? found.name : pokedexSlug;
  };

  const buildTypeIcons = (types = []) => {
    const wrap = document.createElement("span");
    wrap.className = "p-types";
    for (const t of types) {
      const icon = document.createElement("img");
      icon.className = "type-icon";
      icon.src = resolveAsset(`images/types/${t}.png`);
      icon.alt = t;
      icon.title = t;
      icon.loading = "lazy";
      wrap.appendChild(icon);
    }
    return wrap;
  };

  const catalogImageUrl = (url) => {
    if (!url) return "";
    const file = String(url).split("/").pop();
    if (!file) return url;
    return resolveAsset("images/pokemon/" + file);
  };

  const imageFor = (p) =>
    state.shinyOn && p.shiny_available && p.image_shiny ? resolveAsset(p.image_shiny) : resolveAsset(p.image_normal);

  const imageForCatalogChoice = (p) =>
    state.shinyOn && p.shiny_available && p.image_shiny ? catalogImageUrl(p.image_shiny) : catalogImageUrl(p.image_normal);

  const isShadowPokemon = (p) => String(p.pokedex_slug || "").endsWith("-shadow");

  const buildShadowBadge = () => {
    const badge = document.createElement("img");
    badge.className = "shadow-badge";
    badge.src = resolveAsset("images/icons/shadow.png");
    badge.alt = "";
    badge.loading = "lazy";
    badge.setAttribute("aria-hidden", "true");
    return badge;
  };

  const buildActionIcon = (kind) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const paths = kind === "restore"
      ? ["M3 7v6h6", "M21 17a9 9 0 0 0-15-6.7L3 13"]
      : kind === "remove"
        ? ["M18 6 6 18", "M6 6l12 12"]
        : ["M3 6h18", "M8 6V4h8v2", "M19 6l-1 14H6L5 6", "M10 11v6", "M14 11v6"];
    for (const d of paths) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    return svg;
  };

  const buildPokemonCard = (p, action = "exclude") => {
    const card = document.createElement("div");
    card.className = "pokemon-card admin-pokemon-card";
    card.dataset.pokedexSlug = p.pokedex_slug;
    card.title = p.name;

    const check = document.createElement("span");
    check.className = "p-check";
    check.textContent = "";
    check.setAttribute("aria-hidden", "true");

    const img = document.createElement("img");
    img.className = "p-img";
    img.src = imageFor(p);
    img.alt = p.name;
    img.loading = "lazy";
    img.addEventListener("error", () => {
      if (img.dataset.fallback === "1") return;
      const normalHref = new URL(resolveAsset(p.image_normal), location.href).href;
      if (img.src !== normalHref) {
        img.dataset.fallback = "1";
        img.src = resolveAsset(p.image_normal);
      }
    });

    const imgWrap = document.createElement("span");
    imgWrap.className = "p-img-wrap";
    imgWrap.appendChild(img);
    if (isShadowPokemon(p)) imgWrap.appendChild(buildShadowBadge());

    const name = document.createElement("span");
    name.className = "p-name";
    name.textContent = p.name;

    const dex = document.createElement("span");
    dex.className = "p-dex";
    dex.textContent = dexLabel(p.dex);

    const meta = document.createElement("span");
    meta.className = "p-meta";
    meta.append(dex, buildTypeIcons(p.types));

    const actionBtn = document.createElement("button");
    actionBtn.type = "button";
    actionBtn.className = "admin-pokemon-action";
    actionBtn.dataset.action = action;
    actionBtn.dataset.pokedexSlug = p.pokedex_slug;
    const label = action === "restore" ? "Restore " + p.name : "Remove " + p.name;
    actionBtn.title = label;
    actionBtn.setAttribute("aria-label", label);
    actionBtn.appendChild(buildActionIcon(action));

    card.append(check, imgWrap, name, meta, actionBtn);
    return card;
  };

  const pokemonBySlugForActive = () => {
    const data = state.detailBySlug.get(state.activeSlug);
    const map = new Map();
    if (data && typeof data.then !== "function") {
      for (const p of data.pokemon || []) map.set(p.pokedex_slug, p);
    }
    return map;
  };

  const renderPokemonForActive = () => {
    if (!state.activeSlug) return;
    const data = state.detailBySlug.get(state.activeSlug);
    if (!data || typeof data.then === "function") return;
    const excluded = effectiveExcludedSlugs(state.activeSlug);
    const pokemon = Array.isArray(data.pokemon) ? data.pokemon.filter((p) => !excluded.has(p.pokedex_slug)) : [];
    $("#pokemon-count").textContent = "(" + pokemon.length + ")";
    $("#pokemon-list").replaceChildren(...pokemon.map((p) => buildPokemonCard(p, "exclude")));
  };

  const renderExcludedForActive = () => {
    if (!state.activeSlug) return;
    const excluded = [...effectiveExcludedSlugs(state.activeSlug)];
    const pokemonBySlug = pokemonBySlugForActive();
    const cards = excluded
      .map((pokedexSlug) => pokemonBySlug.get(pokedexSlug))
      .filter(Boolean)
      .map((p) => buildPokemonCard(p, "restore"));
    $("#excluded-count").textContent = "(" + excluded.length + ")";
    $("#excluded-list").replaceChildren(...cards);
  };


  const renderPreview = (target, draft) => {
    const box = $(target);
    if (!draft) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }

    const tile = document.createElement("div");
    tile.className = "preview-tile";
    const img = document.createElement("img");
    img.src = draft.shiny_available && draft.image_shiny ? draft.image_shiny : draft.preview_normal || draft.image_normal || "";
    img.alt = draft.name;
    const text = document.createElement("span");
    const strong = document.createElement("strong");
    strong.textContent = draft.name;
    const meta = document.createElement("span");
    meta.textContent = dexLabel(draft.dex) + " / " + draft.pokedex_slug;
    const types = document.createElement("span");
    types.textContent = draft.types.join(", ");
    const source = document.createElement("span");
    source.textContent = draft.normalSource;
    const shiny = document.createElement("span");
    shiny.textContent = draft.shiny_available ? "Shiny available" : "No shiny sprite found";
    text.append(strong, meta, types, source, shiny);
    tile.append(img, text);
    box.replaceChildren(tile);
    box.hidden = false;
  };

  const renderVarietyPicker = (prefix, choices) => {
    const box = $("#" + prefix + "-varieties");
    if (!choices || choices.length <= 1) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    const label = document.createElement("span");
    label.className = "admin-variety-label";
    label.textContent = "Choose form";
    const strip = document.createElement("div");
    strip.className = "pokemon-grid admin-variety-strip";
    const buttons = choices.map((choice) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pokemon-card admin-variety-tile";
      btn.dataset.varietySlug = choice.pokedex_slug;
      btn.setAttribute("aria-pressed", "false");

      const imgWrap = document.createElement("span");
      imgWrap.className = "p-img-wrap";
      const img = document.createElement("img");
      img.className = "p-img";
      img.src = imageForCatalogChoice(choice);
      img.alt = choice.name;
      img.loading = "lazy";
      img.dataset.remoteSrc = choice.shiny_available && choice.image_shiny ? choice.image_shiny : choice.image_normal;
      img.addEventListener("error", () => {
        if (img.dataset.fallback === "1") return;
        img.dataset.fallback = "1";
        img.src = img.dataset.remoteSrc;
      });
      imgWrap.appendChild(img);

      const name = document.createElement("span");
      name.className = "p-name";
      name.textContent = choice.name;

      const dex = document.createElement("span");
      dex.className = "p-dex";
      dex.textContent = dexLabel(choice.dex);

      const meta = document.createElement("span");
      meta.className = "p-meta";
      meta.appendChild(dex);

      btn.append(imgWrap, name, meta);
      return btn;
    });
    strip.replaceChildren(...buttons);
    box.replaceChildren(label, strip);
    box.hidden = false;
  };

  const setAdderStatus = (prefix, message, kind = "") => {
    const el = $(`#${prefix}-status`);
    el.textContent = message;
    el.classList.toggle("error", kind === "error");
    el.classList.toggle("ok", kind === "ok");
  };

  const nextAdderToken = (prefix) => {
    state.adderRequests[prefix] = (state.adderRequests[prefix] || 0) + 1;
    return state.adderRequests[prefix];
  };

  const isCurrentAdderToken = (prefix, token) => state.adderRequests[prefix] === token;

  const resetAdder = (prefix, token = nextAdderToken(prefix)) => {
    state.adders[prefix] = null;
    $("#" + prefix + "-stage").disabled = true;
    renderVarietyPicker(prefix, null);
    renderPreview("#" + prefix + "-preview", null);
    return token;
  };

  const selectAdderChoice = async (prefix, choice) => {
    if (!choice) return;
    const token = nextAdderToken(prefix);
    const current = state.adders[prefix] || {};
    const inputDex = current.inputDex || $("#" + prefix + "-dex").value.trim();
    const choices = current.choices || [choice];
    $("#" + prefix + "-stage").disabled = true;
    $("#" + prefix + "-varieties").querySelectorAll("button[data-variety-slug]").forEach((btn) => {
      const active = btn.dataset.varietySlug === choice.pokedex_slug;
      btn.classList.toggle("active", active);
      btn.classList.toggle("collected", active);
      btn.setAttribute("aria-pressed", String(active));
    });

    const draft = { ...choice, inputDex, choices };
    if (!draft.image_normal) {
      if (!isCurrentAdderToken(prefix, token)) return;
      state.adders[prefix] = draft;
      setAdderStatus(prefix, "Dittobase sprite is not available for " + draft.pokedex_slug + "; can't add this pokemon.", "error");
      renderPreview("#" + prefix + "-preview", null);
      return;
    }

    if (!isCurrentAdderToken(prefix, token)) return;
    state.adders[prefix] = draft;
    $("#" + prefix + "-stage").disabled = false;
    setAdderStatus(prefix, "Selected " + draft.name + ". Ready to stage.", "ok");
  };

  const lookupAdderPokemon = async (prefix) => {
    const input = $("#" + prefix + "-dex");
    const dex = input.value.trim();
    const token = resetAdder(prefix);
    if (!dex) {
      setAdderStatus(prefix, "Enter a dex number, then press Enter or leave the field.");
      return;
    }
    if (!/^\d+$/.test(dex)) {
      setAdderStatus(prefix, "Dex must be a number.", "error");
      return;
    }
    setAdderStatus(prefix, "Looking up dex " + dex + " in the Dittobase catalog...");
    try {
      const choices = await pokemonChoicesFromCatalog(dex);
      if (!isCurrentAdderToken(prefix, token)) return;
      if (!choices.length) throw new Error("No released Dittobase catalog entries found for dex " + dex + ".");
      state.adders[prefix] = { inputDex: dex, choices };
      renderVarietyPicker(prefix, choices);
      if (choices.length > 1) {
        setAdderStatus(prefix, "Found " + choices.length + " released Dittobase forms from " + choices.catalogSource + ". Choose the specific form to add.", "ok");
      } else {
        await selectAdderChoice(prefix, choices[0]);
      }
    } catch (err) {
      if (!isCurrentAdderToken(prefix, token)) return;
      setAdderStatus(prefix, err.message, "error");
    }
  };

  const stageDetailAddition = () => {
    const slug = state.activeSlug;
    const draft = state.adders["detail-add"];
    if (!slug || !draft) return;
    if (!draft.image_normal) {
      setAdderStatus("detail-add", "This pokemon is not available on Dittobase and cannot be staged.", "error");
      return;
    }
    const addition = { ...additionForOverrides(draft), _normal_url: catalogImageUrl(draft.image_normal), _shiny_url: draft.image_shiny ? catalogImageUrl(draft.image_shiny) : "" };
    const list = state.pending.pokemon_additions[slug] || [];
    const next = list.filter((p) => p.pokedex_slug !== addition.pokedex_slug);
    next.push(addition);
    state.pending.pokemon_additions[slug] = next;
    setAdderStatus("detail-add", "Staged " + addition.name + " for " + slug + ".", "ok");
    renderPending();
  };

  const stageCustomPokemon = () => {
    const draft = state.adders["custom-add"];
    if (!draft) return;
    if (!draft.image_normal) {
      setAdderStatus("custom-add", "This pokemon is not available on Dittobase and cannot be added.", "error");
      return;
    }
    const addition = { ...additionForOverrides(draft), _normal_url: catalogImageUrl(draft.image_normal), _shiny_url: draft.image_shiny ? catalogImageUrl(draft.image_shiny) : "" };
    state.customDraft.pokemon = state.customDraft.pokemon.filter((p) => p.pokedex_slug !== addition.pokedex_slug);
    state.customDraft.pokemon.push(addition);
    setAdderStatus("custom-add", "Added " + addition.name + " to the custom background draft.", "ok");
    renderCustomDraft();
  };

  const bindAdder = (prefix, stageFn) => {
    const input = $("#" + prefix + "-dex");
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        lookupAdderPokemon(prefix);
      }
    });
    input.addEventListener("blur", () => {
      const current = state.adders[prefix];
      if (current && current.inputDex === input.value.trim()) return;
      lookupAdderPokemon(prefix);
    });
    $("#" + prefix + "-stage").addEventListener("click", stageFn);
    $("#" + prefix + "-varieties").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-variety-slug]");
      const current = state.adders[prefix];
      if (!btn || !current || !current.choices) return;
      if (current.pokedex_slug === btn.dataset.varietySlug) return;
      const choice = current.choices.find((item) => item.pokedex_slug === btn.dataset.varietySlug);
      selectAdderChoice(prefix, choice).catch((err) => setAdderStatus(prefix, err.message, "error"));
    });
  };

  const validateCustomSlug = () => {
    const slug = $("#custom-slug").value.trim();
    const status = $("#custom-slug-status");
    if (!slug) {
      status.textContent = "Slug pending";
      status.classList.remove("error", "ok");
      return false;
    }
    const collides = state.backgrounds.some((b) => b.slug === slug) || state.pending.custom_backgrounds.some((b) => b.slug === slug);
    status.textContent = collides ? "Slug already exists" : "Slug available";
    status.classList.toggle("error", collides);
    status.classList.toggle("ok", !collides);
    return !collides;
  };

  const syncCustomSlugFromTitle = () => {
    const slugInput = $("#custom-slug");
    if (!slugInput.dataset.touched) slugInput.value = `custom-${slugify($("#custom-title").value)}`.replace(/-+$/g, "");
    validateCustomSlug();
  };

  const renderCustomDraft = () => {
    validateCustomSlug();
    const list = $("#custom-pokemon-list");
    list.replaceChildren(...state.customDraft.pokemon.map((p) => {
      const item = document.createElement("div");
      item.className = "staged-item";
      item.textContent = `${p.name} (${dexLabel(p.dex)})`;
      return item;
    }));
  };

  const stageCustomBackground = () => {
    const slug = $("#custom-slug").value.trim();
    const title = $("#custom-title").value.trim();
    const releaseDate = $("#custom-release-date").value;
    const description = $("#custom-description").value;
    const status = $("#custom-slug-status");
    if (!title) {
      status.textContent = "Title is required";
      status.classList.add("error");
      return;
    }
    if (!validateCustomSlug()) return;
    if (!state.customDraft.heroFile) {
      status.textContent = "Hero image is required";
      status.classList.add("error");
      return;
    }
    const bg = { slug, type: "custom", title, release_date: releaseDate, description, event: null, pokemon: state.customDraft.pokemon.map((p) => ({ ...p })), _hero_file: state.customDraft.heroFile.name, _hero_file_obj: state.customDraft.heroFile };
    state.pending.custom_backgrounds = state.pending.custom_backgrounds.filter((item) => item.slug !== slug);
    state.pending.custom_backgrounds.push(bg);
    status.textContent = `Staged ${slug}`;
    status.classList.remove("error");
    status.classList.add("ok");
    renderPending();
  };
  const pendingCounts = () => {
    const patchSlugs = Object.keys(state.pending.background_patches);
    const excludedCount = Object.values(state.pending.pokemon_exclusions).reduce((sum, list) => sum + list.length, 0);
    const restoredCount = Object.values(state.pending.pokemon_restores).reduce((sum, list) => sum + list.length, 0);
    const additionCount = Object.values(state.pending.pokemon_additions).reduce((sum, list) => sum + list.length, 0);
    const customCount = state.pending.custom_backgrounds.length;
    return { patchSlugs, excludedCount, restoredCount, additionCount, customCount };
  };

  const pendingSummaryParts = () => {
    const { patchSlugs, excludedCount, restoredCount, additionCount, customCount } = pendingCounts();
    const parts = [];
    if (patchSlugs.length) parts.push(patchSlugs.length + " background patch" + (patchSlugs.length === 1 ? "" : "es"));
    if (excludedCount) parts.push(excludedCount + " pokemon excluded");
    if (restoredCount) parts.push(restoredCount + " pokemon restored");
    if (additionCount) parts.push(additionCount + " pokemon addition" + (additionCount === 1 ? "" : "s"));
    if (customCount) parts.push(customCount + " new custom background" + (customCount === 1 ? "" : "s"));
    return parts;
  };

  const hasPendingChanges = () => pendingSummaryParts().length > 0;

  const renderReviewSection = (title, rows) => {
    const section = document.createElement("section");
    section.className = "review-section";
    const h = document.createElement("h3");
    h.textContent = title;
    section.appendChild(h);
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "admin-empty-inline";
      empty.textContent = "None";
      section.appendChild(empty);
      return section;
    }
    const list = document.createElement("ul");
    for (const row of rows) {
      const item = document.createElement("li");
      item.textContent = row;
      list.appendChild(item);
    }
    section.appendChild(list);
    return section;
  };

  const renderPublishReview = () => {
    const box = $("#publish-review-list");
    if (!box) return;
    const patchRows = Object.entries(state.pending.background_patches).map(([slug, patch]) => {
      const fields = Object.keys(patch).join(", ") || "no fields";
      return slug + " (" + fields + ")";
    });
    const exclusionRows = Object.entries(state.pending.pokemon_exclusions).flatMap(([slug, list]) => list.map((pSlug) => slug + "/" + pSlug));
    const restoreRows = Object.entries(state.pending.pokemon_restores).flatMap(([slug, list]) => list.map((pSlug) => slug + "/" + pSlug));
    const additionRows = Object.entries(state.pending.pokemon_additions).flatMap(([slug, list]) => list.map((p) => slug + "/" + p.pokedex_slug + " (" + p.name + ")"));
    const customRows = state.pending.custom_backgrounds.map((bg) => bg.slug + " (" + bg.title + ", " + bg.pokemon.length + " pokemon)");
    const imageRows = imageUploadPlans().map((plan) => plan.path);
    box.replaceChildren(
      renderReviewSection("Background patches", patchRows),
      renderReviewSection("Pokemon exclusions", exclusionRows),
      renderReviewSection("Pokemon restores", restoreRows),
      renderReviewSection("Pokemon additions", additionRows),
      renderReviewSection("Custom backgrounds", customRows),
      renderReviewSection("Images to upload", imageRows)
    );
    $("#publish-button").disabled = !hasPendingChanges() || state.publishing;
  };

  const renderPending = () => {
    const { patchSlugs } = pendingCounts();
    const parts = pendingSummaryParts();
    const hasPending = parts.length > 0;
    $("#pending-summary").textContent = hasPending ? parts.join(", ") : "No pending changes";
    $("#pending-dot").hidden = !hasPending || !state.pendingCollapsed;
    $("#pending-panel").classList.toggle("collapsed", state.pendingCollapsed);
    $("#pending-toggle").setAttribute("aria-expanded", String(!state.pendingCollapsed));
    $("#pending-toggle").title = state.pendingCollapsed ? "Expand pending changes" : "Collapse pending changes";

    const items = [];
    for (const slug of patchSlugs) items.push(pendingItem("Patch: " + slug, "background_patches", slug));
    for (const [slug, list] of Object.entries(state.pending.pokemon_exclusions)) for (const pSlug of list) items.push(pendingItem("Exclude: " + slug + "/" + pSlug, "pokemon_exclusions", slug, pSlug));
    for (const [slug, list] of Object.entries(state.pending.pokemon_restores)) for (const pSlug of list) items.push(pendingItem("Restore: " + slug + "/" + pSlug, "pokemon_restores", slug, pSlug));
    for (const [slug, list] of Object.entries(state.pending.pokemon_additions)) for (const p of list) items.push(pendingItem("Add: " + slug + "/" + p.pokedex_slug, "pokemon_additions", slug, p.pokedex_slug));
    for (const bg of state.pending.custom_backgrounds) items.push(pendingItem("Custom background: " + bg.slug, "custom_backgrounds", bg.slug));
    $("#pending-list").replaceChildren(...items);
    renderPublishReview();
  };

  const pendingItem = (text, bucket, slug, pokedexSlug = "") => {
    const item = document.createElement("li");
    item.className = "pending-item";
    const label = document.createElement("span");
    label.textContent = text;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pending-remove";
    btn.dataset.bucket = bucket;
    btn.dataset.slug = slug;
    if (pokedexSlug) btn.dataset.pokedexSlug = pokedexSlug;
    btn.title = "Remove pending change";
    btn.setAttribute("aria-label", "Remove pending change: " + text);
    btn.appendChild(buildActionIcon("remove"));
    item.append(label, btn);
    return item;
  };

  const removePendingItem = (bucket, slug, pokedexSlug = "") => {
    if (bucket === "background_patches") {
      delete state.pending.background_patches[slug];
    } else if (bucket === "pokemon_exclusions" || bucket === "pokemon_restores") {
      const set = new Set(state.pending[bucket][slug] || []);
      set.delete(pokedexSlug);
      setArrayBucket(state.pending[bucket], slug, set);
      renderPokemonForActive();
      renderExcludedForActive();
    } else if (bucket === "pokemon_additions") {
      const next = (state.pending.pokemon_additions[slug] || []).filter((p) => p.pokedex_slug !== pokedexSlug);
      if (next.length) state.pending.pokemon_additions[slug] = next;
      else delete state.pending.pokemon_additions[slug];
    } else if (bucket === "custom_backgrounds") {
      state.pending.custom_backgrounds = state.pending.custom_backgrounds.filter((bg) => bg.slug !== slug);
    }
    renderPending();
  };

  const getStoredToken = () => localStorage.getItem(TOKEN_STORAGE_KEY) || "";

  const setStoredToken = (token) => {
    const value = token.trim();
    if (value) localStorage.setItem(TOKEN_STORAGE_KEY, value);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
    renderTokenState();
  };

  const renderTokenState = (prompt = false) => {
    const token = getStoredToken();
    const tokenPanel = $("#token-panel");
    const tokenStatus = $("#token-status");
    if (!tokenPanel || !tokenStatus) return;
    tokenPanel.hidden = Boolean(token) || !prompt;
    tokenStatus.textContent = token
      ? "GitHub token stored locally."
      : (prompt ? "Enter a GitHub token before publishing." : "No GitHub token stored.");
    const input = $("#github-token");
    if (input && token) input.value = "";
  };

  const normalizePublishOverrides = (value) => ({
    background_patches: {},
    pokemon_exclusions: {},
    pokemon_additions: {},
    custom_backgrounds: [],
    ...(value && typeof value === "object" ? value : {}),
  });

  const uniqueList = (list) => [...new Set((list || []).filter(Boolean))];

  const mergePokemonList = (current = [], staged = []) => {
    const bySlug = new Map();
    for (const p of current) if (p && p.pokedex_slug) bySlug.set(p.pokedex_slug, p);
    for (const p of staged) if (p && p.pokedex_slug) bySlug.set(p.pokedex_slug, additionForOverrides(p));
    return [...bySlug.values()];
  };

  const mergePendingIntoOverrides = (baseOverrides) => {
    const merged = normalizePublishOverrides(JSON.parse(JSON.stringify(baseOverrides || {})));
    for (const [slug, patch] of Object.entries(state.pending.background_patches)) {
      merged.background_patches[slug] = { ...(merged.background_patches[slug] || {}), ...patch };
    }
    for (const [slug, list] of Object.entries(state.pending.pokemon_exclusions)) {
      merged.pokemon_exclusions[slug] = uniqueList([...(merged.pokemon_exclusions[slug] || []), ...list]);
    }
    for (const [slug, list] of Object.entries(state.pending.pokemon_restores)) {
      const restoreSet = new Set(list);
      const next = (merged.pokemon_exclusions[slug] || []).filter((pSlug) => !restoreSet.has(pSlug));
      if (next.length) merged.pokemon_exclusions[slug] = next;
      else delete merged.pokemon_exclusions[slug];
    }
    for (const [slug, list] of Object.entries(state.pending.pokemon_additions)) {
      const next = mergePokemonList(merged.pokemon_additions[slug] || [], list);
      if (next.length) merged.pokemon_additions[slug] = next;
      else delete merged.pokemon_additions[slug];
    }
    for (const bg of state.pending.custom_backgrounds) {
      const clean = {
        slug: bg.slug,
        type: bg.type || "custom",
        title: bg.title,
        release_date: bg.release_date || null,
        description: bg.description || "",
        event: bg.event || null,
        pokemon: (bg.pokemon || []).map(additionForOverrides),
      };
      merged.custom_backgrounds = (merged.custom_backgrounds || []).filter((item) => item.slug !== clean.slug);
      merged.custom_backgrounds.push(clean);
    }
    return merged;
  };

  const bytesToBinary = (bytes) => {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return binary;
  };

  const textToBase64 = (text) => btoa(bytesToBinary(new TextEncoder().encode(text)));

  const base64ToText = (value) => new TextDecoder().decode(Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0)));

  const fileToBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",").pop() : result);
    };
    reader.onerror = () => reject(new Error("Failed to read " + file.name));
    reader.readAsDataURL(file);
  });

  const urlToBase64 = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
    return fileToBase64(await res.blob());
  };

  const uploadPlanContent = (plan) => plan.file ? fileToBase64(plan.file) : urlToBase64(plan.url);

  const githubHeaders = (token) => ({
    "Accept": "application/vnd.github+json",
    "Authorization": "Bearer " + token,
    "X-GitHub-Api-Version": "2022-11-28",
  });

  const githubContentUrl = (path) => GITHUB_API_BASE + "/contents/" + path.split("/").map(encodeURIComponent).join("/");

  const githubRequest = async (path, options, token) => {
    const res = await fetch(githubContentUrl(path), {
      ...options,
      headers: { ...githubHeaders(token), ...(options && options.headers ? options.headers : {}) },
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); }
      catch { data = { message: text }; }
    }
    if (!res.ok) {
      const message = data && data.message ? data.message : res.statusText;
      const err = new Error("GitHub " + res.status + ": " + message);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  };

  const readGithubContent = async (path, token) => githubRequest(path, { method: "GET" }, token);

  const putGithubContent = async ({ path, contentBase64, sha, message }, token) => githubRequest(path, {
    method: "PUT",
    body: JSON.stringify({ message, content: contentBase64, sha, branch: "main" }),
  }, token);

  const imageUploadPlans = () => {
    const plans = [];
    for (const bg of state.pending.custom_backgrounds) {
      if (bg._hero_file_obj) plans.push({ path: "custom/images/backgrounds/" + bg.slug + ".png", file: bg._hero_file_obj });
    }
    return plans;
  };

  const publishStatus = (message, kind = "") => {
    const box = $("#publish-status");
    if (!box) return;
    const row = document.createElement("div");
    row.className = "publish-result" + (kind ? " " + kind : "");
    row.textContent = message;
    box.appendChild(row);
  };

  const clearPendingState = () => {
    state.pending = { background_patches: {}, pokemon_exclusions: {}, pokemon_restores: {}, pokemon_additions: {}, custom_backgrounds: [] };
    renderPokemonForActive();
    renderExcludedForActive();
    renderPending();
    renderPublishReview();
  };

  const publishChanges = async () => {
    if (state.publishing) return;
    if (!hasPendingChanges()) {
      publishStatus("No pending changes to publish.", "error");
      return;
    }
    let token = getStoredToken();
    const input = $("#github-token");
    if (!token && input && input.value.trim()) {
      setStoredToken(input.value);
      token = getStoredToken();
    }
    if (!token) {
      renderTokenState(true);
      publishStatus("Enter a GitHub token before publishing.", "error");
      return;
    }
    state.publishing = true;
    $("#publish-button").disabled = true;
    $("#publish-status").replaceChildren();
    try {
      publishStatus("Fetching current custom/overrides.json from GitHub...");
      const current = await readGithubContent("custom/overrides.json", token);
      const decoded = base64ToText((current.content || "").replace(/\n/g, ""));
      const currentOverrides = normalizePublishOverrides(JSON.parse(decoded || "{}"));
      const merged = mergePendingIntoOverrides(currentOverrides);
      const content = JSON.stringify(merged, null, 2) + "\n";
      publishStatus("Publishing custom/overrides.json...");
      await putGithubContent({ path: "custom/overrides.json", contentBase64: textToBase64(content), sha: current.sha, message: "Update custom overrides from admin" }, token);
      publishStatus("Published custom/overrides.json", "ok");

      for (const plan of imageUploadPlans()) {
        publishStatus("Publishing " + plan.path + "...");
        let sha = undefined;
        try {
          const existing = await readGithubContent(plan.path, token);
          sha = existing.sha;
        } catch (err) {
          if (err.status !== 404) throw err;
        }
        await putGithubContent({ path: plan.path, contentBase64: await uploadPlanContent(plan), sha, message: "Update " + plan.path + " from admin" }, token);
        publishStatus("Published " + plan.path, "ok");
      }

      clearPendingState();
      const link = document.createElement("a");
      link.href = GITHUB_ACTIONS_URL;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "Open GitHub Actions";
      const row = document.createElement("div");
      row.className = "publish-result ok";
      row.append("Publish complete. The deploy workflow should start automatically. ", link);
      $("#publish-status").appendChild(row);
    } catch (err) {
      if (err.status === 401) publishStatus("GitHub rejected the token (401). Check that it is valid and has repo scope.", "error");
      else if (err.status === 409) publishStatus("GitHub reported a sha conflict (409). Reload current overrides and review before publishing again.", "error");
      else publishStatus(err.message || String(err), "error");
    } finally {
      state.publishing = false;
      renderPublishReview();
    }
  };

  const stagePatchFromFields = () => {
    const slug = state.activeSlug;
    if (!slug) return;
    const data = state.detailBySlug.get(slug);
    if (!data || typeof data.then === "function") return;

    const title = $("#edit-title").value;
    const description = $("#edit-description").value;
    const basePatch = getBasePatch(slug);
    const sourceTitle = basePatch && Object.hasOwn(basePatch, "title") ? basePatch.title : data.title || "";
    const sourceDescription = basePatch && Object.hasOwn(basePatch, "description") ? basePatch.description : data.description || "";
    const changed = title !== sourceTitle || description !== sourceDescription;
    const patch = {};
    if (title !== (data.title || "")) patch.title = title;
    if (description !== (data.description || "")) patch.description = description;

    if (changed && Object.keys(patch).length) state.pending.background_patches[slug] = patch;
    else delete state.pending.background_patches[slug];
    $("#page-title").textContent = title || data.title;
    renderPending();
  };

  const stageExclude = (slug, pokedexSlug) => {
    const exclusions = getPendingExclusions(slug);
    exclusions.add(pokedexSlug);
    setArrayBucket(state.pending.pokemon_exclusions, slug, exclusions);

    const restores = getPendingRestores(slug);
    restores.delete(pokedexSlug);
    setArrayBucket(state.pending.pokemon_restores, slug, restores);

    renderPokemonForActive();
    renderExcludedForActive();
    renderPending();
  };

  const stageRestore = (slug, pokedexSlug) => {
    const exclusions = getPendingExclusions(slug);
    exclusions.delete(pokedexSlug);
    setArrayBucket(state.pending.pokemon_exclusions, slug, exclusions);

    const base = getBaseExclusions(slug);
    const restores = getPendingRestores(slug);
    if (base.has(pokedexSlug)) restores.add(pokedexSlug);
    else restores.delete(pokedexSlug);
    setArrayBucket(state.pending.pokemon_restores, slug, restores);

    renderPokemonForActive();
    renderExcludedForActive();
    renderPending();
  };

  const showDetail = async (slug) => {
    window.scrollTo(0, 0);
    state.activeSlug = slug;
    hideAllViews();
    $(".admin-detail-head").hidden = false;
    $("#detail").hidden = false;
    $("#page-title").textContent = "Loading...";
    $("#pokemon-list").replaceChildren();
    $("#excluded-list").replaceChildren();
    resetAdder("detail-add");

    const data = await loadDetail(slug);
    if (state.activeSlug !== slug) return;

    const basePatch = getBasePatch(slug);
    const pendingPatch = state.pending.background_patches[slug];
    const titleValue = pendingPatch && Object.hasOwn(pendingPatch, "title")
      ? pendingPatch.title
      : basePatch && Object.hasOwn(basePatch, "title")
        ? basePatch.title
        : data.title || "";
    const descriptionValue = pendingPatch && Object.hasOwn(pendingPatch, "description")
      ? pendingPatch.description
      : basePatch && Object.hasOwn(basePatch, "description")
        ? basePatch.description
        : data.description || "";

    document.title = `${titleValue} - Admin Browse`;
    $("#page-title").textContent = titleValue;
    $("#hero-img").src = liveUrl(`images/backgrounds/${data.slug}.png`);
    $("#hero-img").alt = titleValue;
    $("#meta-date").textContent = `Released ${fmtDate(data.release_date)}`;
    $("#edit-title").value = titleValue;
    $("#edit-description").value = descriptionValue;

    const patchStatus = $("#patch-status");
    patchStatus.textContent = basePatch ? "Already patched" : "Not patched";
    patchStatus.classList.toggle("already-patched", Boolean(basePatch));

    renderEvent(data);
    const pokemon = Array.isArray(data.pokemon) ? data.pokemon : [];
    $("#pokemon-count").textContent = `(${pokemon.length})`;
    renderPokemonForActive();
    renderExcludedForActive();
    renderPending();
    requestAnimationFrame(() => window.scrollTo(0, 0));
  };

  const buildTypeControls = () => {
    const present = new Set(state.backgrounds.map((b) => b.type));
    const menu = $("#type-controls .dropdown-menu");
    for (const t of ["sb", "lc", "custom"]) {
      if (!present.has(t)) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.type = t;
      btn.textContent = TYPE_LABELS[t] || t;
      btn.setAttribute("aria-pressed", "false");
      menu.appendChild(btn);
    }
  };

  const setActive = (containerSel, activeBtn) => {
    $(containerSel).querySelectorAll("button").forEach((btn) => {
      const active = btn === activeBtn;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
  };

  const wireControls = () => {
    $("#search").addEventListener("input", (e) => {
      state.search = e.target.value;
      renderGrid();
    });

    $("#sort-controls").addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn || !btn.dataset.sort) return;
      state.sort = btn.dataset.sort;
      setActive("#sort-controls", btn);
      $("#sort-label").textContent = btn.textContent;
      $("#sort-controls").open = false;
      renderGrid();
    });

    $("#type-controls").addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn || !btn.dataset.type) return;
      state.type = btn.dataset.type;
      setActive("#type-controls", btn);
      $("#type-label").textContent = btn.textContent;
      $("#type-controls").open = false;
      renderGrid();
    });

    $("#edit-title").addEventListener("input", stagePatchFromFields);
    $("#edit-description").addEventListener("input", stagePatchFromFields);
    $("#admin-shiny-toggle").checked = state.shinyOn;
    $("#admin-shiny-toggle").addEventListener("change", (e) => {
      state.shinyOn = e.target.checked;
      renderPokemonForActive();
    });
    $("#pending-toggle").addEventListener("click", () => {
      state.pendingCollapsed = !state.pendingCollapsed;
      renderPending();
    });

    $("#pending-list").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-bucket]");
      if (!btn) return;
      e.stopPropagation();
      removePendingItem(btn.dataset.bucket, btn.dataset.slug, btn.dataset.pokedexSlug || "");
    });

    $("#grid").addEventListener("click", (e) => {
      const card = e.target.closest(".card");
      if (!card) return;
      e.preventDefault();
      history.pushState("", "", `#${encodeURIComponent(card.dataset.slug)}`);
      showDetail(card.dataset.slug).catch(showError);
    });

    $("#pokemon-list").addEventListener("click", (e) => {
      const btn = e.target.closest('button[data-action="exclude"]');
      if (!btn || !state.activeSlug) return;
      stageExclude(state.activeSlug, btn.dataset.pokedexSlug);
    });

    $("#excluded-list").addEventListener("click", (e) => {
      const btn = e.target.closest('button[data-action="restore"]');
      if (!btn || !state.activeSlug) return;
      stageRestore(state.activeSlug, btn.dataset.pokedexSlug);
    });

    $("#back-to-grid").addEventListener("click", showGrid);
    $("#new-custom-background").addEventListener("click", showCustomForm);
    $("#review-publish").addEventListener("click", showPublishReview);
    $("#pending-review-publish").addEventListener("click", showPublishReview);
    $("#custom-back-to-grid").addEventListener("click", showGrid);
    $("#publish-back-to-grid").addEventListener("click", showGrid);
    $("#publish-button").addEventListener("click", publishChanges);
    $("#forget-token").addEventListener("click", () => { setStoredToken(""); publishStatus("GitHub token forgotten."); });
    $("#github-token").addEventListener("change", (e) => setStoredToken(e.target.value));
    bindAdder("detail-add", stageDetailAddition);
    bindAdder("custom-add", stageCustomPokemon);
    $("#custom-title").addEventListener("input", syncCustomSlugFromTitle);
    $("#custom-slug").addEventListener("input", (e) => {
      e.target.dataset.touched = "1";
      validateCustomSlug();
    });
    $("#custom-hero-upload").addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      state.customDraft.heroFile = file || null;
      state.customDraft.heroPreviewUrl = await filePreview(file);
      const box = $("#custom-hero-preview");
      if (!file) {
        box.hidden = true;
        box.replaceChildren();
        return;
      }
      const tile = document.createElement("div");
      tile.className = "preview-tile";
      const img = document.createElement("img");
      img.src = state.customDraft.heroPreviewUrl;
      img.alt = file.name;
      const text = document.createElement("span");
      text.innerHTML = `<strong>${file.name}</strong><span>Manual hero upload</span>`;
      tile.append(img, text);
      box.replaceChildren(tile);
      box.hidden = false;
    });
    $("#custom-stage-background").addEventListener("click", stageCustomBackground);
    window.addEventListener("popstate", () => {
      const slug = decodeURIComponent(location.hash.replace(/^#/, ""));
      if (slug === "custom-new") showCustomForm();
      else if (slug === "publish") showPublishReview();
      else if (slug) showDetail(slug).catch(showError);
      else showGrid();
    });
  };

  const showError = (err) => {
    console.error("Admin browse failed:", err);
    const message = err && err.message ? err.message : String(err);
    if (state.activeSlug) {
      $("#pokemon-list").replaceChildren();
      $("#page-title").textContent = "Failed to load background";
      $("#edit-description").value = message;
    } else {
      $("#grid").textContent = `Failed to load live data (${message})`;
    }
  };

  const main = async () => {
    await loadOverrides();
    const index = await fetchJson(liveUrl("data/index.json"));
    state.backgrounds = Array.isArray(index.backgrounds) ? index.backgrounds : [];
    buildTypeControls();
    wireControls();
    renderTokenState();
    renderPending();
    renderGrid();

    const slug = decodeURIComponent(location.hash.replace(/^#/, ""));
    if (slug === "custom-new") showCustomForm();
    else if (slug === "publish") showPublishReview();
    else if (slug) await showDetail(slug);
  };

  main().catch(showError);
})();
