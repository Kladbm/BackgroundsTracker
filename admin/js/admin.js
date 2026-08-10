'use strict';

(() => {
  const LIVE_BASE = "https://kladbm.github.io/BackgroundsTracker/";
  const OVERRIDES_URL = "https://raw.githubusercontent.com/Kladbm/BackgroundsTracker/main/custom/overrides.json";
  const POKEAPI_BASE = "https://pokeapi.co/api/v2/pokemon/";
  const DITTOBASE_POKEMON_BASE = "https://assets.dittobase.com/go/pokemon/";
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
    customDraft: { pokemon: [], heroFile: null, heroPreviewUrl: "" },
    type: "All",
    sort: "newest",
    search: "",
    activeSlug: null,
    shinyOn: true,
    pendingCollapsed: false,
  };

  const $ = (sel) => document.querySelector(sel);
  const liveUrl = (path) => new URL(path, LIVE_BASE).href;
  const assetPokemonUrl = (dex, slug, shiny = false) => `${DITTOBASE_POKEMON_BASE}${dex}-${slug}${shiny ? "-shiny" : ""}.png`;

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

  const checkImage = (url) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });

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

  const pokemonDraftFromApiData = (data, nationalDex) => ({
    dex: nationalDex,
    name: displayPokemonName(data.name),
    pokedex_slug: data.name,
    types: (data.types || []).sort((a, b) => a.slot - b.slot).map((entry) => entry.type.name),
    shiny_available: false,
  });

  const pokemonChoicesFromPokeApi = async (dex) => {
    const res = await fetch(POKEAPI_BASE + encodeURIComponent(dex));
    if (!res.ok) throw new Error("PokeAPI returned HTTP " + res.status + " for dex " + dex);
    const data = await res.json();
    if (!data.species || !data.species.url) throw new Error("PokeAPI response for " + dex + " did not include a species resource.");

    const speciesRes = await fetch(data.species.url);
    if (!speciesRes.ok) throw new Error("PokeAPI returned HTTP " + speciesRes.status + " for " + data.species.url);
    const species = await speciesRes.json();
    const nationalDex = Number.isFinite(species.id) ? species.id : data.id;
    const varieties = Array.isArray(species.varieties) && species.varieties.length
      ? species.varieties
      : [{ pokemon: { name: data.name, url: POKEAPI_BASE + data.name } }];

    const fetched = await Promise.all(varieties.map(async (entry) => {
      if (entry.pokemon && entry.pokemon.name === data.name) return data;
      const varietyRes = await fetch(entry.pokemon.url);
      if (!varietyRes.ok) return null;
      return varietyRes.json();
    }));

    const choices = fetched
      .filter(Boolean)
      .map((entry) => pokemonDraftFromApiData(entry, nationalDex));
    choices.sort((a, b) => {
      if (a.pokedex_slug === data.name) return -1;
      if (b.pokedex_slug === data.name) return 1;
      return a.pokedex_slug.localeCompare(b.pokedex_slug);
    });
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
    $("#grid").hidden = true;
    $("#detail").hidden = true;
    $("#custom-detail").hidden = true;
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

  const imageFor = (p) =>
    state.shinyOn && p.shiny_available && p.image_shiny ? resolveAsset(p.image_shiny) : resolveAsset(p.image_normal);

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

  const buildPokemonCard = (p) => {
    const staged = effectiveExcludedSlugs(state.activeSlug).has(p.pokedex_slug);
    const card = document.createElement("div");
    card.className = "pokemon-card admin-pokemon-card" + (staged ? " staged-excluded" : "");
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

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "admin-remove-pokemon";
    remove.dataset.action = "exclude";
    remove.dataset.pokedexSlug = p.pokedex_slug;
    remove.textContent = staged ? "✓" : "×";
    remove.title = staged ? "Staged for removal" : "Remove " + p.name;
    remove.setAttribute("aria-label", remove.title);
    remove.disabled = staged;

    card.append(check, imgWrap, name, meta, remove);
    return card;
  };

  const buildExcludedItem = (pokedexSlug) => {
    const item = document.createElement("div");
    item.className = "excluded-item";

    const label = document.createElement("span");
    label.textContent = pokemonNameForSlug(state.activeSlug, pokedexSlug);

    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "dropdown-trigger";
    restore.dataset.action = "restore";
    restore.dataset.pokedexSlug = pokedexSlug;
    restore.textContent = "Restore";

    item.append(label, restore);
    return item;
  };

  const renderPokemonForActive = () => {
    if (!state.activeSlug) return;
    const data = state.detailBySlug.get(state.activeSlug);
    if (!data || typeof data.then === "function") return;
    const pokemon = Array.isArray(data.pokemon) ? data.pokemon : [];
    $("#pokemon-list").replaceChildren(...pokemon.map(buildPokemonCard));
  };

  const renderExcludedForActive = () => {
    if (!state.activeSlug) return;
    const excluded = [...effectiveExcludedSlugs(state.activeSlug)];
    $("#excluded-count").textContent = `(${excluded.length})`;
    $("#excluded-list").replaceChildren(...excluded.map(buildExcludedItem));
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
    img.src = draft.preview_normal || draft.image_normal || "";
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
    const buttons = choices.map((choice) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dropdown-trigger";
      btn.dataset.varietySlug = choice.pokedex_slug;
      btn.textContent = choice.name;
      return btn;
    });
    box.replaceChildren(label, ...buttons);
    box.hidden = false;
  };

  const setAdderStatus = (prefix, message, kind = "") => {
    const el = $(`#${prefix}-status`);
    el.textContent = message;
    el.classList.toggle("error", kind === "error");
    el.classList.toggle("ok", kind === "ok");
  };

  const resetAdder = (prefix) => {
    state.adders[prefix] = null;
    $("#" + prefix + "-stage").disabled = true;
    renderVarietyPicker(prefix, null);
    renderPreview("#" + prefix + "-preview", null);
  };

  const selectAdderChoice = async (prefix, choice) => {
    if (!choice) return;
    const current = state.adders[prefix] || {};
    const inputDex = current.inputDex || $("#" + prefix + "-dex").value.trim();
    const choices = current.choices || [choice];
    $("#" + prefix + "-stage").disabled = true;
    renderPreview("#" + prefix + "-preview", null);
    $("#" + prefix + "-varieties").querySelectorAll("button[data-variety-slug]").forEach((btn) => {
      const active = btn.dataset.varietySlug === choice.pokedex_slug;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
    });

    const draft = { ...choice, inputDex, choices };
    const normalUrl = assetPokemonUrl(draft.dex, draft.pokedex_slug, false);
    const shinyUrl = assetPokemonUrl(draft.dex, draft.pokedex_slug, true);
    setAdderStatus(prefix, "Checking Dittobase sprite for " + draft.name + "...");
    const [normalOk, shinyOk] = await Promise.all([checkImage(normalUrl), checkImage(shinyUrl)]);
    draft.image_normal = normalOk ? normalUrl : "";
    draft.image_shiny = shinyOk ? shinyUrl : "";
    draft.shiny_available = shinyOk;
    draft.normalSource = normalOk ? normalUrl : "Not available on Dittobase";
    draft.preview_normal = normalOk ? normalUrl : "";
    state.adders[prefix] = draft;

    if (normalOk) {
      $("#" + prefix + "-stage").disabled = false;
      setAdderStatus(prefix, "Loaded " + draft.name + ". Dittobase sprite found: " + normalUrl, "ok");
      renderPreview("#" + prefix + "-preview", draft);
    } else {
      setAdderStatus(prefix, "Dittobase sprite is not available at " + normalUrl + "; can't add this pokemon.", "error");
      renderPreview("#" + prefix + "-preview", null);
    }
  };

  const lookupAdderPokemon = async (prefix) => {
    const input = $("#" + prefix + "-dex");
    const dex = input.value.trim();
    resetAdder(prefix);
    if (!dex) {
      setAdderStatus(prefix, "Enter a dex number, then press Enter or leave the field.");
      return;
    }
    if (!/^\d+$/.test(dex)) {
      setAdderStatus(prefix, "Dex must be a number.", "error");
      return;
    }
    setAdderStatus(prefix, "Looking up dex " + dex + "...");
    try {
      const choices = await pokemonChoicesFromPokeApi(dex);
      if (!choices.length) throw new Error("No pokemon varieties were returned for dex " + dex + ".");
      state.adders[prefix] = { inputDex: dex, choices };
      renderVarietyPicker(prefix, choices);
      if (choices.length > 1) {
        setAdderStatus(prefix, "Found " + choices.length + " forms. Choose the specific form to add.", "ok");
      } else {
        await selectAdderChoice(prefix, choices[0]);
      }
    } catch (err) {
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
    const addition = { ...additionForOverrides(draft), _normal_url: draft.image_normal, _shiny_url: draft.image_shiny || "" };
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
    const addition = { ...additionForOverrides(draft), _normal_url: draft.image_normal, _shiny_url: draft.image_shiny || "" };
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
    const bg = { slug, type: "custom", title, release_date: releaseDate, description, event: null, pokemon: state.customDraft.pokemon.map(additionForOverrides), _hero_file: state.customDraft.heroFile.name };
    state.pending.custom_backgrounds = state.pending.custom_backgrounds.filter((item) => item.slug !== slug);
    state.pending.custom_backgrounds.push(bg);
    status.textContent = `Staged ${slug}`;
    status.classList.remove("error");
    status.classList.add("ok");
    renderPending();
  };
  const renderPending = () => {
    const patchSlugs = Object.keys(state.pending.background_patches);
    const excludedCount = Object.values(state.pending.pokemon_exclusions).reduce((sum, list) => sum + list.length, 0);
    const restoredCount = Object.values(state.pending.pokemon_restores).reduce((sum, list) => sum + list.length, 0);
    const additionCount = Object.values(state.pending.pokemon_additions).reduce((sum, list) => sum + list.length, 0);
    const customCount = state.pending.custom_backgrounds.length;

    const parts = [];
    if (patchSlugs.length) parts.push(patchSlugs.length + " background patch" + (patchSlugs.length === 1 ? "" : "es"));
    if (excludedCount) parts.push(excludedCount + " pokemon excluded");
    if (restoredCount) parts.push(restoredCount + " pokemon restored");
    if (additionCount) parts.push(additionCount + " pokemon addition" + (additionCount === 1 ? "" : "s"));
    if (customCount) parts.push(customCount + " new custom background" + (customCount === 1 ? "" : "s"));
    const hasPending = parts.length > 0;
    $("#pending-summary").textContent = hasPending ? parts.join(", ") : "No pending changes";
    $("#pending-dot").hidden = !hasPending || !state.pendingCollapsed;
    $("#pending-panel").classList.toggle("collapsed", state.pendingCollapsed);
    $("#pending-toggle").setAttribute("aria-expanded", String(!state.pendingCollapsed));

    const items = [];
    for (const slug of patchSlugs) items.push(li("Patch: " + slug));
    for (const [slug, list] of Object.entries(state.pending.pokemon_exclusions)) for (const pSlug of list) items.push(li("Exclude: " + slug + "/" + pSlug));
    for (const [slug, list] of Object.entries(state.pending.pokemon_restores)) for (const pSlug of list) items.push(li("Restore: " + slug + "/" + pSlug));
    for (const [slug, list] of Object.entries(state.pending.pokemon_additions)) for (const p of list) items.push(li("Add: " + slug + "/" + p.pokedex_slug));
    for (const bg of state.pending.custom_backgrounds) items.push(li("Custom background: " + bg.slug));
    $("#pending-list").replaceChildren(...items);
  };

  const li = (text) => {
    const item = document.createElement("li");
    item.textContent = text;
    return item;
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
    $("#custom-back-to-grid").addEventListener("click", showGrid);
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
      if (slug) showDetail(slug).catch(showError);
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
    renderPending();
    renderGrid();

    const slug = decodeURIComponent(location.hash.replace(/^#/, ""));
    if (slug === "custom-new") showCustomForm();
    else if (slug) await showDetail(slug);
  };

  main().catch(showError);
})();
