// Stroke icons on a 24px grid, built as DOM nodes (the CSP allows no inline markup tricks).
const PATHS = {
  sidebar: ['M4 5h16v14H4z', 'M9.5 5v14'],
  compose: ['M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6', 'M17.5 3.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4-4'],
  settings: ['M4 7h9', 'M17 7h3', 'M15 5v4', 'M4 17h3', 'M11 17h9', 'M9 15v4'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  slash: ['M15 4L9 20'],
  share: ['M4 13v6a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6', 'M16 7l-4-4-4 4', 'M12 3v12'],
  gauge: ['M4 17a8 8 0 1 1 16 0', 'M12 17l4-5'],
  theme: ['M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z'],
  logout: ['M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3', 'M10 17l-5-5 5-5', 'M5 12h11'],
  'chevron-down': ['M6 9l6 6 6-6'],
  'chevron-left': ['M15 6l-6 6 6 6'],
  'chevron-right': ['M9 6l6 6-6 6'],
  'chevron-up': ['M6 15l6-6 6 6'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  plus: ['M12 5v14', 'M5 12h14'],
  'arrow-up': ['M12 19V5', 'M6 11l6-6 6 6'],
  'arrow-down': ['M12 5v14', 'M6 13l6 6 6-6'],
  stop: ['M8 8h8v8H8z'],
  copy: ['M9 9h10v11H9z', 'M5 15V5a1 1 0 0 1 1-1h9'],
  check: ['M5 12.5l4.5 4.5L19 7'],
  edit: ['M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z', 'M13.5 6.5l4 4'],
  refresh: ['M20 11a8 8 0 0 0-14.6-4.5L4 8', 'M4 4v4h4', 'M4 13a8 8 0 0 0 14.6 4.5L20 16', 'M20 20v-4h-4'],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12', 'M9 7V4h6v3'],
  pencil: ['M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z'],
  x: ['M6 6l12 12', 'M18 6L6 18'],
  file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5'],
  globe: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M3 12h18', 'M12 3a14 14 0 0 1 0 18', 'M12 3a14 14 0 0 0 0 18'],
  tool: ['M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 0 5.4-5.4l-2.4 2.4-2.6-.4-.4-2.6z'],
  shield: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'],
  hand: ['M8 13V5.5a1.5 1.5 0 0 1 3 0V12', 'M11 11.5v-7a1.5 1.5 0 0 1 3 0V12', 'M14 11.5V6.5a1.5 1.5 0 0 1 3 0V14', 'M17 9.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-2a6 6 0 0 1-5-2.7L4.3 14a1.5 1.5 0 0 1 2.4-1.8L8 14'],
  expand: ['M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5'],
  collapse: ['M9 4v5H4', 'M15 4v5h5', 'M9 20v-5H4', 'M15 20v-5h5'],
  power: ['M12 3v8', 'M6.3 6.3a8 8 0 1 0 11.4 0'],
  back: ['M19 12H5', 'M11 6l-6 6 6 6'],
  alert: ['M12 3l9.5 17h-19z', 'M12 10v4', 'M12 17h.01'],
};

const NS = 'http://www.w3.org/2000/svg';

export function icon(name, size = 20) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('ico');
  for (const d of PATHS[name] || []) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

/** Fills every [data-icon] / [data-icon-lead] placeholder in the static markup. */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (!el.querySelector(':scope > svg')) el.prepend(icon(el.dataset.icon));
  }
  for (const el of root.querySelectorAll('[data-icon-lead]')) {
    if (!el.querySelector(':scope > svg')) el.prepend(icon(el.dataset.iconLead, 18));
  }
}
