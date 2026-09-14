/**
 * content-bridge.js
 * Roda no mundo ISOLADO (padrão) da aba do Icarus.
 * Ponte entre:
 *   - inject.js (mundo principal da página, via window.postMessage)
 *   - background.js (service worker da extensão, via chrome.runtime)
 */

const MSG_NS = "__pontoIcarusExt__";

const PAGE_TO_EXT_TYPES = ["OBSERVED_RESPONSE", "UI_ACTION_RESULT"];
const EXT_TO_PAGE_TYPES = ["UI_ACTION"];

// página (inject.js) -> extensão (background/sidepanel)
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.source !== MSG_NS) return;
  if (PAGE_TO_EXT_TYPES.includes(msg.type)) {
    try {
      chrome.runtime.sendMessage({ source: MSG_NS, ...msg }).catch(() => {});
    } catch (e) {
      console.warn("[PontoIcarusExt] bridge: contexto da extensão inválido (recarregue esta aba)", e);
    }
  }
});

// extensão (sidepanel via background) -> página (inject.js)
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.source !== MSG_NS) return;
  if (EXT_TO_PAGE_TYPES.includes(msg.type)) {
    window.postMessage(msg, "*");
  }
});
