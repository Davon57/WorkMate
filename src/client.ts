/**
 * WorkMate's Harness client entry.
 *
 * The worktable plugin owns the project rail. WorkMate contributes one project
 * card there and renders its own page in the Harness shell overlay.
 */

import { createElement, useSyncExternalStore } from "react";

export const name = "agent-console";
export const inject = ["slots"];

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

function WorkMateProject({ wide }) {
  return createElement(
    "button",
    {
      type: "button",
      className: "dsh-wt_layout agent-console_project",
      style: { order: 50, position: "relative" },
      title: "打开 WorkMate",
      onClick: () => setOpen(true),
    },
    createElement("span", { className: "dsh-wt_layoutIcon", "aria-hidden": true }, "📋"),
    createElement(
      "span",
      { className: "dsh-wt_layoutText" },
      createElement("span", { className: "dsh-wt_layoutName" }, wide === false ? "WM" : "WorkMate"),
    ),
    createElement("span", { className: "dsh-wt_layoutArrow", "aria-hidden": true }, "›"),
  );
}

function WorkMateOverlay() {
  const isOpen = useSyncExternalStore(subscribe, getOpenSnapshot, getOpenSnapshot);
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
      src: "/api/agent-console/ui/",
      title: "WorkMate",
    }),
  );
}

const styles = `
.agent-console_overlay { position: fixed; inset: 0 0 0 280px; z-index: 90; display: flex; flex-direction: column; background: #fff; color: #202124; box-shadow: -8px 0 24px rgb(0 0 0 / 12%); }
.agent-console_overlayHeader { height: 48px; flex: 0 0 48px; display: flex; align-items: center; justify-content: space-between; padding: 0 16px; border-bottom: 1px solid #e6e8eb; font-size: 14px; }
.agent-console_close { width: 30px; height: 30px; border: 0; border-radius: 6px; background: transparent; color: #56606d; cursor: pointer; font-size: 24px; line-height: 1; }
.agent-console_close:hover { background: #f1f3f5; color: #202124; }
.agent-console_frame { width: 100%; min-height: 0; flex: 1; border: 0; background: #fff; }
@media (max-width: 900px) { .agent-console_overlay { left: 56px; } }
`;

export function apply(ctx) {
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
    order: 110,
  }, WorkMateOverlay));

  ctx.slots.inject("sidebar.worktable.project", () => ctx.slots.register({
    name: "sidebar.worktable.project",
    id: "agent-console",
    order: 50,
  }, WorkMateProject));
}
