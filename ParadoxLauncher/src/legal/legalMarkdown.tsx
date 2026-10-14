/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import type { MouseEvent, ReactNode } from "react";

// [2026-10-14] A small renderer for the subset the legal documents use: headings (#, ##, ###), paragraphs, bullet and
// numbered lists (an indented line continues the item above), **bold**, `code`, and plain http(s) links and email
// addresses. It builds React elements only. Every piece of text becomes a React text node, so nothing in the source
// is ever parsed as HTML, and a link can only be http, https or mailto.

export type LegalBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] };

interface ListState {
  ordered: boolean;
  start: number;
  items: string[];
}

export function parseLegalMarkdown(source: string): LegalBlock[] {
  const blocks: LegalBlock[] = [];
  const state: { paragraph: string[]; list: ListState | null } = { paragraph: [], list: null };

  const flushParagraph = () => {
    if (state.paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: state.paragraph.join(" ") });
      state.paragraph = [];
    }
  };
  const flushList = () => {
    if (state.list) {
      blocks.push({ kind: "list", ...state.list });
      state.list = null;
    }
  };

  for (const raw of source.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "heading", level: heading[1].length as 1 | 2 | 3, text: heading[2].trim() });
      continue;
    }
    const item = /^\s{0,3}(?:([-*])|(\d+)\.)\s+(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      const ordered = item[2] !== undefined;
      if (!state.list || state.list.ordered !== ordered) {
        flushList();
        state.list = { ordered, start: ordered ? Number(item[2]) : 1, items: [] };
      }
      state.list.items.push(item[3].trim());
      continue;
    }
    if (state.list && /^\s+\S/.test(line)) {
      const last = state.list.items.length - 1;
      state.list.items[last] = `${state.list.items[last]} ${line.trim()}`;
      continue;
    }
    flushList();
    state.paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return blocks;
}

const AUTOLINK = /(https?:\/\/[^\s<>()]*[^\s<>().,;:!?"'])|([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const EMPHASIS = /\*\*([^*]+)\*\*|`([^`]+)`/g;

function openHandler(href: string, openLink?: (href: string) => void) {
  // Opens in the system browser when the launcher provides a way; otherwise the anchor is a normal link.
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (!openLink) return;
    event.preventDefault();
    openLink(href);
  };
}

function linkify(text: string, key: string, openLink?: (href: string) => void): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(AUTOLINK)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(text.slice(last, index));
    const isUrl = match[1] !== undefined;
    const label = isUrl ? match[1] : match[2];
    const href = isUrl ? label : `mailto:${label}`;
    nodes.push(
      <a key={`${key}-l${index}`} href={href} target="_blank" rel="noopener noreferrer" onClick={openHandler(href, openLink)}>
        {label}
      </a>,
    );
    last = index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function inline(text: string, key: string, openLink?: (href: string) => void): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let count = 0;
  for (const match of text.matchAll(EMPHASIS)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(...linkify(text.slice(last, index), `${key}-t${count}`, openLink));
    if (match[1] !== undefined) {
      nodes.push(<strong key={`${key}-b${count}`}>{linkify(match[1], `${key}-b${count}`, openLink)}</strong>);
    } else {
      nodes.push(<code key={`${key}-c${count}`}>{match[2]}</code>);
    }
    last = index + match[0].length;
    count += 1;
  }
  if (last < text.length) nodes.push(...linkify(text.slice(last), `${key}-e`, openLink));
  return nodes;
}

/** The document as React elements. `openLink` opens a link in the system browser (the anchor is kept as the fallback). */
export function renderLegalMarkdown(source: string, openLink?: (href: string) => void): ReactNode[] {
  return parseLegalMarkdown(source).map((block, index) => {
    const key = `b${index}`;
    if (block.kind === "heading") {
      const Heading = block.level === 1 ? "h3" : block.level === 2 ? "h4" : "h5";
      const className = block.level === 1 ? "legal-doc-title" : "legal-doc-heading";
      return <Heading key={key} className={className}>{inline(block.text, key, openLink)}</Heading>;
    }
    if (block.kind === "paragraph") {
      return <p key={key}>{inline(block.text, key, openLink)}</p>;
    }
    const items = block.items.map((item, itemIndex) => (
      <li key={`${key}-i${itemIndex}`}>{inline(item, `${key}-i${itemIndex}`, openLink)}</li>
    ));
    return block.ordered
      ? <ol key={key} start={block.start} className="legal-doc-list">{items}</ol>
      : <ul key={key} className="legal-doc-list">{items}</ul>;
  });
}
