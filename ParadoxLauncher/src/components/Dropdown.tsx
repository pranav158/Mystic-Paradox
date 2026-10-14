/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { CheckIcon, ChevronDownIcon } from "./icons";

// [2026-10-14] The launcher's dropdown, in its glass style, in place of native selects. It follows the WAI-ARIA
// select-only combobox pattern: focus stays on the closed control (role="combobox"), and aria-activedescendant names the
// highlighted row while the arrows move. The list (role="listbox") is a portal on the body, so no card that clips its
// overflow can cut it off. It opens below the control, or above when there is no room below.

export type DropdownTone = "official" | "realm" | "local";

export interface DropdownOption {
  value: string;
  /** The main line. */
  label: string;
  /** A smaller second line, for example a realm's own name when the player named it differently. */
  detail?: string | null;
  /** A small tag after the label, in the tone's colours ("local" is the local-server red). */
  tag?: { text: string; tone: DropdownTone };
}

/** A row under the options that does something instead of choosing, for example "Add a server...". */
export interface DropdownAction {
  value: string;
  label: string;
}

export interface DropdownProps {
  /** The closed control's id. The list's id is derived from it. */
  id?: string;
  /** The id of the visible label that names the control. */
  labelledBy?: string;
  /** The accessible name, when there is no visible label to point at. */
  label?: string;
  /** The chosen option's value, or null while none is chosen. */
  value: string | null;
  options: DropdownOption[];
  /** Rows under the options (the listbox's last rows) that run `onAction` instead of choosing. */
  actions?: DropdownAction[];
  /** Shown while no option is chosen. */
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** An option was chosen. Not called when the option already chosen is picked again. */
  onChange: (value: string) => void;
  /** An action row was chosen. */
  onAction?: (value: string) => void;
}

type Item =
  | { kind: "option"; value: string; option: DropdownOption }
  | { kind: "action"; value: string; action: DropdownAction };

interface Placement {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
  up: boolean;
}

const MENU_MAX_HEIGHT = 320;
const GAP = 6;
const EDGE = 10;
const TYPE_AHEAD_MS = 600;

/**
 * Where the list goes. It sits below the control when it fits there, or when there is more room below than above;
 * otherwise above. Its height is capped by the room on the side it takes, so it never runs off the window.
 */
function placeMenu(trigger: DOMRect, menuHeight: number, viewportHeight: number, viewportWidth: number): Placement {
  const below = viewportHeight - trigger.bottom - GAP - EDGE;
  const above = trigger.top - GAP - EDGE;
  const up = Math.min(menuHeight, MENU_MAX_HEIGHT) > below && above > below;
  const room = Math.max(0, up ? above : below);
  const width = Math.min(trigger.width, viewportWidth - 2 * EDGE);
  const left = Math.min(Math.max(trigger.left, EDGE), viewportWidth - EDGE - width);
  const maxHeight = Math.min(MENU_MAX_HEIGHT, room);
  return up
    ? { left, width, bottom: viewportHeight - trigger.top + GAP, maxHeight, up }
    : { left, width, top: trigger.bottom + GAP, maxHeight, up };
}

function OptionLabel({ option }: { option: DropdownOption }) {
  const title = option.detail ? `${option.label} (${option.detail})` : option.label;
  return (
    <>
      <span className="dropdown-text" title={title}>
        <span className="dropdown-main">{option.label}</span>
        {option.detail ? <span className="dropdown-detail">{option.detail}</span> : null}
      </span>
      {option.tag ? <span className={`dropdown-tag tone-${option.tag.tone}`}>{option.tag.text}</span> : null}
    </>
  );
}

// A letter, digit or symbol that starts a type-ahead search (the space bar opens and chooses instead).
function isTypeKey(event: ReactKeyboardEvent): boolean {
  return event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey;
}

/**
 * A select-only dropdown. Keyboard: Enter, Space, ArrowDown or ArrowUp open it on the chosen row; the arrows, Home and End
 * move; Enter or Space chooses; Escape or Tab closes it without choosing; a letter jumps to the next option that starts
 * with what was typed (on the closed control it chooses that option, as a native select does). A click outside, or the
 * window losing focus, closes it.
 */
