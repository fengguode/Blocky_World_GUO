/* Game save storage. QA builds can opt into fresh, page-local memory storage. */
const BWStorage = (() => {
  const memoryOnly = window.BW_QA_MEMORY_ONLY === true;
  const memory = new Map();
  const nativeStorage = () => window.localStorage;
  return {
    getItem(key) {
      key = String(key);
      return memoryOnly ? (memory.has(key) ? memory.get(key) : null) : nativeStorage().getItem(key);
    },
    setItem(key, value) {
      key = String(key);
      value = String(value);
      if (memoryOnly) memory.set(key, value);
      else nativeStorage().setItem(key, value);
    },
    removeItem(key) {
      key = String(key);
      if (memoryOnly) memory.delete(key);
      else nativeStorage().removeItem(key);
    },
    key(index) {
      return memoryOnly ? Array.from(memory.keys())[index] ?? null : nativeStorage().key(index);
    },
    get length() {
      return memoryOnly ? memory.size : nativeStorage().length;
    },
    clear() {
      if (memoryOnly) memory.clear();
      else nativeStorage().clear();
    },
  };
})();
window.BWStorage = BWStorage;
