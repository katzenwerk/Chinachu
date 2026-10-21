import { createHoverPopupController } from './hover-popup-controller.js';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function startOfDay(value) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addDays(value, days) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate() + days);
}

function dateValue(value) {
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function sameDate(a, b) {
  return a !== null && b !== null && dateValue(a) === dateValue(b);
}

export function createMonthCalendar(container, { onSelect }) {
  const today = startOfDay(new Date());
  let selected = null;
  let viewMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  container.innerHTML = `
    <div class="reserves-date-jump list-control-popup">
      <button class="reserves-date-jump-button list-control-popup-trigger" type="button" title="日付へジャンプ" aria-label="日付へジャンプ" aria-haspopup="dialog" aria-expanded="false">
        <svg class="icon" aria-hidden="true"><use href="#icon-calendar"></use></svg>
      </button>
      <div class="list-control-popup-panel month-calendar" role="dialog" aria-label="日付へジャンプ" hidden>
        <div class="month-calendar-header">
          <button type="button" class="month-calendar-nav is-prev" aria-label="前の月">‹</button>
          <strong></strong>
          <button type="button" class="month-calendar-nav is-next" aria-label="次の月">›</button>
        </div>
        <div class="month-calendar-weekdays" aria-hidden="true">${WEEKDAYS.map(day => `<span>${day}</span>`).join('')}</div>
        <div class="month-calendar-days" role="grid"></div>
      </div>
    </div>`;

  const root = container.querySelector('.reserves-date-jump');
  const trigger = root.querySelector('.reserves-date-jump-button');
  const panel = root.querySelector('.month-calendar');
  const heading = panel.querySelector('.month-calendar-header strong');
  const days = panel.querySelector('.month-calendar-days');
  let popup;

  function render() {
    const first = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
    const gridStart = addDays(first, -first.getDay());
    heading.textContent = `${viewMonth.getFullYear()}年 ${viewMonth.getMonth() + 1}月`;
    const buttons = [];
    for (let offset = 0; offset < 42; offset += 1) {
      const day = addDays(gridStart, offset);
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = String(day.getDate());
      button.dataset.date = dateValue(day);
      button.setAttribute('role', 'gridcell');
      button.setAttribute('aria-label', `${day.getFullYear()}年${day.getMonth() + 1}月${day.getDate()}日`);
      button.className = 'month-calendar-day';
      if (day.getMonth() !== viewMonth.getMonth()) button.classList.add('is-outside');
      if (sameDate(day, today)) button.classList.add('is-today');
      if (sameDate(day, selected)) {
        button.classList.add('is-selected');
        button.setAttribute('aria-selected', 'true');
      }
      buttons.push(button);
    }
    days.replaceChildren(...buttons);
  }

  function selectDay(value) {
    const parts = value.split('-').map(Number);
    selected = new Date(parts[0], parts[1] - 1, parts[2]);
    popup.close('selection');
    onSelect(value);
  }

  function moveMonth(amount) {
    viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + amount, 1);
    render();
  }

  function focusDate(value) {
    const target = days.querySelector(`[data-date="${dateValue(value)}"]`);
    target?.focus();
  }

  panel.querySelector('.is-prev').addEventListener('click', () => moveMonth(-1));
  panel.querySelector('.is-next').addEventListener('click', () => moveMonth(1));
  days.addEventListener('click', event => {
    const button = event.target.closest('.month-calendar-day');
    if (button) selectDay(button.dataset.date);
  });
  days.addEventListener('keydown', event => {
    const button = event.target.closest('.month-calendar-day');
    if (!button) return;
    const current = new Date(`${button.dataset.date}T12:00:00`);
    const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (Object.hasOwn(offsets, event.key)) {
      event.preventDefault();
      const next = addDays(current, offsets[event.key]);
      if (next.getMonth() !== viewMonth.getMonth()) {
        viewMonth = new Date(next.getFullYear(), next.getMonth(), 1);
        render();
      }
      focusDate(next);
    } else if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault();
      moveMonth(event.key === 'PageUp' ? -1 : 1);
      focusDate(new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1));
    }
  });

  popup = createHoverPopupController({ root, trigger, panel, onOpen: render });
  render();

  return {
    destroy() { popup.destroy(); }
  };
}