export function Dropdown({
  id,
  labelledBy,
  label,
  value,
  options,
  actions = [],
  placeholder = "Choose",
  disabled = false,
  className,
  onChange,
  onAction,
}: DropdownProps) {
  const generatedId = useId();
  const baseId = id ?? generatedId;
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number) => `${baseId}-option-${index}`;
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const typedRef = useRef({ text: "", at: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [placement, setPlacement] = useState<Placement | null>(null);

  const items: Item[] = [
    ...options.map((option): Item => ({ kind: "option", value: option.value, option })),
    ...actions.map((action): Item => ({ kind: "action", value: action.value, action })),
  ];
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : null;
  const lastIndex = items.length - 1;

  const measure = () => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    setPlacement(placeMenu(trigger.getBoundingClientRect(), menu.scrollHeight, window.innerHeight, window.innerWidth));
  };

  // Placed before paint, so the list never shows in the wrong place. Measured again when its rows change.
  useLayoutEffect(() => {
    if (open) measure();
  }, [open, items.length]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: Event) => {
      const target = event.target as Node | null;
      if (target && (triggerRef.current?.contains(target) || menuRef.current?.contains(target))) return;
      setOpen(false);
    };
    const onWindowBlur = () => setOpen(false);
    const onReposition = (event: Event) => {
      // The list's own scrolling does not move the control.
      const target = event.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;
      measure();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
    // `measure` reads only refs and sets state, so the listeners of the render that opened the list are the right ones.
  }, [open]);

  useEffect(() => {
    if (!open || active < 0) return;
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  const openList = () => {
    if (disabled) return;
    setActive(selectedIndex >= 0 ? selectedIndex : items.length > 0 ? 0 : -1);
    setOpen(true);
  };

  const choose = (index: number) => {
    const item = items[index];
    setOpen(false);
    triggerRef.current?.focus();
    if (!item) return;
    if (item.kind === "action") {
      onAction?.(item.value);
    } else if (item.value !== value) {
      onChange(item.value);
    }
  };

  // The next option (from `from`, wrapping) whose label starts with the letters typed so far. One letter moves on to the
  // next match, so pressing the same letter again cycles; a longer search stays on the match it already has.
  const typeAhead = (char: string, from: number): number => {
    const now = Date.now();
    const typed = typedRef.current;
    const next = (now - typed.at > TYPE_AHEAD_MS ? "" : typed.text) + char.toLowerCase();
    typed.at = now;
    // The same letter again (aa, aaa) is one letter pressed again: it cycles through the matches of that letter.
    const repeated = next.length > 1 && next.split("").every((letter) => letter === next[0]);
    typed.text = repeated ? next[0] : next;
    const start = typed.text.length > 1 ? Math.max(from, 0) : from + 1;
    for (let step = 0; step < items.length; step++) {
      const index = (((start + step) % items.length) + items.length) % items.length;
      const item = items[index];
      if (item.kind === "option" && item.option.label.toLowerCase().startsWith(typed.text)) return index;
    }
    return -1;
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (!open) {
      if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        openList();
      } else if (isTypeKey(event)) {
        const item = items[typeAhead(event.key, selectedIndex)];
        if (item?.kind === "option" && item.value !== value) onChange(item.value);
      }
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive(Math.min(active + 1, lastIndex));
        return;
      case "ArrowUp":
        event.preventDefault();
        setActive(Math.max(active - 1, 0));
        return;
      case "Home":
        event.preventDefault();
        setActive(0);
        return;
      case "End":
        event.preventDefault();
        setActive(lastIndex);
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        choose(active);
        return;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        return;
      case "Tab":
        setOpen(false);
        return;
      default:
        if (isTypeKey(event)) {
          const index = typeAhead(event.key, active);
          if (index >= 0) setActive(index);
        }
    }
  };

  const onTriggerClick = () => {
    if (disabled) return;
    if (open) setOpen(false);
    else openList();
  };

  const onTriggerBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && menuRef.current?.contains(next)) return;
    setOpen(false);
  };

  const menuStyle: CSSProperties = placement
    ? { left: placement.left, width: placement.width, top: placement.top, bottom: placement.bottom, maxHeight: placement.maxHeight }
    : { left: 0, top: 0, visibility: "hidden" };

  const menu = (
    <div
      ref={menuRef}
      id={listboxId}
      role="listbox"
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      className="dropdown-menu"
      data-placement={placement?.up ? "up" : "down"}
      style={menuStyle}
      onMouseDown={(event) => event.preventDefault()}
    >
      {items.map((item, index) => {
        const chosen = item.kind === "option" && item.value === value;
        return (
          <div
            key={`${item.kind}:${item.value}`}
            id={optionId(index)}
            role="option"
            aria-selected={chosen}
            data-active={index === active}
            data-value={item.value}
            className={["dropdown-option", item.kind === "action" ? "is-action" : "", chosen ? "is-selected" : ""]
              .filter(Boolean)
              .join(" ")}
            onMouseMove={() => {
              if (index !== active) setActive(index);
            }}
            onClick={() => choose(index)}
          >
            {item.kind === "option"
              ? <OptionLabel option={item.option} />
              : <span className="dropdown-action-label">{item.action.label}</span>}
            {chosen && <CheckIcon className="dropdown-check" />}
          </div>
        );
      })}
    </div>
  );

  return (
    <>
      <div
        ref={triggerRef}
        id={baseId}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : label}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : 0}
        className={["dropdown", open ? "is-open" : "", disabled ? "is-disabled" : "", className ?? ""]
          .filter(Boolean)
          .join(" ")}
        onClick={onTriggerClick}
        onKeyDown={onKeyDown}
        onBlur={onTriggerBlur}
      >
        <span className="dropdown-value">
          {selectedOption ? <OptionLabel option={selectedOption} /> : <span className="dropdown-placeholder">{placeholder}</span>}
        </span>
        <ChevronDownIcon className="dropdown-chevron" />
      </div>
      {open && createPortal(menu, document.body)}
    </>
  );
}
