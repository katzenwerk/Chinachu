import { viewportCssPixels } from '../services/ui-scale.js';
import { createChannelLogo } from './channel-logo.js';
import { programTitleParts } from '../services/timetable-model.js';

const targets = new WeakMap();
const logos = new Map();
let active = null;

function hoverDescription(program) {
  const tidy = value => value.split('\n').map(line => line.trim()).filter(Boolean).join('\n');
  const detail = typeof program.detail === 'string' ? program.detail.replace(/\r\n?/g, '\n').trim() : '';
  if (!detail) return tidy(String(program.description || '').replace(/\r\n?/g, '\n'));
  const headings = [...detail.matchAll(/^[ \t\u3000]*◇+[ \t\u3000]*(.*)$/gm)];
  const lead = tidy(detail.slice(0, headings[0]?.index ?? detail.length));
  if (lead) return lead;
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const name = heading[1].normalize('NFKC').replace(/[<>【】\[\]\s]/g, '');
    if (!/^(?:番組内容|番組概要|番組詳細|あらすじ|ストーリー|今回の番組内容)\d*$/.test(name)) continue;
    const body = tidy(detail.slice(heading.index + heading[0].length, headings[index + 1]?.index ?? detail.length));
    if (body) return body;
  }
  return '';
}

export function programHoverInfo(program, { channelLogoUrl = null, statuses = [] } = {}) {
  const channel = program.channel || {};
  const start = Number(program.start);
  const end = Number(program.end) || start + Number(program.seconds || 0) * 1000;
  return {
    title: [program.fullTitle, program.displayTitle, program.title].find(value => typeof value === 'string' && value.trim()) || 'タイトル未取得',
    channelName: program.channelName || channel.name || '放送局未取得',
    channelLogoUrl,
    start: Number.isFinite(start) && start > 0 ? start : null,
    end: Number.isFinite(end) && end > start ? end : null,
    description: hoverDescription(program),
    category: program.category || '',
    type: program.channelType || channel.type || '',
    statuses: statuses.map(value => typeof value === 'string' ? value : value?.label).filter(Boolean)
  };
}

function rememberLogo(image) {
  const url = image.getAttribute('src');
  if (!url || !image.complete || !image.naturalWidth || logos.has(url)) return;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(160, image.naturalWidth);
    canvas.height = Math.max(1, Math.round(image.naturalHeight * canvas.width / image.naturalWidth));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    logos.set(url, canvas.toDataURL());
  } catch { /* Keep the existing text fallback when a loaded image cannot be copied. */ }
}

export function setProgramHover(target, info) {
  target.dataset.programHover = '';
  target.setAttribute('title', ''); // Suppress inherited playback titles only over this information target.
  targets.set(target, info);
}

export function dismissProgramHover() {
  if (!active) return;
  const previous = active;
  active = null;
  window.clearTimeout(previous.timer);
  previous.preview?.remove();
  previous.logo?.dispose();
  previous.target.removeAttribute('aria-describedby');
  for (const type of ['scroll', 'pointerdown', 'click', 'contextmenu', 'resize', 'hashchange', 'popstate']) {
    window.removeEventListener(type, dismissProgramHover, true);
  }
  window.removeEventListener('keydown', onKey, true);
}

function onKey(event) {
  if (event.key === 'Escape') dismissProgramHover();
}

