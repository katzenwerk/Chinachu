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

function validDate(value) {
  if (!(value instanceof Date) && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function pickerLabel(value, withTime) {
  const date = dateValue(value).replaceAll('-', '/');
  return withTime
    ? `${date} ${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`
    : date;
}

// mode: icon (the reservation-list popup), date (guide), datetime (timeline).
export function createMonthCalendar(container, { onSelect, mode = 'icon', value = null, minDate = null } = {}) {
  const today = startOfDay(new Date());
  const withTime = mode === 'datetime';
  const iconOnly = mode === 'icon';
  let currentValue = validDate(value);
  let minimum = validDate(minDate);
  let selected = currentValue ? startOfDay(currentValue) : null;
  const initialMonth = currentValue || today;
  let viewMonth = new Date(initialMonth.getFullYear(), initialMonth.getMonth(), 1);
  const title = iconOnly ? '日付へジャンプ' : withTime ? '表示開始日時を選択' : '日付を選択';

  container.innerHTML = `
    <div class="${iconOnly ? 'reserves-date-jump ' : ''}list-control-popup">
      <button class="${iconOnly ? 'reserves-date-jump-button ' : 'button '}list-control-popup-trigger" type="button" title="${title}" aria-label="${title}" aria-haspopup="dialog" aria-expanded="false">
        ${iconOnly ? '' : '<span class="month-calendar-trigger-text"></span>'}
        <svg class="icon${iconOnly ? '' : ' icon-small'}" aria-hidden="true"><use href="#icon-calendar"></use></svg>
      </button>
      <div class="list-control-popup-panel month-calendar" role="dialog" aria-label="${title}" hidden>
        <div class="month-calendar-header">
          <button type="button" class="month-calendar-nav is-prev" aria-label="前の月">‹</button>
          <strong></strong>
          <button type="button" class="month-calendar-nav is-next" aria-label="次の月">›</button>
        </div>
        <div class="month-calendar-weekdays" aria-hidden="true">${WEEKDAYS.map(day => `<span>${day}</span>`).join('')}</div>
        <div class="month-calendar-days" role="grid"></div>
      </div>
    </div>`;

  const root = container.querySelector('.list-control-popup');
  const trigger = root.querySelector('.list-control-popup-trigger');
  const panel = root.querySelector('.month-calendar');
  const heading = panel.querySelector('.month-calendar-header strong');
  const days = panel.querySelector('.month-calendar-days');
  let popup;
  let hourInput = null;
  let minuteInput = null;

  if (!iconOnly) {
    trigger.style.display = 'inline-flex';
    trigger.style.alignItems = 'center';
    trigger.style.justifyContent = 'space-between';
    trigger.style.gap = '8px';
    trigger.style.whiteSpace = 'nowrap';
    if (mode === 'date') trigger.style.minWidth = '142px';
    panel.style.whiteSpace = 'normal';
    panel.style.maxHeight = 'calc(100dvh - 115px)';
    panel.style.overflowY = 'auto';
  }

  if (withTime) {
    const timeRow = document.createElement('div');
    timeRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:10px;padding-top:10px;border-top:1px solid var(--border);font-size:12px;';
    const timeLabel = document.createElement('span');
    timeLabel.textContent = '時刻';
    timeLabel.style.marginRight = 'auto';
    const createSelect = (max, label) => {
      const input = document.createElement('select');
      input.setAttribute('aria-label', label);
      input.style.cssText = 'min-height:30px;padding:3px 5px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--panel);color:var(--text);font:inherit;';
      for (let number = 0; number <= max; number++) {
        const option = document.createElement('option');
        option.value = String(number);
        option.textContent = String(number).padStart(2, '0');
        input.append(option);
      }
      return input;
    };
    hourInput = createSelect(23, '時');
    minuteInput = createSelect(59, '分');
    const separator = document.createElement('span');
    separator.textContent = ':';
    timeRow.append(timeLabel, hourInput, separator, minuteInput);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;margin-top:10px;';
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'button primary';
    apply.textContent = 'この日時を表示';
    apply.addEventListener('click', () => {
      if (selected === null) return;
      const next = new Date(selected.getFullYear(), selected.getMonth(), selected.getDate(),
        Number(hourInput.value), Number(minuteInput.value));
      currentValue = next;
      updateTrigger();
      popup.close('selection');
      onSelect(next.getTime());
    });
    actions.append(apply);
    panel.append(timeRow, actions);
  }

  function updateTrigger() {
    if (iconOnly) return;
    const displayed = currentValue || today;
    const formatted = pickerLabel(displayed, withTime);
    trigger.querySelector('.month-calendar-trigger-text').textContent = formatted;
    trigger.setAttribute('aria-label', `${title}：${formatted}`);
  }

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
      if (minimum && day < startOfDay(minimum)) {
        button.disabled = true;
        button.style.cursor = 'not-allowed';
        button.style.opacity = '.35';
      }
      buttons.push(button);
    }
    days.replaceChildren(...buttons);
  }

  function selectDay(value) {
    const parts = value.split('-').map(Number);
    const next = new Date(parts[0], parts[1] - 1, parts[2]);
    if (minimum && next < startOfDay(minimum)) return;
    selected = next;
    if (withTime) {
      render();
      return;
    }
    currentValue = next;
    updateTrigger();
    popup.close('selection');
    onSelect(value);
  }

  function moveMonth(amount) {
    viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + amount, 1);
    render();
  }

  function focusDate(value) {
    const target = days.querySelector(`[data-date="${dateValue(value)}"]`);
    if (target && !target.disabled) target.focus();
  }

  panel.querySelector('.is-prev').addEventListener('click', () => moveMonth(-1));
  panel.querySelector('.is-next').addEventListener('click', () => moveMonth(1));
  days.addEventListener('click', event => {
    const button = event.target.closest('.month-calendar-day');
    if (button && !button.disabled) selectDay(button.dataset.date);
  });
  days.addEventListener('keydown', event => {
    const button = event.target.closest('.month-calendar-day');
    if (!button) return;
    const current = new Date(`${button.dataset.date}T12:00:00`);
    const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (Object.hasOwn(offsets, event.key)) {
      event.preventDefault();
      const next = addDays(current, offsets[event.key]);
      if (minimum && next < startOfDay(minimum)) return;
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

  popup = createHoverPopupController({
    root, trigger, panel, hover: iconOnly,
    onOpen: () => {
      if (!iconOnly) {
        selected = startOfDay(currentValue || today);
        viewMonth = new Date(selected.getFullYear(), selected.getMonth(), 1);
        if (withTime) {
          hourInput.value = String((currentValue || today).getHours());
          minuteInput.value = String((currentValue || today).getMinutes());
        }
      }
      render();
    }
  });
  updateTrigger();
  render();

  return {
    setValue(next) {
      currentValue = validDate(next);
      selected = currentValue ? startOfDay(currentValue) : null;
      if (currentValue) viewMonth = new Date(currentValue.getFullYear(), currentValue.getMonth(), 1);
      updateTrigger();
      if (popup.isOpen()) render();
    },
    setMinDate(next) {
      minimum = validDate(next);
      if (popup.isOpen()) render();
    },
    destroy() { popup.destroy(); }
  };
}
