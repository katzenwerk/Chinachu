'use strict';

const KEEP_RECORDED_OVER_MISSED = 'KEEP_RECORDED_STATUS: RECORDED over MISSED';

function compactKeepRecordedStatus(stdout) {
	const lines = String(stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
	let keepRecordedOverMissed = 0;

	return {
		lines: lines.filter(line => {
			if (line === KEEP_RECORDED_OVER_MISSED) {
				keepRecordedOverMissed++;
				return false;
			}

			return true;
		}),
		get keepRecordedOverMissed() {
			return keepRecordedOverMissed;
		}
	};
}

module.exports = {
	KEEP_RECORDED_OVER_MISSED,
	compactKeepRecordedStatus
};
