/**
 * WorkMate's Harness client entry.
 *
 * Registers a footer action button in the sidebar and a docked workbench in the shell.
 * On desktop the host conversation remains visible on the right, so WorkMate can
 * be used alongside the current project session instead of covering it.
 */

import { createElement, useLayoutEffect, useSyncExternalStore } from "react";

export const name = "agent-console";
export const inject = ["slots", "sessions"];

let open = false;
const listeners = new Set();

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
    return rect.width > 0 && rect.height > 0 && rect.left < 320 && element.textContent?.trim() === "新会话";
  });
  let container = activeConversation?.parentElement;
  for (let depth = 0; container && depth < 6; depth += 1, container = container.parentElement) {
    const lines = (container.innerText ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const currentIndex = lines.indexOf("新会话");
    if (currentIndex > 0) {
      const candidate = lines[currentIndex - 1];
      if (candidate && candidate !== "WorkMate" && candidate.length <= 80) return candidate;
    }
  }
  return undefined;
}

function WorkMateFooterAction({ wide }) {
  return createElement(
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
        lineHeight: "1.4",
      },
      title: "打开 WorkMate",
      onClick: () => setOpen(true),
    },
    createElement("span", { "aria-hidden": true }, "📋"),
    createElement("span", null, wide === false ? "WM" : "WorkMate"),
  );
}

function WorkMateOverlay({ sessionId } = {}) {
  const isOpen = useSyncExternalStore(subscribe, getOpenSnapshot, getOpenSnapshot);
  const workspaceName = isOpen ? detectActiveWorkspaceName() : undefined;

  useLayoutEffect(() => {
    if (!isOpen || window.innerWidth <= 1100) return;

    const overlay = document.querySelector(".agent-console_overlay");
    if (!(overlay instanceof HTMLElement)) return;

    // shell.overlay is a stable direct child of Harness AppFrame. Its sibling
    // order is sidebar | conversation | details | overlay. Dock the persistent
    // conversation column itself, not a session-specific descendant that gets
    // replaced whenever ctx.sessions.open() switches the active session.
    const overlayLayer = overlay.closest("[data-shell-overlay]");
    const frame = overlayLayer?.parentElement;
    const hostMain = frame?.children.item(1);
    if (!(hostMain instanceof HTMLElement)) return;
    const originalStyle = hostMain.getAttribute("style");
    hostMain.dataset.agentConsoleConversation = "true";
    hostMain.style.setProperty("position", "fixed", "important");
    hostMain.style.setProperty("inset", "0 0 0 auto", "important");
    hostMain.style.setProperty("width", window.innerWidth <= 1400 ? "360px" : "clamp(400px, 30vw, 560px)", "important");
    hostMain.style.setProperty("height", "100vh", "important");
    hostMain.style.setProperty("min-width", "0", "important");
    hostMain.style.setProperty("background", "var(--dsw-alias-bg-base, #fff)", "important");
    hostMain.style.setProperty("z-index", "89", "important");

    return () => {
      delete hostMain.dataset.agentConsoleConversation;
      if (originalStyle === null) hostMain.removeAttribute("style");
      else hostMain.setAttribute("style", originalStyle);
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return createElement(
    "section",
    { className: "agent-console_overlay", role: "dialog", "aria-label": "WorkMate" },
    createElement(
      "header",
      { className: "agent-console_overlayHeader" },
      createElement("strong", null, "📋 WorkMate"),
      createElement(
        "button",
        { type: "button", className: "agent-console_close", onClick: () => setOpen(false), "aria-label": "关闭 WorkMate" },
        "×",
      ),
    ),
    createElement("iframe", {
      className: "agent-console_frame",
      src: `/api/agent-console/ui/${(() => {
        const query = new URLSearchParams();
        if (sessionId) query.set("sessionId", sessionId);
        if (workspaceName) query.set("workspaceName", workspaceName);
        const value = query.toString();
        return value ? `?${value}` : "";
      })()}`,
      title: "WorkMate",
    }),
  );
}

const styles = `
.agent-console_overlay { position: fixed; top: 0; bottom: 0; left: 280px; right: clamp(400px, 30vw, 560px); z-index: 90; display: flex; flex-direction: column; background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #202124); border-right: 1px solid var(--dsw-alias-border-l2, #e6e8eb); box-shadow: 8px 0 24px rgb(0 0 0 / 12%); }
.agent-console_overlayHeader { height: 48px; flex: 0 0 48px; display: flex; align-items: center; justify-content: space-between; padding: 0 16px; border-bottom: 1px solid var(--dsw-alias-border-l2, #e6e8eb); font-size: 14px; }
.agent-console_close { width: 30px; height: 30px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary, #56606d); cursor: pointer; font-size: 24px; line-height: 1; }
.agent-console_close:hover { background: var(--dsw-alias-interactive-bg-hover, #f1f3f5); color: var(--dsw-alias-label-primary, #202124); }
.agent-console_frame { width: 100%; min-height: 0; flex: 1; border: 0; background: var(--dsw-alias-bg-layer-1, #fff); }
@media (max-width: 1400px) { .agent-console_overlay { right: 360px; } }
@media (max-width: 1100px) { .agent-console_overlay { left: 56px; right: 0; } }
`;

export function apply(ctx) {
  ctx.effect(() => {
    const style = document.createElement("style");
    style.setAttribute("data-dsh-plugin", name);
    style.textContent = styles;
    document.head.appendChild(style);
    return () => style.remove();
  }, "agent-console: styles");

  ctx.effect(() => {
    let disposed = false;
    const onMessage = async (event) => {
      if (event.origin !== window.location.origin || event.data?.type !== "workmate:open-session") return;
      const sessionId = event.data.sessionId;
      if (typeof sessionId !== "string" || !sessionId) return;
      for (let attempt = 0; attempt < 50 && !disposed; attempt += 1) {
        if (ctx.sessions.list.getSnapshot().byId[sessionId]) {
          ctx.sessions.open(sessionId);
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
      console.warn(`[WorkMate] Harness session did not appear in the client list: ${sessionId}`);
    };
    window.addEventListener("message", onMessage);
    return () => {
      disposed = true;
      window.removeEventListener("message", onMessage);
    };
  }, "agent-console: open analysis session");

  ctx.slots.inject("shell.overlay", () => ctx.slots.register({
    name: "shell.overlay",
    id: "agent-console-overlay",
    order: 110,
  }, WorkMateOverlay));

  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
    name: "sidebar.footer.action",
    id: "agent-console",
    order: 50,
  }, WorkMateFooterAction));
}
