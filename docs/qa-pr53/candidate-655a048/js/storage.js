'use strict';
const BWStorage = (() => {
  const pageData = new Map();
  return {
    getItem(key) { key = String(key); return pageData.has(key) ? pageData.get(key) : null; },
    setItem(key, value) { pageData.set(String(key), String(value)); },
    removeItem(key) { pageData.delete(String(key)); },
    key(index) { return Array.from(pageData.keys())[index] ?? null; },
    get length() { return pageData.size; },
    clear() { pageData.clear(); },
  };
})();
window.BWStorage = BWStorage;
