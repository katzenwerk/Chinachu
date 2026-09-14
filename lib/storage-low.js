'use strict';

function stopCurrentRecordings(recording, stopRecording) {
	recording.slice().forEach(program => stopRecording(program.id, 'LOW STORAGE'));
}

module.exports = {
	stopCurrentRecordings
};
