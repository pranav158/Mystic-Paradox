import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface ModalProps {
  /** Short, shown as the dialog's heading and used as its accessible name. */
  title: string;
  /** Visual tone: a warning gets a red rule down its edge. */
  tone?: "default" | "danger";
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// [2026-10-14] The dialogs that are open, innermost last. Escape and Tab belong to the innermost one only, so a document
// opened from a dialog (the consent gate's Terms of Use) closes by itself and leaves the dialog under it open.
const openDialogs: symbol[] = [];

/**
 * A modal dialog on a dimmed scrim, in the launcher's glass style. Escape closes it and Tab stays inside it. It does
 * not close on a click outside: a dialog that asks for a decision needs an explicit answer. The scrim stops below
 * the title bar (z-index 100), so the window can still be dragged, minimised and closed.
 */
export function Modal({ title, tone = "default", onClose, children, footer }: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const tokenRef = useRef<symbol>(Symbol("dialog"));

  useEffect(() => {
    const dialog = dialogRef.current;
    const token = tokenRef.current;
    const previous = document.activeElement as HTMLElement | null;
    openDialogs.push(token);
    dialog?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (openDialogs[openDialogs.length - 1] !== token) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const index = openDialogs.indexOf(token);
      if (index >= 0) openDialogs.splice(index, 1);
      previous?.focus?.();
    };
  }, []);

  return createPortal(
    <div className="modal-scrim">
      <div
        ref={dialogRef}
        className="glass glass-strong modal"
        data-tone={tone}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h2 id={titleId} className="modal-title">{title}</h2>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