function showPreview(state) {
  if (active !== state) return;
  if (!state.target.isConnected) return dismissProgramHover();
  state.timer = null;
  const value = targets.get(state.target);
  const info = typeof value === 'function' ? value() : value;
  if (!info) return dismissProgramHover();
  state.root.querySelectorAll('.channel-logo-image').forEach(rememberLogo);
  const preview = document.createElement('aside');
  preview.className = 'program-hover';
  preview.id = 'program-hover';
  preview.setAttribute('role', 'tooltip');
  const header = document.createElement('header');
  const logo = createChannelLogo({ name: info.channelName, url: logos.get(info.channelLogoUrl) || null }, { variant: 'list' });
  logo.element.removeAttribute('title');
  const station = document.createElement('small');
  station.textContent = info.channelName;
  header.append(logo.element, station);
  if (info.type) {
    const type = document.createElement('span');
    type.className = 'program-hover-chip';
    type.textContent = info.type;
    header.append(type);
  }
  const title = document.createElement('strong');
  title.className = 'program-hover-title';
  for (const part of programTitleParts(info.title)) {
    if (!part.tone || part.tone === 'plain') title.append(document.createTextNode(part.text));
    else {
      const flag = document.createElement('span');
      flag.className = `program-hover-flag is-${part.tone}`;
      flag.textContent = part.text;
      title.append(flag);
    }
  }
  preview.append(header, title);
  if (info.start !== null) {
    const date = document.createElement('p');
    date.className = 'program-hover-date';
    const day = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' });
    const time = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    date.textContent = `${day.format(info.start)} ${time.format(info.start)}`;
    if (info.end !== null) {
      date.textContent += `〜${day.format(info.end) === day.format(info.start) ? '' : `${day.format(info.end)} `}${time.format(info.end)} · ${Math.round((info.end - info.start) / 60000)}分`;
    }
    preview.append(date);
  }
  if (info.description) {
    const description = document.createElement('div');
    description.className = 'program-hover-description';
    const content = document.createElement('p');
    content.className = 'program-hover-description-text';
    content.textContent = info.description;
    description.append(content);
    preview.append(description);
  }
  const labels = [...new Set([info.category, ...info.statuses].filter(Boolean))];
  if (labels.length) {
    const meta = document.createElement('div');
    meta.className = 'program-hover-meta';
    for (const label of labels) {
      const chip = document.createElement('span');
      chip.className = 'program-hover-chip';
      chip.textContent = label;
      meta.append(chip);
    }
    preview.append(meta);
  }
  document.body.append(preview);
  const bounds = preview.getBoundingClientRect();
  const margin = 12;
  const gap = 12;
  const right = state.x + gap;
  const left = state.x - gap - bounds.width;
  const below = state.y + gap;
  const above = state.y - gap - bounds.height;
  const fitsX = x => x >= margin && x + bounds.width <= window.innerWidth - margin;
  const fitsY = y => y >= margin && y + bounds.height <= window.innerHeight - margin;
  const preferred = [[right, below], [left, below], [right, above], [left, above]]
    .find(([x, y]) => fitsX(x) && fitsY(y));
  const x = preferred?.[0] ?? (fitsX(right) ? right : fitsX(left) ? left :
    window.innerWidth - state.x >= state.x ? right : left);
  const y = preferred?.[1] ?? (fitsY(below) ? below : fitsY(above) ? above :
    window.innerHeight - state.y >= state.y ? below : above);
  preview.style.left = viewportCssPixels(Math.max(margin, Math.min(x, window.innerWidth - bounds.width - margin)));
  preview.style.top = viewportCssPixels(Math.max(margin, Math.min(y, window.innerHeight - bounds.height - margin)));
  state.preview = preview;
  state.logo = logo;
  state.target.setAttribute('aria-describedby', preview.id);
}

export function createProgramHover(root) {
  const close = () => { if (active?.root === root) dismissProgramHover(); };
  const over = event => {
    if (event.pointerType !== 'mouse' || !window.matchMedia('(hover: hover)').matches) return;
    const target = event.target.closest?.('[data-program-hover]');
    if (!target || !root.contains(target) || !targets.has(target) || active?.target === target) return;
    dismissProgramHover();
    const state = { root, target, x: event.clientX, y: event.clientY, timer: null, preview: null, logo: null };
    active = state;
    state.timer = window.setTimeout(() => showPreview(state), 350);
    for (const type of ['scroll', 'pointerdown', 'click', 'contextmenu', 'resize', 'hashchange', 'popstate']) {
      window.addEventListener(type, dismissProgramHover, true);
    }
    window.addEventListener('keydown', onKey, true);
  };
  const out = event => {
    if (active?.root === root && active.target.contains(event.target) && !active.target.contains(event.relatedTarget)) close();
  };
  const load = event => { if (event.target.matches?.('.channel-logo-image')) rememberLogo(event.target); };
  root.addEventListener('pointerover', over);
  root.addEventListener('pointerout', out);
  root.addEventListener('load', load, true);
  return {
    close,
    dispose() {
      close();
      root.removeEventListener('pointerover', over);
      root.removeEventListener('pointerout', out);
      root.removeEventListener('load', load, true);
    }
  };
}
