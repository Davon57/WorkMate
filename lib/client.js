window.__ModuleLoader__.load({
  id: "agent-console",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.ts
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");
var name = "agent-console";
var inject = ["slots"];
var open = false;
var listeners = /* @__PURE__ */ new Set();
function setOpen(next) {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}
function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function getOpenSnapshot() {
  return open;
}
function detectActiveWorkspaceName() {
  const elements = Array.from(document.querySelectorAll("button, [aria-current='page'], [aria-selected='true']"));
  const activeConversation = elements.find((element) => {
    if (!(element instanceof HTMLElement) || element.closest(".agent-console_overlay")) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.left < 320 && element.textContent?.trim() === "\u65B0\u4F1A\u8BDD";
  });
  let container = activeConversation?.parentElement;
  for (let depth = 0; container && depth < 6; depth += 1, container = container.parentElement) {
    const lines = (container.innerText ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const currentIndex = lines.indexOf("\u65B0\u4F1A\u8BDD");
    if (currentIndex > 0) {
      const candidate = lines[currentIndex - 1];
      if (candidate && candidate !== "WorkMate" && candidate.length <= 80) return candidate;
    }
  }
  return void 0;
}
function WorkMateFooterAction({ wide }) {
  return (0, import_react.createElement)(
    "button",
    {
      type: "button",
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "4px 8px",
        border: "0",
        borderRadius: "6px",
        background: "transparent",
        color: "var(--dsw-alias-label-secondary, #56606d)",
        cursor: "pointer",
        fontSize: "13px",
        lineHeight: "1.4"
      },
      title: "\u6253\u5F00 WorkMate",
      onClick: () => setOpen(true)
    },
    (0, import_react.createElement)("span", { "aria-hidden": true }, "\u{1F4CB}"),
    (0, import_react.createElement)("span", null, wide === false ? "WM" : "WorkMate")
  );
}
function WorkMateOverlay({ sessionId } = {}) {
  const isOpen = (0, import_react.useSyncExternalStore)(subscribe, getOpenSnapshot, getOpenSnapshot);
  const workspaceName = isOpen ? detectActiveWorkspaceName() : void 0;
  (0, import_react.useLayoutEffect)(() => {
    if (!isOpen || window.innerWidth <= 1100) return;
    const overlay = document.querySelector(".agent-console_overlay");
    if (!(overlay instanceof HTMLElement)) return;
    const previousVisibility = overlay.style.visibility;
    overlay.style.visibility = "hidden";
    const probe = document.elementFromPoint(window.innerWidth - 24, Math.round(window.innerHeight / 2));
    overlay.style.visibility = previousVisibility;
    let hostMain = probe instanceof HTMLElement ? probe.closest("main, [role='main']") : null;
    if (!(hostMain instanceof HTMLElement) || hostMain.contains(overlay)) {
      hostMain = null;
      let candidate = probe instanceof HTMLElement ? probe : null;
      while (candidate && candidate !== document.body) {
        const rect = candidate.getBoundingClientRect();
        if (!candidate.contains(overlay) && candidate.children.length > 0 && rect.right >= window.innerWidth - 2 && rect.width >= 400 && rect.height >= window.innerHeight * 0.75) {
          hostMain = candidate;
          break;
        }
        candidate = candidate.parentElement;
      }
    }
    if (!(hostMain instanceof HTMLElement)) return;
    const originalStyle = hostMain.getAttribute("style");
    hostMain.dataset.agentConsoleConversation = "true";
    hostMain.style.setProperty("position", "fixed", "important");
    hostMain.style.setProperty("inset", "0 0 0 auto", "important");
    hostMain.style.setProperty("width", window.innerWidth <= 1400 ? "360px" : "clamp(400px, 30vw, 560px)", "important");
    hostMain.style.setProperty("min-width", "0", "important");
    hostMain.style.setProperty("z-index", "89", "important");
    return () => {
      delete hostMain.dataset.agentConsoleConversation;
      if (originalStyle === null) hostMain.removeAttribute("style");
      else hostMain.setAttribute("style", originalStyle);
    };
  }, [isOpen]);
  if (!isOpen) return null;
  return (0, import_react.createElement)(
    "section",
    { className: "agent-console_overlay", role: "dialog", "aria-label": "WorkMate" },
    (0, import_react.createElement)(
      "header",
      { className: "agent-console_overlayHeader" },
      (0, import_react.createElement)("strong", null, "\u{1F4CB} WorkMate"),
      (0, import_react.createElement)(
        "button",
        { type: "button", className: "agent-console_close", onClick: () => setOpen(false), "aria-label": "\u5173\u95ED WorkMate" },
        "\xD7"
      )
    ),
    (0, import_react.createElement)("iframe", {
      className: "agent-console_frame",
      src: `/api/agent-console/ui/${(() => {
        const query = new URLSearchParams();
        if (sessionId) query.set("sessionId", sessionId);
        if (workspaceName) query.set("workspaceName", workspaceName);
        const value = query.toString();
        return value ? `?${value}` : "";
      })()}`,
      title: "WorkMate"
    })
  );
}
var styles = `
.agent-console_overlay { position: fixed; top: 0; bottom: 0; left: 280px; right: clamp(400px, 30vw, 560px); z-index: 90; display: flex; flex-direction: column; background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #202124); border-right: 1px solid var(--dsw-alias-border-l2, #e6e8eb); box-shadow: 8px 0 24px rgb(0 0 0 / 12%); }
.agent-console_overlayHeader { height: 48px; flex: 0 0 48px; display: flex; align-items: center; justify-content: space-between; padding: 0 16px; border-bottom: 1px solid var(--dsw-alias-border-l2, #e6e8eb); font-size: 14px; }
.agent-console_close { width: 30px; height: 30px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary, #56606d); cursor: pointer; font-size: 24px; line-height: 1; }
.agent-console_close:hover { background: var(--dsw-alias-interactive-bg-hover, #f1f3f5); color: var(--dsw-alias-label-primary, #202124); }
.agent-console_frame { width: 100%; min-height: 0; flex: 1; border: 0; background: var(--dsw-alias-bg-layer-1, #fff); }
@media (max-width: 1400px) { .agent-console_overlay { right: 360px; } }
@media (max-width: 1100px) { .agent-console_overlay { left: 56px; right: 0; } }
`;
function apply(ctx) {
  ctx.effect(() => {
    const style = document.createElement("style");
    style.setAttribute("data-dsh-plugin", name);
    style.textContent = styles;
    document.head.appendChild(style);
    return () => style.remove();
  }, "agent-console: styles");
  ctx.slots.inject("shell.overlay", () => ctx.slots.register({
    name: "shell.overlay",
    id: "agent-console-overlay",
    order: 110
  }, WorkMateOverlay));
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
    name: "sidebar.footer.action",
    id: "agent-console",
    order: 50
  }, WorkMateFooterAction));
}
    return module.exports;
  },
});
