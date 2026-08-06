// Ditto Tracker — shared localStorage module (spec section 5 & 6).
//
// Single key "collected", a JSON object:
//   { "<slug>": { "<pokedex_slug>": { "normal": bool, "shiny": bool } } }
//
// pokedex_slug is unique per form, so base and shadow forms do not collide.
// A pokemon counts as collected for the "X / Y" counter when its entry has
// `normal: true`. Both the homepage grid and the detail page use this module
// so their counters always agree.

'use strict';

const storage = (() => {
  const KEY = 'collected';

  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '{}');
    } catch (e) {
      return {};
    }
  };

  const write = (obj) => {
    localStorage.setItem(KEY, JSON.stringify(obj));
  };

  // X in "X / Y" for a slug — number of form-key entries marked collected.
  const collectedCount = (collected, slug, pokemon = []) =>
    pokemon.filter((p) => isCollected(collected, slug, p.pokedex_slug)).length;

  const isCollected = (collected, slug, pokedexSlug) => {
    const e = collected && collected[slug] && collected[slug][pokedexSlug];
    return !!(e && e.normal === true);
  };

  return { KEY, read, write, collectedCount, isCollected };
})();
