export function confirmReservationWarning({ title, programTitle, message }) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'reservation-confirm-dialog';
    dialog.setAttribute('aria-label', title);
    dialog.innerHTML = '<form method="dialog"><h2></h2><p class="reservation-confirm-title"></p><p class="reservation-confirm-message"></p><footer><button class="button" value="cancel" autofocus>キャンセル</button><button class="button is-primary" value="reserve">このまま予約</button></footer></form>';
    dialog.querySelector('h2').textContent = title;
    dialog.querySelector('.reservation-confirm-title').textContent = programTitle;
    dialog.querySelector('.reservation-confirm-message').textContent = message;
    dialog.addEventListener('close', () => {
      const accepted = dialog.returnValue === 'reserve';
      dialog.remove();
      resolve(accepted);
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
  });
}
