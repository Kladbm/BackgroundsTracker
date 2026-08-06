// Ditto Tracker — shared localStorage module (spec section 5 & 6).
//
// Single key "collected", a JSON object:
//   { "<slug>": { "<dex>": { "normal": bool, "shiny": bool } } }
//
// dex is the national-dex number as a string. A pokemon counts as collected
// for the "X / Y" counter when its entry is `true` (legacy) or has
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

  // X in "X / Y" for a slug — number of dex entries marked collected.
  const collectedCount = (collected, slug) => {
    const entries = (collected && collected[slug]) || {};
    let n = 0;
    for (const v of Object.values(entries)) {
      if (v === true || (v && v.normal === true)) n++;
    }
    return n;
  };

  const isCollected = (collected, slug, dex) => {
    const e = collected && collected[slug] && collected[slug][dex];
    return e === true || (e && e.normal === true);
  };

  return { KEY, read, write, collectedCount, isCollected };
})();
