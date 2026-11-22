const STORAGE_KEY = 'chinachu.player.captions.v1';

export function loadCaptionPreference() {
	try {
		return localStorage.getItem(STORAGE_KEY) !== 'false';
	} catch (_) {
		return true;
	}
}

export function saveCaptionPreference(enabled) {
	try {
		localStorage.setItem(STORAGE_KEY, String(enabled));
	} catch (_) {}
}
